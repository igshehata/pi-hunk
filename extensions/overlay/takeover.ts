import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { Component, Focusable, KeyId, TUI } from "@earendil-works/pi-tui";
import { MouseInputTranslator, toPtyInput, type MouseViewport } from "./input.ts";
import { type OverlayPty, type PtySubscription, spawnOverlayPty } from "./pty.ts";
import type { HunkExit } from "./embedded.ts";
import { TakeoverStartupGate } from "./takeover-startup.ts";

// Mirror Hunk's mouse reporting onto Pi's real terminal while takeover owns focus.
const ENABLE_MOUSE = "\x1b[?1003h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
// Best-effort restore when leaving takeover so Pi's next full paint is not dirty.
// Mouse reporting is restored separately through setMouseEnabled(false).
const RESTORE_TERMINAL = "\x1b[0m\x1b]8;;\x07\x1b[?2026l\x1b[?6l\x1b[?7h\x1b[?25h";
const STARTUP_FRAME_FALLBACK_MS = 1_000;
const DEFAULT_STARTUP_FRAME_DEADLINE_MS = 12_000;
const STARTUP_TIMEOUT_EXIT_CODE = 124;

type LifecycleState = "running" | "completed" | "disposed";
type PresentationState = "active" | "suspended";
type TerminalOwner = "pi" | "takeover";

export interface TakeoverRawInputSource {
  acquire(listener: (data: string | Uint8Array) => void): () => void;
}

export interface TakeoverOptions {
  command: string;
  args: string[];
  cwd: string;
  tui: TUI;
  done: (result: HunkExit) => void;
  startupFrameDeadlineMs?: number;
  /** Test/host hook; ProcessTerminal is feature-detected when omitted. */
  rawInputSource?: TakeoverRawInputSource;
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

interface ProcessTerminalRuntime {
  stdinDataHandler?: (data: string | Buffer) => void;
}

/**
 * Same-tab takeover: Hunk owns the real TTY while Pi's paint loop is suspended.
 *
 * Unlike the embed path, there is no libghostty / formatHtml / Pi overlay composite.
 * Child PTY bytes are written straight to the terminal. Leaving takeover restores
 * Pi with a forced full redraw.
 *
 * Experimental: pokes TUI internals (requestRender paint suppression) and
 * assumes exclusive ownership of the screen while active.
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
  private readonly rawInputSource?: TakeoverRawInputSource;
  private readonly runtime: TuiPaintRuntime;
  private readonly originalRequestRender: TUI["requestRender"];
  private readonly mouseInput = new MouseInputTranslator();
  private readonly startupGate: TakeoverStartupGate;

  private lifecycle: LifecycleState = "running";
  private ptyDecoder = new TextDecoder();
  private presentation: PresentationState = "active";
  private prefixPending = false;
  private mouseEnabled = false;
  private generation = 0;
  private columns: number;
  private rows: number;
  private sawOutput = false;
  private startupDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private startupFallbackTimer: ReturnType<typeof setTimeout> | undefined;
  private removeInputListener: (() => void) | undefined;
  private releaseRawInput: (() => void) | undefined;
  private paintSuspended = false;
  /** Each ownership lease is acquired by enterTakeover and consumed once by leaveTakeover. */
  private terminalOwner: TerminalOwner = "pi";

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
    this.rawInputSource = options.rawInputSource;
    this.startupGate = new TakeoverStartupGate(
      (query) => {
        if (this.presentation === "active" && this.lifecycle === "running") this.writeRaw(query);
      },
      (frame) => {
        if (this.presentation === "active" && this.lifecycle === "running") this.writeRaw(frame);
      },
    );

    this.columns = Math.max(1, options.tui.terminal.columns);
    this.rows = Math.max(1, options.tui.terminal.rows);
    this.runtime = options.tui as unknown as TuiPaintRuntime;
    this.originalRequestRender = this.runtime.requestRender;

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

