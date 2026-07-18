import { createTerminal } from "@coder/libghostty-vt-node";
import type { GhosttyVtTerminal } from "@coder/libghostty-vt-node";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { Component, Focusable, KeyId, TUI } from "@earendil-works/pi-tui";
import { toPtyInput, translateMouseInput, type MouseViewport } from "./input.ts";
import { type OverlayPty, type PtySubscription, spawnOverlayPty } from "./pty.ts";
import { renderGhosttyHtml } from "./render-buffer.ts";

// Hunk enables mouse reporting inside the child PTY. Mirror it to Pi's real
// terminal while the overlay is focused/visible and forward the resulting SGR
// mouse events back to Hunk.
const ENABLE_MOUSE = "\x1b[?1003h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
const SYNCHRONIZED_FRAME_START = "\x1b[?2026h";
const STARTUP_FRAME_FALLBACK_MS = 1000;
const DEFAULT_STARTUP_FRAME_DEADLINE_MS = 12_000;
const STARTUP_TIMEOUT_EXIT_CODE = 124;
const EXIT_DETAIL_MAX_CHARS = 2000;
const EXIT_DETAIL_MAX_LINES = 12;

type EmbeddedLifecycleState = "running" | "completed" | "disposed";
type EmbeddedLifecycleEvent = "complete" | "dispose";
const EMBEDDED_LIFECYCLE_TRANSITIONS: Record<
  EmbeddedLifecycleState,
  Record<EmbeddedLifecycleEvent, EmbeddedLifecycleState>
> = {
  running: { complete: "completed", dispose: "disposed" },
  completed: { complete: "completed", dispose: "disposed" },
  disposed: { complete: "disposed", dispose: "disposed" },
};

type StartupState = "waiting" | "fallback" | "ready" | "failed" | "disposed";
type StartupEvent = "output" | "ready" | "fail" | "dispose";
const STARTUP_TRANSITIONS: Record<StartupState, Record<StartupEvent, StartupState>> = {
  waiting: { output: "fallback", ready: "ready", fail: "failed", dispose: "disposed" },
  fallback: { output: "fallback", ready: "ready", fail: "failed", dispose: "disposed" },
  ready: { output: "ready", ready: "ready", fail: "ready", dispose: "disposed" },
  failed: { output: "failed", ready: "failed", fail: "failed", dispose: "disposed" },
  disposed: { output: "disposed", ready: "disposed", fail: "disposed", dispose: "disposed" },
};

type PresentationState =
  | "visible-unfocused"
  | "visible-focused"
  | "hidden-unfocused"
  | "hidden-focused";
type PresentationEvent = "show" | "hide" | "focus" | "blur";
const PRESENTATION_TRANSITIONS: Record<
  PresentationState,
  Record<PresentationEvent, PresentationState>
> = {
  "visible-unfocused": {
    show: "visible-unfocused",
    hide: "hidden-unfocused",
    focus: "visible-focused",
    blur: "visible-unfocused",
  },
  "visible-focused": {
    show: "visible-focused",
    hide: "hidden-focused",
    focus: "visible-focused",
    blur: "visible-unfocused",
  },
  "hidden-unfocused": {
    show: "visible-unfocused",
    hide: "hidden-unfocused",
    focus: "hidden-focused",
    blur: "hidden-unfocused",
  },
  "hidden-focused": {
    show: "visible-focused",
    hide: "hidden-focused",
    focus: "hidden-focused",
    blur: "hidden-unfocused",
  },
};

type PtyState = "running" | "exited" | "disposed";
type PtyEvent = "exit" | "dispose";
const PTY_TRANSITIONS: Record<PtyState, Record<PtyEvent, PtyState>> = {
  running: { exit: "exited", dispose: "disposed" },
  exited: { exit: "exited", dispose: "exited" },
  disposed: { exit: "disposed", dispose: "disposed" },
};

export interface HunkExit {
  exitCode: number;
  signal?: number;
  /** Bounded plain-text terminal detail captured at exit/startup failure. */
  detail?: string;
}

export interface EmbeddedOptions {
  command: string;
  args: string[];
  cwd: string;
  tui: TUI;
  done: (result: HunkExit) => void;
  /** Initial allocated row count (overlay max height). Defaults to terminal rows. */
  initialRows?: number;
  /** Resolve allocated rows again when the physical terminal is resized. */
  resolveRows?: (terminalRows: number) => number;
  /** Resolve the overlay's physical viewport for mouse-coordinate translation. */
  resolveMouseViewport?: (
    terminalColumns: number,
    terminalRows: number,
    overlayColumns: number,
    overlayRows: number,
  ) => MouseViewport;
  /** Deadline for the first synchronized/fallback terminal frame. Default: 12s. */
  startupFrameDeadlineMs?: number;
  /**
   * Dedicated prefix intercepted before the PTY while the overlay owns focus.
   * The next `h` toggles the overlay and `s` replaces it with `hunk show`.
   */
  prefixKey?: KeyId;
  /** Configured action key read after prefixKey. */
  toggleKey?: KeyId;
  /** Called for prefix + toggleKey while the component is visible. */
  onToggleRequest?: () => void;
  /** Configured action key read after prefixKey. */
  showKey?: KeyId;
  /** Called for prefix + showKey while the component is visible. */
  onShowRequest?: () => void;
}

