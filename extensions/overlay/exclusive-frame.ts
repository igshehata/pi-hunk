import type { TUI, Terminal } from "@earendil-works/pi-tui";
import type { OverlayLayout } from "../config.ts";
import { DirectRectanglePainter, type PhysicalRectangle } from "./direct-rectangle.ts";

export type ExclusiveFrameLeaseState =
  | "inactive"
  | "reflowing"
  | "exclusive"
  | "revoking"
  | "restoring"
  | "disposed";

export interface HunkDirectFrame {
  ready: boolean;
  columns: number;
  rows: number;
  lines: readonly string[];
}

export interface ExclusiveFrameStats {
  state: ExclusiveFrameLeaseState;
  composedFrames: number;
  directFrames: number;
  directRows: number;
  directBytes: number;
  suppressedInputRenders: number;
  revocations: number;
  fallbackRequests: number;
  lastRevocation?: string;
}

export interface ExclusiveFrameController {
  setComponent(component: object): void;
  setFocusProbe(probe: (() => boolean) | undefined): void;
  setVisible(visible: boolean): void;
  setFocused(focused: boolean): void;
  observeCompositedFrame(frame: HunkDirectFrame): void;
  requestDirectPaint(readFrame: () => HunkDirectFrame): boolean;
  armPostInputRenderSuppression(): void;
  revoke(reason: string): void;
  getStats(): ExclusiveFrameStats;
  dispose(): void;
}

interface OverlayEntryLike {
  component?: unknown;
  hidden?: unknown;
  options?: {
    visible?: (width: number, height: number) => boolean;
  };
}

interface TuiRuntime {
  overlayStack?: OverlayEntryLike[];
  renderRequested?: boolean;
  renderTimer?: unknown;
  previousWidth?: number;
  previousHeight?: number;
  stopped?: boolean;
}

const FRAME_FAILURE_TERMINAL_RESTORE = "\x1b[0m\x1b]8;;\x07\x1b[?2026l\x1b[?6l\x1b[?7h\x1b[?25h";
const SHUTDOWN_TERMINAL_RESTORE =
  FRAME_FAILURE_TERMINAL_RESTORE + "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

