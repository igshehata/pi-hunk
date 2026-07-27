import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { Component, Focusable, KeyId, TUI } from "@earendil-works/pi-tui";
import { toPtyInput, translateMouseInput, type MouseViewport } from "./input.ts";
import { type OverlayPty, type PtySubscription, spawnOverlayPty } from "./pty.ts";
import type { HunkExit } from "./embedded.ts";

// Mirror Hunk's mouse reporting onto Pi's real terminal while takeover owns focus.
const ENABLE_MOUSE = "\x1b[?1003h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
// Best-effort restore when leaving takeover so Pi's next full paint is not dirty.
const RESTORE_TERMINAL = "\x1b[0m\x1b]8;;\x07\x1b[?2026l\x1b[?6l\x1b[?7h\x1b[?25h" + DISABLE_MOUSE;
const DEFAULT_STARTUP_FRAME_DEADLINE_MS = 12_000;
const STARTUP_TIMEOUT_EXIT_CODE = 124;

type LifecycleState = "running" | "completed" | "disposed";
type PresentationState = "active" | "suspended";

export interface TakeoverOptions {
  command: string;
  args: string[];
  cwd: string;
  tui: TUI;
  done: (result: HunkExit) => void;
  startupFrameDeadlineMs?: number;
  prefixKey?: KeyId;
  toggleKey?: KeyId;
  onToggleRequest?: () => void;
  showKey?: KeyId;
  onShowRequest?: () => void;
  /**
   * Optional mouse viewport; takeover is full-screen so this defaults to the
   * physical terminal origin.
   */
  resolveMouseViewport?: (
    terminalColumns: number,
    terminalRows: number,
    overlayColumns: number,
    overlayRows: number,
  ) => MouseViewport;
}

interface TuiPaintRuntime {
  requestRender: TUI["requestRender"];
  stopped?: boolean;
  renderRequested?: boolean;
  renderTimer?: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Same-tab takeover: Hunk owns the real TTY while Pi's paint loop is suspended.
 *
 * Unlike the embed path, there is no libghostty / formatHtml / Pi overlay composite.
 * Child PTY bytes are written straight to the terminal. Leaving takeover restores
 * Pi with a forced full redraw.
 *
 * Experimental: pokes TUI internals (requestRender no-op) and assumes exclusive
 * ownership of the screen while active.
 */
export class TakeoverHunk implements Component, Focusable {
  private readonly tui: TUI;
  private readonly pty: OverlayPty;
  private readonly subscriptions: PtySubscription[] = [];
  private readonly done: (result: HunkExit) => void;
  private readonly prefixKey?: KeyId;
  private readonly toggleKey?: KeyId;
  private readonly onToggleRequest?: () => void;
  private readonly showKey?: KeyId;
  private readonly onShowRequest?: () => void;
  private readonly resolveMouseViewport?: TakeoverOptions["resolveMouseViewport"];
  private readonly startupFrameDeadlineMs: number;
  private readonly runtime: TuiPaintRuntime;
  private readonly originalRequestRender: TUI["requestRender"];

  private lifecycle: LifecycleState = "running";
  private presentation: PresentationState = "active";
  private prefixPending = false;
  private mouseEnabled = false;
  private generation = 0;
  private columns: number;
  private rows: number;
  private sawOutput = false;
  private startupDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private removeInputListener: (() => void) | undefined;
  private paintSuspended = false;

  get pid(): number | undefined {
    return this.pty.pid;
  }

  get focused(): boolean {
    return this.presentation === "active" && this.lifecycle === "running";
  }

  set focused(value: boolean) {
    // Takeover always wants focus while active; blur means suspend to Pi.
    if (value) this.setVisible(true);
    else this.setVisible(false);
  }