export class EmbeddedHunk implements Component, Focusable {
  private readonly tui: TUI;
  private readonly terminal: GhosttyVtTerminal;
  private readonly formatTerminalHtml: () => string;
  private readonly pty: OverlayPty;
  private readonly subscriptions: PtySubscription[] = [];
  private readonly done: (result: HunkExit) => void;
  private readonly resolveRows?: (terminalRows: number) => number;
  private readonly resolveMouseViewport?: EmbeddedOptions["resolveMouseViewport"];
  private readonly prefixKey?: KeyId;
  private readonly toggleKey?: KeyId;
  private readonly onToggleRequest?: () => void;
  private readonly showKey?: KeyId;
  private readonly onShowRequest?: () => void;
  private readonly startupFrameDeadlineMs: number;
  private prefixPending = false;
  private columns: number;
  private rows: number;
  private lifecycleState: EmbeddedLifecycleState = "running";
  private startupState: StartupState = "waiting";
  private presentationState: PresentationState = "visible-unfocused";
  private ptyState: PtyState = "running";
  private startupProbeTail = "";
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private startupDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private mouseState: "enabled" | "disabled" = "disabled";
  private generation = 0;
  private renderQueued = false;
  private contentGeneration = 0;
  private renderedGeneration = -1;
  private renderedColumns = 0;
  private renderedRows = 0;
  private renderedLines: string[] | undefined;

  get pid(): number | undefined {
    return this.pty.pid;
  }

  get focused(): boolean {
    return this.isFocused();
  }

  set focused(value: boolean) {
    const event: PresentationEvent = value ? "focus" : "blur";
    const next = PRESENTATION_TRANSITIONS[this.presentationState][event];
    if (next === this.presentationState) return;
    this.presentationState = next;
    if (!value) this.prefixPending = false;
    this.updateMouseMode();
  }

  private isRunning(): boolean {
    return this.lifecycleState === "running";
  }

  private isDisposed(): boolean {
    return this.lifecycleState === "disposed";
  }

  private isVisibleState(): boolean {
    return (
      this.presentationState === "visible-unfocused" || this.presentationState === "visible-focused"
    );
  }

  private isFocused(): boolean {
    return (
      this.presentationState === "visible-focused" || this.presentationState === "hidden-focused"
    );
  }

  private transitionLifecycle(event: EmbeddedLifecycleEvent): void {
    this.lifecycleState = EMBEDDED_LIFECYCLE_TRANSITIONS[this.lifecycleState][event];
  }

  private transitionStartup(event: StartupEvent): void {
    this.startupState = STARTUP_TRANSITIONS[this.startupState][event];
  }

  private transitionPty(event: PtyEvent): void {
    this.ptyState = PTY_TRANSITIONS[this.ptyState][event];
  }

  constructor(options: EmbeddedOptions) {
    this.tui = options.tui;
    this.done = options.done;
    this.resolveRows = options.resolveRows;
    this.resolveMouseViewport = options.resolveMouseViewport;
    this.prefixKey = options.prefixKey;
    this.toggleKey = options.toggleKey;
    this.onToggleRequest = options.onToggleRequest;
    this.showKey = options.showKey;
    this.onShowRequest = options.onShowRequest;
    this.startupFrameDeadlineMs = Math.max(
      0,
      options.startupFrameDeadlineMs ?? DEFAULT_STARTUP_FRAME_DEADLINE_MS,
    );
    this.columns = Math.max(1, options.tui.terminal.columns);
    this.rows = Math.max(1, options.initialRows ?? options.tui.terminal.rows);
    this.terminal = createTerminal({
      cols: this.columns,
      rows: this.rows,
      scrollbackLimit: 0,
    });
    if (typeof this.terminal.formatHtml !== "function") {
      this.terminal.dispose();
      throw new Error("The installed libghostty binding does not expose formatHtml().");
    }
    this.formatTerminalHtml = this.terminal.formatHtml.bind(this.terminal);

    try {
      this.pty = spawnOverlayPty({
        command: options.command,
        args: options.args,
        columns: this.columns,
        rows: this.rows,
        cwd: options.cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          TERM_PROGRAM: "pi-hunk",
          FORCE_COLOR: "3",
        } as Record<string, string>,
      });
    } catch (error) {
      this.terminal.dispose();
      throw error;
    }