    try {
      // Acquire terminal ownership and its raw-input lease before onData is
      // registered: some PTY backends synchronously replay buffered startup bytes
      // from the first subscription, including capability queries.
      this.enterTakeover();

      const gen = this.generation;
      // Store each subscription as soon as it is acquired so a later setup
      // failure cannot strand an earlier listener.
      this.subscriptions.push(
        this.pty.onData((data) => {
          if (this.lifecycle !== "running" || gen !== this.generation) return;
          this.sawOutput = true;
          if (this.presentation !== "active") return;
          this.writePtyData(data);
        }),
      );
      this.subscriptions.push(
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

      this.armStartupDeadline();
    } catch (error) {
      // Construction owns the spawned PTY from this point onward. Roll back the
      // same leases as normal disposal before preserving the setup exception.
      this.dispose();
      throw error;
    }
  }

  /**
   * Surface visibility. Hidden takeover suspends VT writes and restores Pi paint;
   * show re-enters takeover and forces Hunk to repaint the cleared alternate screen.
   */
  setVisible(visible: boolean): void {
    if (!visible) this.mouseInput.reset();
    if (this.lifecycle !== "running") return;
    if (visible && this.presentation === "suspended") {
      this.presentation = "active";
      this.resetPtyDecoder();
      this.enterTakeover({ resuming: true });
      // Re-entry clears the alternate screen. Force an actual resize transition
      // when geometry is unchanged so Hunk redraws without waiting for input.
      this.syncPtyGeometry(true);
      return;
    }
    if (!visible && this.presentation === "active") {
      this.presentation = "suspended";
      // A byte sequence or startup frame split across visibility cannot be
      // resumed because output received while hidden is intentionally discarded.
      this.resetPtyDecoder();
      if (!this.startupGate.ready) {
        this.startupGate.reset();
        this.clearStartupFallback();
      }
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
      translated = this.mouseInput.translate(translated, viewport);
    } else if (translated) {
      // Full-screen origin: still run through mouse translator with terminal bounds.
      translated = this.mouseInput.translate(translated, {
        column: 0,
        row: 0,
        width: this.columns,
        height: this.rows,
      });
    }
    if (translated) {
      try {
        this.pty.write(translated);
      } catch {
        // A final input event can already be in Pi's synchronous listener loop
        // when the child closes its PTY. Contain only that boundary write; key
        // translation and lifecycle callbacks above still surface real defects.
      }
    }
  }

  /**
   * Pi may still call render during mount transitions. Return empty lines so any
   * accidental composite is cheap; real content is on the TTY via passthrough.
   */
  render(_width: number): string[] {
    // Mount transitions may still render us; use the same resize path as the
    // requestRender shim so the child always observes physical terminal size.
    this.syncPtyGeometry();
    return [];
  }

  invalidate(): void {
    // No Pi-side buffer; Hunk owns the screen while active.
  }

