import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { Component, Focusable, KeyId, TUI } from "@earendil-works/pi-tui";
import { MouseInputTranslator, PtyInputEncoder, type MouseViewport } from "./input.ts";
import { type OverlayPty, type PtySubscription, spawnOverlayPty } from "./pty.ts";
import type { HunkExit } from "./embedded.ts";
import { TakeoverStartupGate, TakeoverStartupInput } from "./takeover-startup.ts";

// Mirror Hunk's mouse reporting onto Pi's real terminal while takeover owns focus.
const ENABLE_MOUSE = "\x1b[?1003h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
// Best-effort restore when leaving takeover so Pi's next full paint is not dirty.
// Mouse reporting is restored separately through setMouseEnabled(false).
const RESTORE_TERMINAL =
  "\x1b[0m\x1b]8;;\x07" +
  // Hunk/OpenTUI 0.17.6 enables these input/notification modes directly on
  // the physical terminal. TUI.stop() cannot account for child-owned state,
  // so return to a neutral baseline before TUI.start() reasserts Pi's modes.
  "\x1b[?1004l\x1b[?2027l\x1b[?2031l\x1b[>4;0m" +
  // TUI.stop() pops Hunk's keyboard-protocol push, not Pi's underlying push.
  // Pop that original level before TUI.start() installs one fresh Pi level.
  // Kitty defines pop on an empty stack as inert, so this also covers children
  // that never pushed keyboard flags.
  "\x1b[<u" +
  "\x1b[?2026l\x1b[?6l\x1b[?7h\x1b[?25h";
const STARTUP_FRAME_FALLBACK_MS = 1_000;
const DEFAULT_STARTUP_FRAME_DEADLINE_MS = 12_000;
const STARTUP_TIMEOUT_EXIT_CODE = 124;
const RESUME_FRAME_SETTLE_MS = 100;
const RESUME_REFRESH_FALLBACK_MS = 1_000;
const SYNCHRONIZED_FRAME_START = "\x1b[?2026h";
const SYNCHRONIZED_FRAME_END = "\x1b[?2026l";