  constructor(options: TakeoverOptions) {
    this.tui = options.tui;
    this.done = options.done;
    this.prefixKey = options.prefixKey;
    this.toggleKey = options.toggleKey;
    this.onToggleRequest = options.onToggleRequest;
    this.showKey = options.showKey;
    this.onShowRequest = options.onShowRequest;
    this.resolveMouseViewport = options.resolveMouseViewport;
    this.startupFrameDeadlineMs = Math.max(
      0,
      options.startupFrameDeadlineMs ?? DEFAULT_STARTUP_FRAME_DEADLINE_MS,
    );

    this.columns = Math.max(1, options.tui.terminal.columns);
    this.rows = Math.max(1, options.tui.terminal.rows);
    this.runtime = options.tui as unknown as TuiPaintRuntime;
    this.originalRequestRender = this.runtime.requestRender.bind(options.tui);

    this.pty = spawnOverlayPty({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      columns: this.columns,
      rows: this.rows,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        TERM_PROGRAM: "pi-hunk-takeover",
        FORCE_COLOR: "3",
      } as Record<string, string>,
    });

    const gen = this.generation;
    this.subscriptions.push(
      this.pty.onData((data) => {
        if (this.lifecycle !== "running" || gen !== this.generation) return;
        this.sawOutput = true;
        this.clearStartupDeadline();
        if (this.presentation !== "active") return;
        this.writeRaw(data);
      }),
      this.pty.onExit((event) => {
        if (this.lifecycle !== "running" || gen !== this.generation) return;
        this.complete(event);
      }),
    );

    // Intercept input at the TUI listener level so nothing else consumes keys
    // while takeover is active (including Pi's editor). Unit harnesses may omit
    // addInputListener; fall back to Component.handleInput only.
    const addInputListener = (
      this.tui as TUI & {
        addInputListener?: (
          listener: (data: string) => { consume?: boolean } | undefined,
        ) => () => void;
      }
    ).addInputListener;
    if (typeof addInputListener === "function") {
      this.removeInputListener = addInputListener.call(this.tui, (data) => {
        if (this.lifecycle !== "running" || this.presentation !== "active") {
          return undefined;
        }
        this.handleInput(data);
        return { consume: true };
      });
    }

    this.enterTakeover();
    this.armStartupDeadline();
  }

  /**
   * Surface visibility. Hidden takeover suspends VT writes and restores Pi paint;
   * show re-enters takeover (Hunk may need a user refresh if it does not repaint).
   */
  setVisible(visible: boolean): void {
    if (this.lifecycle !== "running") return;
    if (visible && this.presentation === "suspended") {
      this.presentation = "active";
      this.enterTakeover();
      // Nudge Hunk to redraw after a temporary suspend.
      try {
        this.pty.resize(this.columns, this.rows);
      } catch {
        // Child may have exited.
      }
      return;
    }
    if (!visible && this.presentation === "active") {
      this.presentation = "suspended";
      this.leaveTakeover({ restorePi: true });
    }
  }

  isVisible(): boolean {
    return this.presentation === "active";
  }

  handleInput(data: string): void {
    if (this.lifecycle !== "running" || this.presentation !== "active") return;

    if (!isKeyRelease(data) && this.prefixKey && matchesKey(data, this.prefixKey)) {
      this.prefixPending = true;
      return;
    }
    if (!isKeyRelease(data) && this.prefixPending) {
      this.prefixPending = false;
      if (this.toggleKey && matchesKey(data, this.toggleKey)) {
        this.onToggleRequest?.();
        return;
      }
      if (this.showKey && matchesKey(data, this.showKey)) {
        this.onShowRequest?.();
        return;
      }
      // Unknown suffix cancels the chord; do not forward to Hunk.
      return;
    }

    let translated = toPtyInput(data);
    if (translated && this.resolveMouseViewport) {
      const viewport = this.resolveMouseViewport(
        this.tui.terminal.columns,
        this.tui.terminal.rows,
        this.columns,
        this.rows,
      );
      translated = translateMouseInput(translated, viewport);
    } else if (translated) {
      // Full-screen origin: still run through mouse translator with terminal bounds.
      translated = translateMouseInput(translated, {
        column: 0,
        row: 0,
        width: this.columns,
        height: this.rows,
      });
    }
    if (translated) this.pty.write(translated);
  }

  /**
   * Pi may still call render during mount transitions. Return empty lines so any
   * accidental composite is cheap; real content is on the TTY via passthrough.
   */
  render(_width: number): string[] {
    // Keep PTY size in sync if the terminal resized while Pi was suspended.
    const cols = Math.max(1, this.tui.terminal.columns);
    const rows = Math.max(1, this.tui.terminal.rows);
    if (cols !== this.columns || rows !== this.rows) {
      this.columns = cols;
      this.rows = rows;
      try {
        this.pty.resize(cols, rows);
      } catch {
        // ignore
      }
    }
    return [];
  }