  dispose(): void {
    if (this.lifecycle === "disposed") return;
    this.flushPtyDecoder(this.lifecycle === "running" && this.presentation === "active");
    this.lifecycle = "disposed";
    this.mouseInput.reset();
    this.generation += 1;
    this.clearStartupTimers();
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

  private enterTakeover(options: { resuming?: boolean } = {}): void {
    if (this.terminalOwner === "takeover") return;
    this.terminalOwner = "takeover";
    this.suspendPiPaint();
    this.acquireStartupRawInput();
    this.setMouseEnabled(true);
    // Clear screen so Hunk's alternate buffer / first paint is not mixed with Pi.
    this.writeRaw("\x1b[?1049h\x1b[2J\x1b[H");
    if (!this.sawOutput) {
      this.writeRaw("Starting Hunk…\r\n");
    } else if (options.resuming) {
      this.writeRaw("Restoring Hunk…\r\n");
    }
  }

  private leaveTakeover(options: { restorePi: boolean }): void {
    if (this.terminalOwner !== "takeover") return;
    // Release first: complete() can synchronously invoke a done callback which
    // removes the surface and re-enters dispose(). That second path must be inert.
    this.terminalOwner = "pi";
    this.releaseStartupRawInput();
    this.setMouseEnabled(false);
    this.prefixPending = false;

    // Stop while the child alternate screen is still selected, then return to
    // Pi's screen. Restarting through TUI is the authoritative way to restore
    // raw input, bracketed paste, keyboard-protocol negotiation, terminal input
    // listeners, cursor policy, and terminal notifications.
    try {
      this.tui.stop();
    } catch {
      // Best effort during terminal teardown; still attempt the remaining restore.
    }
    this.writeRaw("\x1b[?1049l");
    this.writeRaw(RESTORE_TERMINAL);
    try {
      this.tui.start();
    } catch {
      // Terminal may be gone; requestRender restoration still must run below.
    }
    this.resumePiPaint(options.restorePi);
  }

  private suspendPiPaint(): void {
    if (this.paintSuspended) return;
    this.paintSuspended = true;
    // Drop any pending Pi frame and suppress requestRender paints while Hunk owns TTY.
    if (this.runtime.renderTimer) {
      clearTimeout(this.runtime.renderTimer);
      this.runtime.renderTimer = undefined;
    }
    this.runtime.renderRequested = false;
    this.runtime.requestRender = (() => {
      // Pi uses requestRender for terminal resize notifications. Suppress its
      // paint, but still propagate any geometry change to the child PTY.
      this.syncPtyGeometry();
    }) as TUI["requestRender"];
  }

  private resumePiPaint(forceRedraw: boolean): void {
    if (!this.paintSuspended) {
      if (forceRedraw) {
        try {
          this.originalRequestRender.call(this.tui, true);
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
        this.originalRequestRender.call(this.tui, true);
      } catch {
        // ignore
      }
    }
  }

  private syncPtyGeometry(forceRefresh = false): void {
    if (this.lifecycle !== "running") return;

    const columns = Math.max(1, this.tui.terminal.columns);
    const rows = Math.max(1, this.tui.terminal.rows);
    const changed = columns !== this.columns || rows !== this.rows;
    this.columns = columns;
    this.rows = rows;

    if (!changed && !forceRefresh) return;

    if (forceRefresh && !changed) {
      // Re-entry clears the real alternate screen, but an unchanged resize is
      // not required to signal the child. Bounce through another valid size so
      // Hunk receives a genuine resize and repaints at the final geometry.
      const refreshRows = rows === 1 ? 2 : rows - 1;
      try {
        this.pty.resize(columns, refreshRows);
      } catch {
        // Always attempt to restore the real geometry below.
      }
    }

    try {
      this.pty.resize(columns, rows);
    } catch {
      // Child may have exited during a terminal resize or resume.
    }
  }

  private writePtyData(data: string | Uint8Array): void {
    if (typeof data === "string") {
      // Define ordering if a backend ever mixes encoded and decoded chunks.
      this.flushPtyDecoder(true);
      this.processPtyText(data);
      return;
    }

    const text = this.ptyDecoder.decode(data, { stream: true });
    if (text) this.processPtyText(text);
  }

  private processPtyText(text: string): void {
    if (this.startupGate.ready) {
      this.writeRaw(text);
      return;
    }
    const event = this.startupGate.push(text);
    if (event.frameStarted) this.clearStartupFallback();
    else if (event.fallbackEligible) this.armStartupFallback();
    if (event.ready) this.markStartupReady();
  }

  private flushPtyDecoder(write: boolean): void {
    const text = this.ptyDecoder.decode();
    this.ptyDecoder = new TextDecoder();
    if (write && text) this.processPtyText(text);
  }

  private resetPtyDecoder(): void {
    this.ptyDecoder = new TextDecoder();
  }

  /**
   * Pi TUI 0.80.6 has no public raw-input lease. Prefer a host-provided hook,
   * otherwise feature-detect ProcessTerminal's one stdin handler and replace
   * only that listener for the bounded negotiation window.
   */
  private acquireStartupRawInput(): void {
    if (this.startupGate.ready || this.releaseRawInput) return;
    const forward = (data: string | Uint8Array): void => {
      if (
        this.lifecycle !== "running" ||
        this.presentation !== "active" ||
        this.startupGate.ready
      ) {
        return;
      }
      const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
      try {
        // Negotiation owns the terminal, so both complete terminal replies and
        // ordinary keys go to Hunk byte-for-byte. Pi never parses this stream.
        this.pty.write(text);
      } catch {
        // The child may close between stdin delivery and the PTY write.
      }
    };

    if (this.rawInputSource) {
      try {
        let released = false;
        const release = this.rawInputSource.acquire(forward);
        this.releaseRawInput = () => {
          if (released) return;
          released = true;
          release();
        };
      } catch {
        this.releaseRawInput = undefined;
      }
      return;
    }

    const terminal = this.tui.terminal as typeof this.tui.terminal & ProcessTerminalRuntime;
    const piHandler = terminal.stdinDataHandler;
    const listeners = process.stdin.listeners("data");
    if (typeof piHandler !== "function" || !listeners.includes(piHandler)) return;

    process.stdin.removeListener("data", piHandler);
    const rawHandler = (data: string | Buffer): void => forward(data);
    process.stdin.on("data", rawHandler);
    let released = false;
    this.releaseRawInput = () => {
      if (released) return;
      released = true;
      process.stdin.removeListener("data", rawHandler);
      if (
        terminal.stdinDataHandler === piHandler &&
        !process.stdin.listeners("data").includes(piHandler)
      ) {
        process.stdin.on("data", piHandler);
      }
    };
  }

  private releaseStartupRawInput(): void {
    const release = this.releaseRawInput;
    this.releaseRawInput = undefined;
    try {
      release?.();
    } catch {
      // Restoration is best effort when the physical terminal is already gone.
    }
  }

  private writeRaw(text: string): void {
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

  private armStartupFallback(): void {
    if (this.startupGate.ready) return;
    // Renderer output makes fallback eligible, but startup negotiation may keep
    // producing query chunks. Publish only after the entire prelude goes quiet.
    this.clearStartupFallback();
    this.startupFallbackTimer = setTimeout(() => {
      this.startupFallbackTimer = undefined;
      if (
        this.lifecycle !== "running" ||
        this.presentation !== "active" ||
        !this.startupGate.fallback()
      ) {
        return;
      }
      this.markStartupReady();
    }, STARTUP_FRAME_FALLBACK_MS);
    this.startupFallbackTimer.unref?.();
  }

  private clearStartupFallback(): void {
    if (!this.startupFallbackTimer) return;
    clearTimeout(this.startupFallbackTimer);
    this.startupFallbackTimer = undefined;
  }

  private markStartupReady(): void {
    this.clearStartupTimers();
    this.releaseStartupRawInput();
  }

  private armStartupDeadline(): void {
    if (this.startupFrameDeadlineMs <= 0 || this.startupGate.ready) return;
    this.clearStartupDeadline();
    this.startupDeadlineTimer = setTimeout(() => {
      this.startupDeadlineTimer = undefined;
      if (this.lifecycle !== "running" || this.startupGate.ready) return;
      this.complete(
        {
          exitCode: STARTUP_TIMEOUT_EXIT_CODE,
          signal: 0,
          detail: `Hunk takeover failed: no complete startup frame within ${this.startupFrameDeadlineMs}ms.`,
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

  private clearStartupTimers(): void {
    this.clearStartupFallback();
    this.clearStartupDeadline();
  }

  private complete(result: HunkExit, options: { disposePty?: boolean } = {}): void {
    if (this.lifecycle !== "running") return;
    this.lifecycle = "completed";
    this.mouseInput.reset();
    this.clearStartupTimers();
    this.flushPtyDecoder(this.presentation === "active");
    this.leaveTakeover({ restorePi: true });
    try {
      this.done(result);
    } finally {
      if (options.disposePty) this.dispose();
    }
  }
}