export function installExclusiveFrame(
  tui: TUI,
  layout: OverlayLayout,
  enabled: boolean,
): ExclusiveFrameController | undefined {
  if (!enabled || (layout !== "left" && layout !== "right")) return undefined;

  const runtime = tui as unknown as TuiRuntime;
  if (
    !Array.isArray(runtime.overlayStack) ||
    typeof runtime.renderRequested !== "boolean" ||
    typeof runtime.previousWidth !== "number" ||
    typeof runtime.previousHeight !== "number" ||
    typeof runtime.stopped !== "boolean"
  ) {
    throw new Error("Pi's TUI internals are incompatible with the exclusive-frame experiment.");
  }

  const terminal = tui.terminal;
  const originalRequestRender = tui.requestRender;
  const originalInvalidate = tui.invalidate;
  const originalStop = tui.stop;
  const originalWrite = terminal.write;
  const originalMoveBy = terminal.moveBy;
  const originalHideCursor = terminal.hideCursor;
  const originalShowCursor = terminal.showCursor;
  const originalClearLine = terminal.clearLine;
  const originalClearFromCursor = terminal.clearFromCursor;
  const originalClearScreen = terminal.clearScreen;

  let state: ExclusiveFrameLeaseState = "inactive";
  let visible = true;
  let focused = false;
  let component: object | undefined;
  let focusProbe: (() => boolean) | undefined;
  let candidate: HunkDirectFrame | undefined;
  let generation = 0;
  let acquisitionQueued = false;
  let paintQueued = false;
  let pendingFrameReader: (() => HunkDirectFrame) | undefined;
  let inputPermitGeneration: number | undefined;
  let forceQueued = false;
  let disposed = false;
  const stats: Omit<ExclusiveFrameStats, "state"> = {
    composedFrames: 0,
    directFrames: 0,
    directRows: 0,
    directBytes: 0,
    suppressedInputRenders: 0,
    revocations: 0,
    fallbackRequests: 0,
  };

  const writeDirect = (data: string): void => originalWrite.call(terminal, data);
  const painter = new DirectRectanglePainter(writeDirect);

  const rectangleFor = (frame: HunkDirectFrame): PhysicalRectangle | undefined => {
    const terminalColumns = terminal.columns;
    const terminalRows = terminal.rows;
    if (terminalColumns < 2 || terminalRows < 1) return undefined;
    const expectedWidth = Math.floor(terminalColumns / 2);
    if (
      frame.columns !== expectedWidth ||
      frame.rows !== terminalRows ||
      frame.lines.length > frame.rows
    ) {
      return undefined;
    }
    return {
      row: 0,
      column: layout === "right" ? terminalColumns - frame.columns : 0,
      width: frame.columns,
      height: frame.rows,
      terminalColumns,
      terminalRows,
    };
  };

  const ownsMethods = (): boolean =>
    tui.requestRender === wrappedRequestRender &&
    tui.invalidate === wrappedInvalidate &&
    tui.stop === wrappedStop &&
    terminal.write === wrappedWrite &&
    terminal.moveBy === wrappedMoveBy &&
    terminal.hideCursor === wrappedHideCursor &&
    terminal.showCursor === wrappedShowCursor &&
    terminal.clearLine === wrappedClearLine &&
    terminal.clearFromCursor === wrappedClearFromCursor &&
    terminal.clearScreen === wrappedClearScreen;

  const hasForeignVisibleOverlay = (): boolean => {
    if (!component || !Array.isArray(runtime.overlayStack)) return true;
    for (const entry of runtime.overlayStack) {
      if (entry.component === component || entry.hidden === true) continue;
      const visibleWhen = entry.options?.visible;
      if (visibleWhen) {
        try {
          if (!visibleWhen(terminal.columns, terminal.rows)) continue;
        } catch {
          return true;
        }
      }
      return true;
    }
    return false;
  };

  const presentationEligible = (): boolean => {
    if (!visible || !focused || !component || !focusProbe) return false;
    try {
      if (!focusProbe()) return false;
    } catch {
      return false;
    }
    return !hasForeignVisibleOverlay();
  };

  const clearLease = (): void => {
    generation += 1;
    candidate = undefined;
    acquisitionQueued = false;
    paintQueued = false;
    pendingFrameReader = undefined;
    inputPermitGeneration = undefined;
    painter.reset();
  };

  const enterFallbackState = (): void => {
    state = presentationEligible() ? "reflowing" : "inactive";
  };

  const leaveExclusive = (reason: string): boolean => {
    if (state !== "exclusive") return false;
    state = "revoking";
    stats.revocations += 1;
    stats.lastRevocation = reason;
    clearLease();
    state = "restoring";
    enterFallbackState();
    return true;
  };

  const forceAuthoritativeRender = (): void => {
    if (disposed || runtime.stopped) return;
    forceQueued = false;
    originalRequestRender.call(tui, true);
  };

  const queueAuthoritativeRender = (): void => {
    if (disposed || runtime.stopped || forceQueued) return;
    forceQueued = true;
    queueMicrotask(() => {
      if (disposed || runtime.stopped || !forceQueued) return;
      forceAuthoritativeRender();
    });
  };

  const revokeAndQueueRender = (reason: string): void => {
    if (leaveExclusive(reason)) queueAuthoritativeRender();
  };

  const runtimeReady = (): boolean =>
    !disposed &&
    !runtime.stopped &&
    runtime.renderRequested === false &&
    runtime.renderTimer === undefined &&
    runtime.previousWidth === terminal.columns &&
    runtime.previousHeight === terminal.rows &&
    !forceQueued &&
    ownsMethods();

  const queueAcquisition = (): void => {
    if (acquisitionQueued || disposed) return;
    acquisitionQueued = true;
    const queuedGeneration = generation;
    queueMicrotask(() => {
      acquisitionQueued = false;
      if (disposed || queuedGeneration !== generation || state === "exclusive") return;
      const frame = candidate;
      const rectangle = frame && frame.ready ? rectangleFor(frame) : undefined;
      if (!frame || !rectangle || !presentationEligible() || !runtimeReady()) {
        enterFallbackState();
        return;
      }
      try {
        painter.seed(rectangle, frame.lines);
      } catch (error) {
        stats.lastRevocation =
          error instanceof Error ? `seed-failed: ${error.message}` : "seed-failed";
        painter.reset();
        enterFallbackState();
        return;
      }
      state = "exclusive";
    });
  };

  const observeFrame = (frame: HunkDirectFrame): void => {
    stats.composedFrames += 1;
    if (disposed || !frame.ready) return;
    candidate = { ...frame, lines: [...frame.lines] };
    if (state !== "exclusive" && presentationEligible()) {
      state = "reflowing";
      queueAcquisition();
    }
  };

  const runDirectPaint = (): void => {
    paintQueued = false;
    const readFrame = pendingFrameReader;
    pendingFrameReader = undefined;
    if (!readFrame || state !== "exclusive" || disposed) return;
    if (!presentationEligible() || !runtimeReady()) {
      stats.fallbackRequests += 1;
      revokeAndQueueRender("direct-paint-invariant");
      return;
    }

    try {
      const frame = readFrame();
      const rectangle = frame.ready ? rectangleFor(frame) : undefined;
      if (!rectangle) throw new Error("direct frame geometry is no longer valid");
      const result = painter.paint(rectangle, frame.lines);
      if (result.bytes > 0) stats.directFrames += 1;
      stats.directRows += result.changedRows;
      stats.directBytes += result.bytes;
    } catch (error) {
      stats.fallbackRequests += 1;
      stats.lastRevocation =
        error instanceof Error ? `direct-paint-failed: ${error.message}` : "direct-paint-failed";
      try {
        writeDirect(FRAME_FAILURE_TERMINAL_RESTORE);
      } catch {
        // The terminal may already be gone; authoritative Pi restoration remains best-effort.
      }
      revokeAndQueueRender("direct-paint-failed");
    }
  };

  const wrappedRequestRender: TUI["requestRender"] = function exclusiveRequestRender(
    force = false,
  ): void {
    if (disposed || state !== "exclusive") {
      originalRequestRender.call(tui, force);
      return;
    }

    if (!force && inputPermitGeneration === generation) {
      inputPermitGeneration = undefined;
      stats.suppressedInputRenders += 1;
      return;
    }

    leaveExclusive(force ? "forced-render" : "foreign-render-request");
    forceQueued = false;
    forceAuthoritativeRender();
  };

  const wrappedInvalidate: TUI["invalidate"] = function exclusiveInvalidate(): void {
    const revoked = leaveExclusive("tui-invalidate");
    try {
      originalInvalidate.call(tui);
    } finally {
      if (revoked) queueAuthoritativeRender();
    }
  };

  const shutdown = (): void => {
    if (disposed) return;
    disposed = true;
    state = "disposed";
    clearLease();
    forceQueued = false;
    try {
      writeDirect(SHUTDOWN_TERMINAL_RESTORE);
    } catch {
      // Ignore terminal teardown failures.
    }
    restoreMethods();
  };

  const wrappedStop: TUI["stop"] = function exclusiveStop(): void {
    shutdown();
    originalStop.call(tui);
  };

  const foreignTerminalMutation = (name: string): void => {
    if (state !== "exclusive") return;
    leaveExclusive(`terminal-${name}`);
    queueAuthoritativeRender();
  };

  const wrappedWrite: Terminal["write"] = function exclusiveTerminalWrite(data: string): void {
    foreignTerminalMutation("write");
    originalWrite.call(terminal, data);
  };
  const wrappedMoveBy: Terminal["moveBy"] = function exclusiveTerminalMoveBy(lines: number): void {
    foreignTerminalMutation("moveBy");
    originalMoveBy.call(terminal, lines);
  };
  const wrappedHideCursor: Terminal["hideCursor"] = function exclusiveTerminalHideCursor(): void {
    foreignTerminalMutation("hideCursor");
    originalHideCursor.call(terminal);
  };
  const wrappedShowCursor: Terminal["showCursor"] = function exclusiveTerminalShowCursor(): void {
    foreignTerminalMutation("showCursor");
    originalShowCursor.call(terminal);
  };
  const wrappedClearLine: Terminal["clearLine"] = function exclusiveTerminalClearLine(): void {
    foreignTerminalMutation("clearLine");
    originalClearLine.call(terminal);
  };
  const wrappedClearFromCursor: Terminal["clearFromCursor"] =
    function exclusiveTerminalClearFromCursor(): void {
      foreignTerminalMutation("clearFromCursor");
      originalClearFromCursor.call(terminal);
    };
  const wrappedClearScreen: Terminal["clearScreen"] =
    function exclusiveTerminalClearScreen(): void {
      foreignTerminalMutation("clearScreen");
      originalClearScreen.call(terminal);
    };

  function restoreMethods(): void {
    if (tui.requestRender === wrappedRequestRender) tui.requestRender = originalRequestRender;
    if (tui.invalidate === wrappedInvalidate) tui.invalidate = originalInvalidate;
    if (tui.stop === wrappedStop) tui.stop = originalStop;
    if (terminal.write === wrappedWrite) terminal.write = originalWrite;
    if (terminal.moveBy === wrappedMoveBy) terminal.moveBy = originalMoveBy;
    if (terminal.hideCursor === wrappedHideCursor) terminal.hideCursor = originalHideCursor;
    if (terminal.showCursor === wrappedShowCursor) terminal.showCursor = originalShowCursor;
    if (terminal.clearLine === wrappedClearLine) terminal.clearLine = originalClearLine;
    if (terminal.clearFromCursor === wrappedClearFromCursor) {
      terminal.clearFromCursor = originalClearFromCursor;
    }
    if (terminal.clearScreen === wrappedClearScreen) terminal.clearScreen = originalClearScreen;
  }

  try {
    tui.requestRender = wrappedRequestRender;
    tui.invalidate = wrappedInvalidate;
    tui.stop = wrappedStop;
    terminal.write = wrappedWrite;
    terminal.moveBy = wrappedMoveBy;
    terminal.hideCursor = wrappedHideCursor;
    terminal.showCursor = wrappedShowCursor;
    terminal.clearLine = wrappedClearLine;
    terminal.clearFromCursor = wrappedClearFromCursor;
    terminal.clearScreen = wrappedClearScreen;
  } catch (error) {
    disposed = true;
    state = "disposed";
    restoreMethods();
    throw error;
  }

  return {
    setComponent(nextComponent: object): void {
      if (disposed) return;
      component = nextComponent;
    },
    setFocusProbe(nextProbe: (() => boolean) | undefined): void {
      if (disposed) return;
      focusProbe = nextProbe;
      if (presentationEligible() && candidate) queueAcquisition();
    },
    setVisible(nextVisible: boolean): void {
      if (disposed || visible === nextVisible) return;
      visible = nextVisible;
      if (!visible) {
        revokeAndQueueRender("hidden");
        candidate = undefined;
        state = "inactive";
        return;
      }
      if (focused) {
        state = "reflowing";
        originalRequestRender.call(tui);
      }
    },
    setFocused(nextFocused: boolean): void {
      if (disposed || focused === nextFocused) return;
      focused = nextFocused;
      if (!focused) {
        revokeAndQueueRender("focus-lost");
        candidate = undefined;
        state = "inactive";
        return;
      }
      if (visible) {
        state = "reflowing";
        originalRequestRender.call(tui);
      }
    },
    observeCompositedFrame: observeFrame,
    requestDirectPaint(readFrame: () => HunkDirectFrame): boolean {
      if (disposed || state !== "exclusive") return false;
      if (!presentationEligible() || !ownsMethods()) {
        stats.fallbackRequests += 1;
        revokeAndQueueRender("direct-request-invariant");
        return false;
      }
      pendingFrameReader = readFrame;
      if (!paintQueued) {
        paintQueued = true;
        queueMicrotask(runDirectPaint);
      }
      return true;
    },
    armPostInputRenderSuppression(): void {
      if (disposed || state !== "exclusive") return;
      const permitGeneration = generation;
      inputPermitGeneration = permitGeneration;
      queueMicrotask(() => {
        if (inputPermitGeneration === permitGeneration) inputPermitGeneration = undefined;
      });
    },
    revoke(reason: string): void {
      revokeAndQueueRender(reason);
    },
    getStats(): ExclusiveFrameStats {
      return { state, ...stats };
    },
    dispose(): void {
      if (disposed) return;
      const needsAuthoritativeRender = state === "exclusive" || forceQueued;
      if (state === "exclusive") leaveExclusive("dispose");
      disposed = true;
      state = "disposed";
      clearLease();
      forceQueued = false;
      restoreMethods();
      if (needsAuthoritativeRender && !runtime.stopped) tui.requestRender(true);
    },
  };
}
