import { createTerminal } from "@coder/libghostty-vt-node";
import type { GhosttyVtTerminal } from "@coder/libghostty-vt-node";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { Component, Focusable, KeyId, TUI } from "@earendil-works/pi-tui";
import { MouseInputTranslator, toPtyInput, type MouseViewport } from "./input.ts";
import { type OverlayPty, type PtySubscription, spawnOverlayPty } from "./pty.ts";
import { paintTerminalCursor, renderGhosttyHtml, resizeRenderedLines } from "./render-buffer.ts";
import type { TerminalCursor } from "./render-buffer.ts";
import type { ExclusiveFrameController, HunkDirectFrame } from "./exclusive-frame.ts";

// Hunk enables mouse reporting inside the child PTY. Mirror it to Pi's real
// terminal while the overlay is focused/visible and forward the resulting SGR
// mouse events back to Hunk.
const ENABLE_MOUSE = "\x1b[?1003h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
// DEC synchronized-output boundaries (OpenTUI/Hunk logical paints).
const SYNCHRONIZED_FRAME_PREFIX = "\x1b[?2026";
const SYNCHRONIZED_FRAME_ESCAPE = 0x1b;
const SYNCHRONIZED_FRAME_START_FINAL = "h".charCodeAt(0);
const SYNCHRONIZED_FRAME_END_FINAL = "l".charCodeAt(0);
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
  /** Initial allocated column count (overlay width). Defaults to terminal columns. */
  initialColumns?: number;
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
  /** Default-off direct-region rendering lease for focused split panes. */
  exclusiveFrame?: ExclusiveFrameController;
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
  private readonly exclusiveFrame?: ExclusiveFrameController;
  private readonly startupFrameDeadlineMs: number;
  private readonly mouseInput = new MouseInputTranslator();
  private prefixPending = false;
  private columns: number;
  private rows: number;
  private lifecycleState: EmbeddedLifecycleState = "running";
  private startupState: StartupState = "waiting";
  private presentationState: PresentationState = "visible-unfocused";
  private ptyState: PtyState = "running";
  /** Prefix-match carry across PTY chunk splits for DEC 2026 markers. */
  private synchronizedFrameMarkerLength = 0;
  /** True between matching 2026h and 2026l; previous complete frame stays published. */
  private synchronizedFrameOpen = false;
  /**
   * The installed wrapper snapshot exposes cursor coordinates but not DECTCEM.
   * Track mode 25 from the same fed byte ranges until the binding exposes it.
   */
  private childCursorVisible = true;
  private cursorControlState: "ground" | "escape" | "csi" = "ground";
  private cursorCsiParameters = "";
  private cursorCsiValid = true;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private startupDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private mouseState: "enabled" | "disabled" = "disabled";
  private generation = 0;
  private renderQueued = false;
  /** Completed-frame revision which may render even if a newer synchronized frame is open. */
  private renderQueuedFrameRevision: number | undefined;
  private contentGeneration = 0;
  /** Monotonic publication event for synchronously captured complete DEC 2026 frames. */
  private publishedFrameRevision = 0;
  private renderedGeneration = -1;
  private renderedColumns = 0;
  private renderedRows = 0;
  /** Cursor-free complete snapshot; focus-time cursor paint is derived from this cache. */
  private renderedLines: string[] | undefined;
  /** Cursor state captured with renderedLines, never from an open partial frame. */
  private renderedCursor: TerminalCursor | undefined;

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
    // Revoke direct terminal ownership before focus-driven cursor/mouse writes.
    this.exclusiveFrame?.setFocused(value);
    this.updateMouseMode();
    // Float/embed cursor composition is focus-dependent. Repaint directly from
    // the last complete snapshot; renderCurrentLines deliberately refuses to
    // recapture native state while a synchronized child frame is open.
    if (
      !this.exclusiveFrame &&
      this.isVisibleState() &&
      this.isRunning() &&
      this.startupState === "ready"
    ) {
      this.tui.requestRender();
    }
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
    this.exclusiveFrame = options.exclusiveFrame;
    this.startupFrameDeadlineMs = Math.max(
      0,
      options.startupFrameDeadlineMs ?? DEFAULT_STARTUP_FRAME_DEADLINE_MS,
    );
    this.columns = Math.max(1, options.initialColumns ?? options.tui.terminal.columns);
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
        // Feed through each completed boundary separately. A chunk may end frame
        // N and begin frame N+1; frame N must be captured before N+1 mutates the
        // native terminal buffer.
        const synchronizedFrame = this.processSynchronizedFrameOutput(data);
        // Avoid exposing OpenTUI's capability-probe prelude between the startup
        // placeholder and its first complete synchronized frame.
        if (this.startupState !== "ready") this.observeStartupOutput(synchronizedFrame);
        // Keep the native terminal current while hidden, but only notify a visible
        // consumer of complete frames. A completion is a publication event even
        // when the final state of this PTY chunk is another open frame.
        if (this.isVisibleState() && this.startupState === "ready") {
          if (synchronizedFrame.publishedRevision !== undefined) {
            this.requestFrame(synchronizedFrame.publishedRevision);
          } else if (!this.synchronizedFrameOpen) {
            this.requestFrame();
          }
        }
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
    if (!visible) this.mouseInput.reset();
    const event: PresentationEvent = visible ? "show" : "hide";
    const next = PRESENTATION_TRANSITIONS[this.presentationState][event];
    if (next === this.presentationState) return;
    this.presentationState = next;
    if (!visible) this.prefixPending = false;
    // Revoke direct terminal ownership before visibility-driven terminal writes.
    this.exclusiveFrame?.setVisible(visible);
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
      this.exclusiveFrame?.armPostInputRenderSuppression();
      return;
    }
    if (!isKeyRelease(data) && this.prefixPending) {
      this.prefixPending = false;
      if (this.toggleKey && matchesKey(data, this.toggleKey)) this.onToggleRequest?.();
      else if (this.showKey && matchesKey(data, this.showKey)) this.onShowRequest?.();
      else this.exclusiveFrame?.armPostInputRenderSuppression();
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
      translated = this.mouseInput.translate(translated, viewport);
    }
    if (translated) this.pty.write(translated);
    this.exclusiveFrame?.armPostInputRenderSuppression();
  }

  render(width: number): string[] {
    // Use the allocated overlay width and the last known/target row count rather
    // than always assuming the full physical terminal height.
    const cols = Math.max(1, width);
    const rows = Math.max(1, this.resolveRows?.(this.tui.terminal.rows) ?? this.rows);
    this.resize(cols, rows);
    const lines = this.renderCurrentLines();
    this.exclusiveFrame?.observeCompositedFrame(this.directFrame(lines));
    return lines;
  }

  private renderCurrentLines(): string[] {
    if (this.startupState !== "ready") {
      const message = "Starting Hunk…";
      return [message, ...Array.from({ length: Math.max(0, this.rows - 1) }, () => "")];
    }
    // Pi may request a render after every focused input event. During an open
    // synchronized child frame that must not expose libghostty's partial state
    // (embed composite or exclusive direct paint both call this path).
    if (this.synchronizedFrameOpen) {
      if (
        this.renderedLines &&
        this.renderedColumns === this.columns &&
        this.renderedRows === this.rows
      ) {
        return this.composeRenderedLines();
      }
      // Startup is a one-way gate. If an unusual renderer opens a synchronized
      // frame immediately after fallback readiness but before its first Pi paint,
      // never repurpose the startup placeholder as ordinary ready-state content.
      return resizeRenderedLines([], this.columns, this.rows);
    }
    if (
      this.renderedLines &&
      this.renderedGeneration === this.contentGeneration &&
      this.renderedColumns === this.columns &&
      this.renderedRows === this.rows
    ) {
      return this.composeRenderedLines();
    }

    this.renderedLines = this.captureRenderedLines();
    this.renderedGeneration = this.contentGeneration;
    this.renderedColumns = this.columns;
    this.renderedRows = this.rows;
    return this.composeRenderedLines();
  }

  private directFrame(lines = this.renderCurrentLines()): HunkDirectFrame {
    return {
      ready: this.startupState === "ready",
      columns: this.columns,
      rows: this.rows,
      lines,
    };
  }

  /** Update the target row budget from overlay maxHeight resolution. */
  setTargetRows(rows: number): void {
    const next = Math.max(1, rows);
    if (next === this.rows) return;
    this.exclusiveFrame?.revoke("target-rows-changed");
    this.resize(this.columns, next);
  }

  invalidate(): void {
    this.exclusiveFrame?.revoke("component-invalidated");
    // Force a refresh when it is safe, but retain the last complete snapshot in
    // case a synchronized update opens before Pi performs that refresh.
    this.renderedGeneration = -1;
    this.tui.requestRender();
  }

  dispose(): void {
    if (this.isDisposed()) return;
    this.transitionLifecycle("dispose");
    this.transitionStartup("dispose");
    this.exclusiveFrame?.revoke("component-disposed");
    this.mouseInput.reset();
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
    this.renderQueuedFrameRevision = undefined;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
    this.terminal.dispose();
  }

  /**
   * Track DEC synchronized-update boundaries while feeding the native parser.
   * The prefix matcher is carried across reads because zigpty may split either
   * boundary at any byte. Capability query `ESC[?2026$p` never ends with h/l so
   * it does not open or close a frame.
   *
   * Each matching end is fed and snapshotted before any later bytes are fed. This
   * makes completion an explicit publication revision rather than an inference
   * from the final open/closed state of the whole PTY chunk.
   */
  private processSynchronizedFrameOutput(data: string | Uint8Array): {
    started: boolean;
    publishedRevision: number | undefined;
  } {
    let markerLength = this.synchronizedFrameMarkerLength;
    let frameOpen = this.synchronizedFrameOpen;
    let frameStarted = false;
    let publishedRevision: number | undefined;
    let feedStart = 0;

    for (let index = 0; index < data.length; index++) {
      const byte = typeof data === "string" ? data.charCodeAt(index) : data[index]!;

      if (markerLength < SYNCHRONIZED_FRAME_PREFIX.length) {
        if (byte === SYNCHRONIZED_FRAME_PREFIX.charCodeAt(markerLength)) {
          markerLength += 1;
          continue;
        }
        markerLength = byte === SYNCHRONIZED_FRAME_ESCAPE ? 1 : 0;
        continue;
      }

      if (byte === SYNCHRONIZED_FRAME_START_FINAL) {
        frameOpen = true;
        frameStarted = true;
      } else if (byte === SYNCHRONIZED_FRAME_END_FINAL) {
        if (frameOpen) {
          this.feedTerminalRange(data, feedStart, index + 1);
          feedStart = index + 1;
          publishedRevision = this.publishCompletedFrame();
        }
        frameOpen = false;
      }
      markerLength = byte === SYNCHRONIZED_FRAME_ESCAPE ? 1 : 0;
    }

    this.feedTerminalRange(data, feedStart, data.length);
    this.synchronizedFrameMarkerLength = markerLength;
    this.synchronizedFrameOpen = frameOpen;
    return { started: frameStarted, publishedRevision };
  }

  private feedTerminalRange(data: string | Uint8Array, start: number, end: number): void {
    if (start >= end) return;
    const range = typeof data === "string" ? data.slice(start, end) : data.subarray(start, end);
    this.terminal.feed(range);
    this.observeCursorVisibility(range);
    this.contentGeneration += 1;
  }

  /** Track DEC private mode 25 across arbitrary PTY chunk/frame boundaries. */
  private observeCursorVisibility(data: string | Uint8Array): void {
    for (let index = 0; index < data.length; index++) {
      const byte = typeof data === "string" ? data.charCodeAt(index) : data[index]!;
      if (this.cursorControlState === "ground") {
        if (byte === 0x1b) this.cursorControlState = "escape";
        else if (byte === 0x9b) this.beginCursorCsi();
        continue;
      }
      if (this.cursorControlState === "escape") {
        if (byte === 0x5b || byte === 0x9b) this.beginCursorCsi();
        else this.cursorControlState = byte === 0x1b ? "escape" : "ground";
        continue;
      }

      if (byte >= 0x30 && byte <= 0x3f) {
        if (this.cursorCsiParameters.length < 128) {
          this.cursorCsiParameters += String.fromCharCode(byte);
        } else {
          this.cursorCsiValid = false;
        }
      } else if (byte >= 0x20 && byte <= 0x2f) {
        this.cursorCsiValid = false;
      } else if (byte >= 0x40 && byte <= 0x7e) {
        if (
          this.cursorCsiValid &&
          (byte === SYNCHRONIZED_FRAME_START_FINAL || byte === SYNCHRONIZED_FRAME_END_FINAL) &&
          this.cursorCsiParameters.startsWith("?") &&
          this.cursorCsiParameters.slice(1).split(";").includes("25")
        ) {
          this.childCursorVisible = byte === SYNCHRONIZED_FRAME_START_FINAL;
        }
        this.cursorControlState = "ground";
      } else if (byte === 0x1b) {
        this.cursorControlState = "escape";
      }
    }
  }

  private beginCursorCsi(): void {
    this.cursorControlState = "csi";
    this.cursorCsiParameters = "";
    this.cursorCsiValid = true;
  }

  /** Capture content and cursor from one synchronously stable libghostty state. */
  private captureRenderedLines(): string[] {
    // Exclusive split rendering retains its existing direct-frame behavior; the
    // synthetic cursor is only part of float/embed composition.
    if (this.exclusiveFrame) {
      this.renderedCursor = undefined;
      return renderGhosttyHtml(this.formatTerminalHtml(), this.columns, this.rows);
    }
    const snapshot = this.terminal.snapshot();
    const html = this.formatTerminalHtml();
    this.renderedCursor = {
      visible: this.childCursorVisible,
      row: snapshot.cursorRow,
      column: snapshot.cursorCol,
    };
    return renderGhosttyHtml(html, this.columns, this.rows);
  }

  /** Apply focus-only cursor styling without mutating the complete-frame cache. */
  private composeRenderedLines(): string[] {
    const lines = this.renderedLines ?? [];
    const cursor = this.renderedCursor;
    if (
      this.exclusiveFrame ||
      !this.isFocused() ||
      !cursor?.visible ||
      cursor.row < 0 ||
      cursor.row >= lines.length
    ) {
      return lines;
    }
    const composed = lines.slice();
    composed[cursor.row] = paintTerminalCursor(composed[cursor.row]!, cursor.column);
    return composed;
  }

  private publishCompletedFrame(): number {
    this.renderedLines = this.captureRenderedLines();
    this.renderedGeneration = this.contentGeneration;
    this.renderedColumns = this.columns;
    this.renderedRows = this.rows;
    this.publishedFrameRevision += 1;
    return this.publishedFrameRevision;
  }

  private observeStartupOutput(frame: {
    started: boolean;
    publishedRevision: number | undefined;
  }): void {
    if (frame.publishedRevision !== undefined) {
      this.markStartupReady();
      return;
    }
    if (frame.started) {
      // Capability negotiation may have armed the no-sync fallback first. Once
      // Hunk starts a real synchronized frame, wait for its matching reset and
      // restore the bounded startup deadline instead of exposing it mid-paint.
      this.clearStartupTimer();
      this.armStartupDeadline();
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
    if (
      this.startupFrameDeadlineMs <= 0 ||
      (this.startupState !== "waiting" && this.startupState !== "fallback")
    ) {
      return;
    }
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
    this.clearStartupTimers();
    // Synchronized completion already publishes atomically. The no-sync
    // fallback needs the same complete cache before any later frame can open.
    if (!this.renderedLines && !this.synchronizedFrameOpen) {
      this.renderedLines = this.captureRenderedLines();
      this.renderedGeneration = this.contentGeneration;
      this.renderedColumns = this.columns;
      this.renderedRows = this.rows;
    }
  }

  private failStartupFrameDeadline(): void {
    if (
      !this.isRunning() ||
      (this.startupState !== "waiting" && this.startupState !== "fallback")
    ) {
      return;
    }
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
    this.exclusiveFrame?.revoke("child-completed");
    this.mouseInput.reset();
    this.renderQueued = false;
    this.renderQueuedFrameRevision = undefined;
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
  private requestFrame(publishedRevision?: number): void {
    // Ordinary output cannot publish while a synchronized child frame is open.
    // A captured completion can: renderCurrentLines will use its safe snapshot
    // even if a following frame has opened before this paint runs.
    if (this.synchronizedFrameOpen && publishedRevision === undefined) return;
    if (this.exclusiveFrame?.requestDirectPaint(() => this.directFrame())) return;
    this.scheduleRender(publishedRevision);
  }

  private scheduleRender(publishedRevision?: number): void {
    if (!this.isVisibleState() || !this.isRunning()) return;
    if (this.synchronizedFrameOpen && publishedRevision === undefined) return;
    if (publishedRevision !== undefined) {
      this.renderQueuedFrameRevision = Math.max(
        this.renderQueuedFrameRevision ?? 0,
        publishedRevision,
      );
    }
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      const queuedFrameRevision = this.renderQueuedFrameRevision;
      this.renderQueued = false;
      this.renderQueuedFrameRevision = undefined;
      const hasQueuedSnapshot =
        queuedFrameRevision !== undefined &&
        this.publishedFrameRevision >= queuedFrameRevision &&
        this.renderedLines !== undefined;
      if (
        (!this.synchronizedFrameOpen || hasQueuedSnapshot) &&
        this.isVisibleState() &&
        this.isRunning()
      ) {
        this.tui.requestRender();
      }
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
    // Resize the published rows without consulting the native terminal, which
    // may currently contain a partial synchronized update. Their stale content
    // generation forces a fresh snapshot once the buffer is safe again.
    if (this.renderedLines) {
      this.renderedLines = resizeRenderedLines(this.renderedLines, columns, rows);
      this.renderedColumns = columns;
      this.renderedRows = rows;
    }
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