    const gen = this.generation;
    this.subscriptions.push(
      this.pty.onData((data) => {
        if (!this.isRunning() || gen !== this.generation) return;
        // Avoid exposing OpenTUI's capability-probe prelude between the startup
        // placeholder and its first synchronized frame. Hunk/OpenTUI emits a
        // synchronized-update begin marker when the actual UI paint starts.
        if (this.startupState !== "ready") this.observeStartupOutput(data);
        // libghostty parses synchronously. Keep the native terminal current while
        // hidden, but do not repaint Pi until the overlay is shown again.
        this.terminal.feed(data);
        this.contentGeneration += 1;
        this.renderedLines = undefined;
        if (this.isVisibleState() && this.startupState === "ready") this.scheduleRender();
      }),
      this.pty.onExit((event) => {
        if (!this.isRunning() || gen !== this.generation) return;
        this.transitionPty("exit");
        const detail = this.captureExitDetail();
        this.complete(detail ? { ...event, detail } : event);
      }),
    );
    this.armStartupDeadline();
    this.updateMouseMode();
  }

  /**
   * Mirror overlay visibility for mouse reporting.
   * Call before/after OverlayHandle.setHidden so mouse state stays in lockstep.
   */
  setVisible(visible: boolean): void {
    const event: PresentationEvent = visible ? "show" : "hide";
    const next = PRESENTATION_TRANSITIONS[this.presentationState][event];
    if (next === this.presentationState) return;
    this.presentationState = next;
    if (!visible) this.prefixPending = false;
    this.updateMouseMode();
    // A queued microtask checks visibility before painting. Showing remains an
    // immediate correctness boundary and flushes all output parsed while hidden.
    if (visible) this.tui.requestRender();
  }

  isVisible(): boolean {
    return this.isVisibleState();
  }

  handleInput(data: string): void {
    if (!this.isVisibleState() || !this.isRunning()) return;
    if (!isKeyRelease(data) && this.prefixKey && matchesKey(data, this.prefixKey)) {
      this.prefixPending = true;
      return;
    }
    if (!isKeyRelease(data) && this.prefixPending) {
      this.prefixPending = false;
      if (this.toggleKey && matchesKey(data, this.toggleKey)) this.onToggleRequest?.();
      else if (this.showKey && matchesKey(data, this.showKey)) this.onShowRequest?.();
      // Unknown suffixes cancel the Pi-hunk chord and are not sent to Hunk.
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
    }
    if (translated) this.pty.write(translated);
  }

  render(width: number): string[] {
    // Use the allocated overlay width and the last known/target row count rather
    // than always assuming the full physical terminal height.
    const cols = Math.max(1, width);
    const rows = Math.max(1, this.resolveRows?.(this.tui.terminal.rows) ?? this.rows);
    this.resize(cols, rows);
    if (this.startupState !== "ready") {
      const message = "Starting Hunk…";
      return [message, ...Array.from({ length: Math.max(0, rows - 1) }, () => "")];
    }
    if (
      this.renderedLines &&
      this.renderedGeneration === this.contentGeneration &&
      this.renderedColumns === this.columns &&
      this.renderedRows === this.rows
    ) {
      return this.renderedLines;
    }

    const html = this.formatTerminalHtml();
    this.renderedLines = renderGhosttyHtml(html, this.columns, this.rows);
    this.renderedGeneration = this.contentGeneration;
    this.renderedColumns = this.columns;
    this.renderedRows = this.rows;
    return this.renderedLines;
  }

  /** Update the target row budget from overlay maxHeight resolution. */
  setTargetRows(rows: number): void {
    const next = Math.max(1, rows);
    if (next === this.rows) return;
    this.resize(this.columns, next);
  }

  invalidate(): void {
    this.renderedLines = undefined;
    this.tui.requestRender();
  }

  dispose(): void {
    if (this.isDisposed()) return;
    this.transitionLifecycle("dispose");
    this.transitionStartup("dispose");
    this.generation += 1;
    this.clearStartupTimers();
    this.setMouseEnabled(false);
    if (this.ptyState === "running") {
      this.transitionPty("dispose");
      try {
        this.pty.dispose();
      } catch {
        // Already exited.
      }
    }
    this.renderQueued = false;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
    this.terminal.dispose();
  }

  private observeStartupOutput(data: string | Uint8Array): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    const probe = this.startupProbeTail + text;
    this.startupProbeTail = probe.slice(-SYNCHRONIZED_FRAME_START.length);
    if (probe.includes(SYNCHRONIZED_FRAME_START)) {
      this.markStartupReady();
      return;
    }

    // Compatibility fallback for a future Hunk renderer that does not use
    // synchronized terminal updates. Keep this long enough that capability
    // negotiation cannot flash as a partial frame.
    if (this.startupState !== "waiting") return;
    this.transitionStartup("output");
    this.clearStartupDeadlineTimer();
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      if (!this.isRunning()) return;
      this.markStartupReady();
      if (this.isVisibleState()) this.tui.requestRender();
    }, STARTUP_FRAME_FALLBACK_MS);
    this.startupTimer.unref?.();
  }

  private armStartupDeadline(): void {
    if (this.startupFrameDeadlineMs <= 0 || this.startupState !== "waiting") return;
    this.clearStartupDeadlineTimer();
    this.startupDeadlineTimer = setTimeout(() => {
      this.startupDeadlineTimer = undefined;
      this.failStartupFrameDeadline();
    }, this.startupFrameDeadlineMs);
    this.startupDeadlineTimer.unref?.();
  }

  private clearStartupTimer(): void {
    if (!this.startupTimer) return;
    clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
  }

  private clearStartupDeadlineTimer(): void {
    if (!this.startupDeadlineTimer) return;
    clearTimeout(this.startupDeadlineTimer);
    this.startupDeadlineTimer = undefined;
  }

  private clearStartupTimers(): void {
    this.clearStartupTimer();
    this.clearStartupDeadlineTimer();
  }

  private markStartupReady(): void {
    if (this.startupState !== "waiting" && this.startupState !== "fallback") return;
    this.transitionStartup("ready");
    this.startupProbeTail = "";
    this.clearStartupTimers();
  }

  private failStartupFrameDeadline(): void {
    if (!this.isRunning() || this.startupState !== "waiting") return;
    this.transitionStartup("fail");
    this.complete(
      {
        exitCode: STARTUP_TIMEOUT_EXIT_CODE,
        signal: 0,
        detail: `Hunk startup failed: no terminal frame became ready within ${this.startupFrameDeadlineMs}ms.`,
      },
      { disposePty: true },
    );
  }

  private complete(result: HunkExit, options: { disposePty?: boolean } = {}): void {
    if (!this.isRunning()) return;
    this.transitionLifecycle("complete");
    this.renderQueued = false;
    this.clearStartupTimers();
    this.setMouseEnabled(false);
    try {
      this.done(result);
    } finally {
      if (options.disposePty) this.dispose();
    }
  }

  private captureExitDetail(): string | undefined {
    let text: string | undefined;
    try {
      text = this.terminal.getVisibleText();
    } catch {
      text = undefined;
    }
    if (!text?.trim() && this.terminal.formatPlain) {
      try {
        text = this.terminal.formatPlain();
      } catch {
        // Optional debug formatter may be unavailable.
      }
    }
    return boundTerminalDetail(text);
  }

  /**
   * Collapse output delivered in the same JavaScript turn without adding a frame
   * timer. Pi already enforces its own ~16 ms render interval, so another 16 ms
   * timeout here only doubled scrolling latency.
   */
  private scheduleRender(): void {
    if (this.renderQueued || !this.isVisibleState() || !this.isRunning()) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      if (this.isVisibleState() && this.isRunning()) this.tui.requestRender();
    });
  }

  private updateMouseMode(): void {
    this.setMouseEnabled(
      this.presentationState === "visible-focused" && this.lifecycleState === "running",
    );
  }

  private setMouseEnabled(enabled: boolean): void {
    const next = enabled ? "enabled" : "disabled";
    if (next === this.mouseState) return;
    this.mouseState = next;
    try {
      this.tui.terminal.write(enabled ? ENABLE_MOUSE : DISABLE_MOUSE);
    } catch {
      // Terminal may already be tearing down.
    }
  }

  private resize(columns: number, rows: number): void {
    if (!this.isRunning()) return;
    if (columns === this.columns && rows === this.rows) return;
    this.columns = columns;
    this.rows = rows;
    this.terminal.resize(columns, rows);
    this.contentGeneration += 1;
    this.renderedLines = undefined;
    this.pty.resize(columns, rows);
  }
}

function boundTerminalDetail(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const sanitized = stripUnsafeControls(text.replace(/\r\n?/g, "\n"));
  const lines = sanitized.split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
  while (lines.length > 0 && !lines.at(-1)?.trim()) lines.pop();
  if (lines.length === 0) return undefined;
  let detail = lines.slice(-EXIT_DETAIL_MAX_LINES).join("\n").trim();
  if (detail.length > EXIT_DETAIL_MAX_CHARS) {
    detail = `…${detail.slice(detail.length - EXIT_DETAIL_MAX_CHARS + 1)}`;
  }
  return detail || undefined;
}

function stripUnsafeControls(text: string): string {
  let sanitized = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) continue;
    sanitized += char;
  }
  return sanitized;
}