function retainedMarkerPrefix(source: string, marker: string): string {
  const maximum = Math.min(marker.length - 1, source.length);
  for (let length = maximum; length > 0; length -= 1) {
    if (marker.startsWith(source.slice(-length))) return source.slice(-length);
  }
  return "";
}

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
  private readonly ptyInput = new PtyInputEncoder();
  private readonly startupInput: TakeoverStartupInput;
  private readonly startupGate: TakeoverStartupGate;
  /** Also registered verbatim with TUI.addInputListener. */
  private readonly inputListener = (data: string): { consume?: boolean } | undefined => {
    if (this.lifecycle !== "running" || this.presentation !== "active") {
      return undefined;
    }
    this.handleInput(data);
    return { consume: true };
  };

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
  private resumeRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private resumeSettleTimer: ReturnType<typeof setTimeout> | undefined;
  private resumeRefreshPending = false;
  private resumeFrameStarted = false;
  private resumeFrameTail = "";
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
    this.startupInput = new TakeoverStartupInput(
      (data) => {
        // Raw startup stdin bypasses ProcessTerminal/StdinBuffer, but it must not
        // bypass takeover semantics. Dispatch through the same listener object
        // registered below so prefix+h/s can never leak into the child PTY.
        this.inputListener(data);
      },
      (reply) => {
        if (this.lifecycle !== "running" || this.presentation !== "active") return;
        try {
          // Structured terminal replies are not key events. Preserve arbitrary
          // payload text byte-for-byte instead of running isKeyRelease/CSI-u
          // translation over it.
          this.pty.write(reply);
        } catch {
          // The child may close between terminal reply delivery and this write.
        }
      },
    );
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
        this.removeInputListener = addInputListener.call(this.tui, this.inputListener);
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
    if (!visible) {
      this.mouseInput.reset();
      this.ptyInput.reset();
    }
    if (this.lifecycle !== "running") return;
    if (visible && this.presentation === "suspended") {
      this.presentation = "active";
      this.resetPtyDecoder();
      this.enterTakeover({ resuming: true });
      // Re-entry clears the alternate screen. Force an actual resize transition
      // when geometry is unchanged so Hunk redraws without waiting for input.
      this.syncPtyGeometry(true);
      // Startup has a fresh bounded negotiation lease on every presentation.
      // Arm after resize because a synchronous redraw can make the gate ready.
      this.armStartupDeadline();
      return;
    }
    if (!visible && this.presentation === "active") {
      this.presentation = "suspended";
      // If hide races the acknowledged resize bounce, restore the real PTY
      // geometry before hidden output starts being discarded. Otherwise the
      // next show could repeat the temporary size and receive no SIGWINCH.
      this.finishResumeRefresh();
      // A byte sequence or startup frame split across visibility cannot be
      // resumed because output received while hidden is intentionally discarded.
      this.resetPtyDecoder();
      if (!this.startupGate.ready) {
        this.startupGate.reset();
        // Hidden output is discarded, so neither the quiet fallback nor the
        // hard deadline may consume startup time outside this presentation.
        this.clearStartupTimers();
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
      this.ptyInput.reset();
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

    let translated = this.ptyInput.translate(data);
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
    this.cancelResumeRefresh();
    this.flushPtyDecoder(this.lifecycle === "running" && this.presentation === "active");
    this.lifecycle = "disposed";
    this.mouseInput.reset();
    this.ptyInput.reset();
    this.startupInput.reset();
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
    this.ptyInput.reset();

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
      this.beginResumeRefresh(columns, rows);
      return;
    }

    // A real terminal resize supersedes any temporary resume geometry. Its
    // changed dimensions already force Hunk to produce a complete repaint.
    this.cancelResumeRefresh();
    try {
      this.pty.resize(columns, rows);
    } catch {
      // Child may have exited during a terminal resize or resume.
    }
  }

  /**
   * Clear-on-resume needs a full child repaint. Two resize calls in one stack
   * can collapse into one SIGWINCH at the unchanged final geometry, leaving
   * only "Restoring Hunk…" on screen. Hold the temporary geometry until Hunk
   * acknowledges it with a complete synchronized frame, then restore the real
   * geometry. The timer is only a bounded fallback for non-DEC renderers.
   */
  private beginResumeRefresh(columns: number, rows: number): void {
    this.cancelResumeRefresh();
    this.resumeRefreshPending = true;
    this.resumeFrameStarted = false;
    this.resumeFrameTail = "";
    this.resumeRefreshTimer = setTimeout(() => {
      this.resumeRefreshTimer = undefined;
      if (
        !this.resumeRefreshPending ||
        this.lifecycle !== "running" ||
        this.presentation !== "active"
      ) {
        this.cancelResumeRefresh();
        return;
      }
      this.finishResumeRefresh();
    }, RESUME_REFRESH_FALLBACK_MS);
    this.resumeRefreshTimer.unref?.();

    const refreshRows = rows === 1 ? 2 : rows - 1;
    try {
      this.pty.resize(columns, refreshRows);
    } catch {
      // A failed temporary resize must not strand a stale pending lease or
      // prevent the final physical geometry from being restored.
      this.cancelResumeRefresh();
      try {
        this.pty.resize(columns, rows);
      } catch {
        // Child may have exited during resume.
      }
    }
  }

  private observeResumeRefresh(text: string): void {
    if (!this.resumeRefreshPending || !text) return;

    const marker = this.resumeFrameStarted ? SYNCHRONIZED_FRAME_END : SYNCHRONIZED_FRAME_START;
    const source = this.resumeFrameTail + text;
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) {
      this.resumeFrameTail = retainedMarkerPrefix(source, marker);
      return;
    }

    if (!this.resumeFrameStarted) {
      this.resumeFrameStarted = true;
      const trailing = source.slice(markerIndex + SYNCHRONIZED_FRAME_START.length);
      if (!trailing.includes(SYNCHRONIZED_FRAME_END)) {
        this.resumeFrameTail = retainedMarkerPrefix(trailing, SYNCHRONIZED_FRAME_END);
        return;
      }
    }

    // A complete transaction can have been queued while Hunk was hidden. Wait
    // for a short quiet interval before restoring final geometry: the actual
    // temporary-size repaint supersedes a stale differential frame and rearms
    // this timer. The hard fallback still bounds continuously updating output.
    this.resumeFrameStarted = false;
    this.resumeFrameTail = "";
    if (this.resumeSettleTimer) clearTimeout(this.resumeSettleTimer);
    this.resumeSettleTimer = setTimeout(() => {
      this.resumeSettleTimer = undefined;
      if (
        !this.resumeRefreshPending ||
        this.lifecycle !== "running" ||
        this.presentation !== "active"
      ) {
        this.cancelResumeRefresh();
        return;
      }
      // Clear pending state before resize: test backends and buffered PTYs may
      // synchronously emit the final frame from inside resize().
      this.finishResumeRefresh();
    }, RESUME_FRAME_SETTLE_MS);
    this.resumeSettleTimer.unref?.();
  }

  private finishResumeRefresh(): void {
    if (!this.resumeRefreshPending) return;
    this.cancelResumeRefresh();
    if (this.lifecycle !== "running") return;

    const columns = Math.max(1, this.tui.terminal.columns);
    const rows = Math.max(1, this.tui.terminal.rows);
    this.columns = columns;
    this.rows = rows;
    try {
      this.pty.resize(columns, rows);
    } catch {
      // Child may have exited while its temporary frame was being published.
    }
  }

  private cancelResumeRefresh(): void {
    if (this.resumeRefreshTimer) clearTimeout(this.resumeRefreshTimer);
    if (this.resumeSettleTimer) clearTimeout(this.resumeSettleTimer);
    this.resumeRefreshTimer = undefined;
    this.resumeSettleTimer = undefined;
    this.resumeRefreshPending = false;
    this.resumeFrameStarted = false;
    this.resumeFrameTail = "";
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
    } else {
      const event = this.startupGate.push(text);
      if (event.frameStarted) this.clearStartupFallback();
      else if (event.fallbackEligible) this.armStartupFallback();
      if (event.ready) this.markStartupReady();
    }
    // Observe only after publishing this chunk so the temporary complete frame
    // reaches the physical terminal before its final-geometry resize can emit.
    this.observeResumeRefresh(text);
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
    this.startupInput.reset();
    const forward = (data: string | Uint8Array): void => {
      if (
        this.lifecycle !== "running" ||
        this.presentation !== "active" ||
        this.startupGate.ready
      ) {
        return;
      }
      // Split raw chunks into complete terminal events. The splitter preserves
      // capability replies while dispatching ordinary keys through inputListener.
      this.startupInput.push(data);
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
      if (
        this.lifecycle !== "running" ||
        this.presentation !== "active" ||
        this.startupGate.ready
      ) {
        return;
      }
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
    this.cancelResumeRefresh();
    this.lifecycle = "completed";
    this.mouseInput.reset();
    this.ptyInput.reset();
    this.clearStartupTimers();
    this.flushPtyDecoder(this.presentation === "active");
    const detail = result.detail ?? this.startupGate.exitDetail();
    const settled = detail && !result.detail ? { ...result, detail } : result;
    this.leaveTakeover({ restorePi: true });
    try {
      this.done(settled);
    } finally {
      if (options.disposePty) this.dispose();
    }
  }
}