  invalidate(): void {
    // No Pi-side buffer; Hunk owns the screen while active.
  }

  dispose(): void {
    if (this.lifecycle === "disposed") return;
    this.lifecycle = "disposed";
    this.generation += 1;
    this.clearStartupDeadline();
    this.leaveTakeover({ restorePi: true });
    try {
      this.removeInputListener?.();
    } catch {
      // ignore
    }
    this.removeInputListener = undefined;
    for (const subscription of this.subscriptions) {
      try {
        subscription.dispose();
      } catch {
        // ignore
      }
    }
    this.subscriptions.length = 0;
    try {
      this.pty.dispose();
    } catch {
      // ignore
    }
  }

  private enterTakeover(): void {
    this.suspendPiPaint();
    this.setMouseEnabled(true);
    // Clear screen so Hunk's alternate buffer / first paint is not mixed with Pi.
    this.writeRaw("\x1b[?1049h\x1b[2J\x1b[H");
    if (!this.sawOutput) {
      this.writeRaw("Starting Hunk (takeover)…\r\n");
    }
  }

  private leaveTakeover(options: { restorePi: boolean }): void {
    this.setMouseEnabled(false);
    this.prefixPending = false;
    try {
      this.writeRaw("\x1b[?1049l");
      this.writeRaw(RESTORE_TERMINAL);
    } catch {
      // Terminal may be gone.
    }
    this.resumePiPaint(options.restorePi);
  }

  private suspendPiPaint(): void {
    if (this.paintSuspended) return;
    this.paintSuspended = true;
    // Drop any pending Pi frame and make requestRender a no-op while Hunk owns TTY.
    if (this.runtime.renderTimer) {
      clearTimeout(this.runtime.renderTimer);
      this.runtime.renderTimer = undefined;
    }
    this.runtime.renderRequested = false;
    this.runtime.requestRender = (() => {
      // no-op while takeover is active
    }) as TUI["requestRender"];
  }

  private resumePiPaint(forceRedraw: boolean): void {
    if (!this.paintSuspended) {
      if (forceRedraw) {
        try {
          this.originalRequestRender(true);
        } catch {
          // ignore
        }
      }
      return;
    }
    this.paintSuspended = false;
    this.runtime.requestRender = this.originalRequestRender;
    if (forceRedraw) {
      try {
        this.originalRequestRender(true);
      } catch {
        // ignore
      }
    }
  }

  private writeRaw(data: string | Uint8Array): void {
    const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    try {
      this.tui.terminal.write(text);
    } catch {
      // ignore write failures during teardown
    }
  }

  private setMouseEnabled(enabled: boolean): void {
    if (enabled === this.mouseEnabled) return;
    this.mouseEnabled = enabled;
    try {
      this.tui.terminal.write(enabled ? ENABLE_MOUSE : DISABLE_MOUSE);
    } catch {
      // ignore
    }
  }

  private armStartupDeadline(): void {
    if (this.startupFrameDeadlineMs <= 0) return;
    this.clearStartupDeadline();
    this.startupDeadlineTimer = setTimeout(() => {
      this.startupDeadlineTimer = undefined;
      if (this.lifecycle !== "running" || this.sawOutput) return;
      this.complete(
        {
          exitCode: STARTUP_TIMEOUT_EXIT_CODE,
          signal: 0,
          detail: `Hunk takeover failed: no PTY output within ${this.startupFrameDeadlineMs}ms.`,
        },
        { disposePty: true },
      );
    }, this.startupFrameDeadlineMs);
    this.startupDeadlineTimer.unref?.();
  }

  private clearStartupDeadline(): void {
    if (!this.startupDeadlineTimer) return;
    clearTimeout(this.startupDeadlineTimer);
    this.startupDeadlineTimer = undefined;
  }

  private complete(result: HunkExit, options: { disposePty?: boolean } = {}): void {
    if (this.lifecycle !== "running") return;
    this.lifecycle = "completed";
    this.clearStartupDeadline();
    this.leaveTakeover({ restorePi: true });
    try {
      this.done(result);
    } finally {
      if (options.disposePty) this.dispose();
    }
  }
}
