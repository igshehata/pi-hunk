import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
// Type-only import: erased at compile time so zigpty / libghostty are NOT
// pulled into the module graph at extension startup. The value is loaded lazily
// inside open() via loadEmbedded so a broken native build fails over instead of
// crashing extension load for every user (see #14).
import type { EmbeddedOptions, HunkExit } from "./embedded.ts";
import { resolveOverlayLayout, type HunkConfig } from "../config.ts";
import {
  argsKey,
  resolveOverlayRows,
  type OpenRequest,
  type SurfaceSessionInfo,
  type SurfaceState,
} from "./types.ts";
import {
  installExperimentalPiWrap,
  type ExperimentalPiWrapController,
} from "./experimental-pi-wrap.ts";

/**
 * Native Pi overlay surface with a persistent PTY toggle.
 *
 * State machine: closed -> starting -> visible <-> hidden -> closing -> closed
 *
 * Important Pi API notes (0.80.6):
 * - OverlayHandle.setHidden(true) moves focus away automatically.
 * - setHidden(false) focuses when nonCapturing=false.
 * - OverlayHandle.hide() removes THIS overlay entry from the stack.
 * - Factory `done()` for overlay mode calls global `ui.hideOverlay()`, which
 *   pops only the topmost overlay — not necessarily Hunk. After mount we
 *   therefore NEVER call `done()`. Permanent close and natural child exit both
 *   use the owned path: captured OverlayHandle.hide() + component.dispose().
 * - Leaving the internal custom() promise unresolved after owned removal is
 *   intentional: calling done() would risk removing a newer overlay above Hunk.
 *   We clear every extension-owned reference (handle, component, callbacks,
 *   start/close promises) so no global registration or resource remains.
 * - Before handle capture, cancellation must settle startPromise, dispose any
 *   locally created component, and bump generation so a late onHandle only
 *   hides the stale mount and never reattaches.
 */
export interface OverlayComponent extends Component {
  readonly pid?: number;
  setVisible(visible: boolean): void;
  dispose?(): void;
}

export type OverlayComponentFactory = (options: EmbeddedOptions) => OverlayComponent;
export type OverlayChildExitListener = (result: HunkExit) => void;
export type OverlayTransitionScheduler = <T>(operation: () => Promise<T>) => Promise<T>;

/** Minimal shape of the lazily-loaded embedded module. */
type EmbeddedModule = { EmbeddedHunk: new (options: EmbeddedOptions) => OverlayComponent };
type EmbeddedLoader = () => Promise<EmbeddedModule>;

/**
 * Cached dynamic import of the embedded PTY component. A rejected import (broken
 * native build) is not cached, so a later open() can retry; the rejection
 * propagates out of open() so the coordinator's fallback chain engages.
 */
let embeddedModulePromise: Promise<EmbeddedModule> | null = null;
function defaultLoadEmbedded(): Promise<EmbeddedModule> {
  if (!embeddedModulePromise) {
    embeddedModulePromise = import("./embedded.ts").then(
      (mod) => mod as unknown as EmbeddedModule,
      (error) => {
        embeddedModulePromise = null;
        throw error;
      },
    );
  }
  return embeddedModulePromise;
}

export interface OverlaySurfaceOptions {
  /** Milliseconds to wait for the overlay handle before failing open(). */
  startTimeoutMs?: number;
  /** Injectable embedded-module loader (tests / alternate builds). */
  loadEmbedded?: EmbeddedLoader;
  /** Notified after every surface state transition (see coordinator.onStateChange). */
  onStateChange?: () => void;
  /** Notified only for natural child PTY exits, before the surface closes. */
  onChildExit?: OverlayChildExitListener;
  /** Pass-through deadline for EmbeddedHunk's first terminal frame. */
  startupFrameDeadlineMs?: number;
}

/** Default handle-capture timeout: without this, a stuck custom() bricks the opChain. */
const DEFAULT_START_TIMEOUT_MS = 5000;
const NOTIFICATION_DETAIL_MAX_CHARS = 500;
const NOTIFICATION_DETAIL_MAX_LINES = 4;

type SurfaceRequestIntent = "ensure" | "toggle";
type SessionRelation = "same" | "different";
type SurfaceRequestAction =
  | "wait-start"
  | "wait-close"
  | "open"
  | "replace"
  | "focus"
  | "show"
  | "hide";
type SurfaceRequestTransitions = Record<
  SurfaceRequestIntent,
  Record<SessionRelation, SurfaceRequestAction>
>;

/**
 * Request state machine. Session identity and visibility are independent: an
 * H/S chord first selects its requested argv, then toggles only when that same
 * session is already active.
 */
const SURFACE_REQUEST_TRANSITIONS: Record<SurfaceState, SurfaceRequestTransitions> = {
  closed: {
    ensure: { same: "open", different: "open" },
    toggle: { same: "open", different: "open" },
  },
  starting: {
    ensure: { same: "wait-start", different: "wait-start" },
    toggle: { same: "wait-start", different: "wait-start" },
  },
  visible: {
    ensure: { same: "focus", different: "replace" },
    toggle: { same: "hide", different: "replace" },
  },
  hidden: {
    ensure: { same: "show", different: "replace" },
    toggle: { same: "show", different: "replace" },
  },
  closing: {
    ensure: { same: "wait-close", different: "wait-close" },
    toggle: { same: "wait-close", different: "wait-close" },
  },
};

const ALLOWED_STATE_TRANSITIONS: Record<SurfaceState, readonly SurfaceState[]> = {
  closed: ["starting"],
  starting: ["visible", "hidden", "closing", "closed"],
  visible: ["hidden", "closing"],
  hidden: ["visible", "closing"],
  closing: ["closed"],
};

export class OverlaySurface {
  private state: SurfaceState = "closed";
  private generation = 0;
  /**
   * Component factory. When undefined (production default), it is resolved lazily
   * on first open() from the dynamically-imported embedded module and cached here.
   * Tests inject a fake factory directly.
   */
  private createComponent: OverlayComponentFactory | undefined;
  private readonly loadEmbedded: EmbeddedLoader;
  private readonly startTimeoutMs: number;
  private readonly startupFrameDeadlineMs: number | undefined;
  private stateListener: (() => void) | undefined;
  private childExitListener: OverlayChildExitListener | undefined;
  private transitionScheduler: OverlayTransitionScheduler | undefined;
  private handle: OverlayHandle | undefined;
  private component: OverlayComponent | undefined;
  private currentPid: number | undefined;
  private experimentalPiWrap: ExperimentalPiWrapController | undefined;
  private currentArgsKey: string | undefined;
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private settleStart: ((error?: unknown) => void) | null = null;
  private settleClose: (() => void) | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(createComponent?: OverlayComponentFactory, options: OverlaySurfaceOptions = {}) {
    this.createComponent = createComponent;
    this.loadEmbedded = options.loadEmbedded ?? defaultLoadEmbedded;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.startupFrameDeadlineMs = options.startupFrameDeadlineMs;
    this.stateListener = options.onStateChange;
    this.childExitListener = options.onChildExit;
  }

  /**
   * Register a single listener notified after every state transition — including
   * component-initiated hides (onToggleRequest) and natural child exit. The
   * coordinator wires this to its onStateChange fan-out.
   */
  setStateListener(listener: (() => void) | undefined): void {
    this.stateListener = listener;
  }

  setChildExitListener(listener: OverlayChildExitListener | undefined): void {
    this.childExitListener = listener;
  }

  /** Route focused-component actions through the coordinator lifecycle queue. */
  setTransitionScheduler(scheduler: OverlayTransitionScheduler | undefined): void {
    this.transitionScheduler = scheduler;
  }

  private scheduleTransition<T>(operation: () => Promise<T>): Promise<T> {
    return this.transitionScheduler ? this.transitionScheduler(operation) : operation();
  }

  private transitionState(next: SurfaceState): void {
    if (next === this.state) return;
    if (!ALLOWED_STATE_TRANSITIONS[this.state].includes(next)) {
      throw new Error(`Invalid Hunk overlay state transition: ${this.state} -> ${next}.`);
    }
    this.state = next;
  }

  private sessionRelation(request: OpenRequest): SessionRelation {
    return this.currentArgsKey === argsKey(request.command, request.args) ? "same" : "different";
  }

  private async dispatchRequest(
    intent: SurfaceRequestIntent,
    ctx: ExtensionContext,
    request: OpenRequest,
    config: HunkConfig,
  ): Promise<void> {
    const action = SURFACE_REQUEST_TRANSITIONS[this.state][intent][this.sessionRelation(request)];

    switch (action) {
      case "wait-start": {
        if (!this.startPromise) {
          throw new Error("Hunk overlay entered starting without a start transition.");
        }
        await this.startPromise;
        return this.dispatchRequest(intent, ctx, request, config);
      }
      case "wait-close": {
        if (!this.closePromise) {
          throw new Error("Hunk overlay entered closing without a close transition.");
        }
        await this.closePromise;
        return this.dispatchRequest(intent, ctx, request, config);
      }
      case "open":
        await this.open(ctx, request, config);
        return;
      case "replace":
        await this.close();
        await this.open(ctx, request, config);
        return;
      case "focus":
        await this.focus();
        return;
      case "show":
        await this.show();
        return;
      case "hide":
        await this.hide();
        return;
    }
  }

  private emitStateChange(): void {
    try {
      this.stateListener?.();
    } catch {
      // A misbehaving listener must never corrupt surface state.
    }
  }

  private emitChildExit(result: HunkExit): void {
    try {
      this.childExitListener?.(result);
    } catch {
      // A misbehaving listener must never corrupt surface state.
    }
  }

  getState(): SurfaceState {
    return this.state;
  }

  isLive(): boolean {
    return this.state === "visible" || this.state === "hidden" || this.state === "starting";
  }

  getInfo(): SurfaceSessionInfo | null {
    if (!this.isLive() && this.state !== "closing") return null;
    return {
      state: this.state,
      argsKey: this.currentArgsKey ?? "",
      pid: this.currentPid,
      detail: this.state,
    };
  }

  async ensure(ctx: ExtensionContext, request: OpenRequest, config: HunkConfig): Promise<void> {
    await this.dispatchRequest(
      request.source === "shortcut" ? "toggle" : "ensure",
      ctx,
      request,
      config,
    );
  }

  async open(ctx: ExtensionContext, request: OpenRequest, config: HunkConfig): Promise<void> {
    if (this.startPromise) {
      await this.startPromise;
      // After concurrent start settles, ensure/show if same args.
      if (this.isLive() && this.currentArgsKey === argsKey(request.command, request.args)) {
        if (this.state === "hidden") await this.show();
        return;
      }
      if (this.isLive()) await this.close();
    }

    if (this.state !== "closed") {
      await this.close();
    }

    // Resolve the embedded factory BEFORE any state mutation. When a factory is
    // already available (injected in tests, or cached from a prior open) this is
    // fully synchronous, so a caller observing state right after open() still
    // sees "starting". Only the production lazy path awaits the dynamic import;
    // a failed import rejects open() with state still "closed" so the
    // coordinator's fallback chain engages cleanly (#14).
    let createComponent = this.createComponent;
    if (!createComponent) {
      const mod = await this.loadEmbedded();
      createComponent = (options) => new mod.EmbeddedHunk(options);
      this.createComponent = createComponent;
    }

    this.transitionState("starting");
    const gen = ++this.generation;
    this.currentArgsKey = argsKey(request.command, request.args);

    let startSettled = false;
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.settleStart = (error?: unknown) => {
        if (startSettled) return;
        startSettled = true;
        this.settleStart = null;
        this.clearStartTimer();
        if (error !== undefined) reject(error);
        else resolve();
      };
    });

    // Start-handle watchdog: onHandle (or custom() rejecting) is the only thing
    // that settles startPromise. If neither fires, open() would hang forever and
    // brick the coordinator's opChain for the whole session. On timeout we run
    // the pre-mount cancellation path (generation bump so a late onHandle only
    // hides the stale mount) and reject open() (#10).
    this.armStartTimer(gen);

    let closeSettled = false;
    this.closePromise = new Promise<void>((resolve) => {
      this.settleClose = () => {
        if (closeSettled) return;
        closeSettled = true;
        this.settleClose = null;
        resolve();
      };
    });

    try {
      const overlay = config.overlay;
      const geometry = resolveOverlayLayout(overlay.layout);
      // Fire-and-forget: we deliberately do not use custom()'s promise as the
      // surface lifetime. After mount, done() is unsafe (global hideOverlay).
      void ctx.ui
        .custom<HunkExit>(
          (tui, _theme, _keybindings, _done) => {
            if (gen !== this.generation) {
              // Stale factory — return an inert shell; onHandle will hide if mounted.
              return {
                render: () => [],
                invalidate: () => undefined,
                dispose: () => undefined,
              };
            }

            try {
              this.experimentalPiWrap = installExperimentalPiWrap(
                tui,
                overlay.layout,
                overlay.experimentalPiWrap,
              );
            } catch (error) {
              this.experimentalPiWrap = undefined;
              ctx.ui.notify(
                `Experimental Pi word wrap is unavailable: ${error instanceof Error ? error.message : String(error)}`,
                "warning",
              );
            }
            const initialRows = resolveOverlayRows(geometry.maxHeight, tui.terminal.rows);
            const component = createComponent({
              command: request.command,
              args: request.args,
              cwd: request.cwd,
              tui,
              initialRows,
              resolveRows: (terminalRows) => resolveOverlayRows(geometry.maxHeight, terminalRows),
              resolveMouseViewport: (
                terminalColumns,
                terminalRows,
                overlayColumns,
                overlayRows,
              ) => {
                const column =
                  geometry.anchor === "right-center"
                    ? Math.max(0, terminalColumns - overlayColumns)
                    : geometry.anchor === "center"
                      ? Math.max(0, Math.floor((terminalColumns - overlayColumns) / 2))
                      : 0;
                const visualRow = Math.max(0, Math.floor((terminalRows - overlayRows) / 2));
                // OpenTUI's embedded mouse row lands one line above the pointer
                // when a Pi overlay has a non-zero vertical origin. Compensate
                // only for vertically offset (float) panes; full/left/right stay
                // at row zero and already align.
                const row = visualRow > 0 ? visualRow - 1 : 0;
                return { column, row, width: overlayColumns, height: overlayRows };
              },
              startupFrameDeadlineMs: this.startupFrameDeadlineMs,
              // The visible overlay owns keyboard focus, so Pi's shortcut
              // dispatch never sees the dedicated prefix. The component must
              // intercept prefix+h/s and hand control back here.
              prefixKey: config.bindings.prefix,
              toggleKey: config.bindings.toggle,
              onToggleRequest: () => {
                if (gen !== this.generation) return;
                void this.scheduleTransition(async () => {
                  if (gen !== this.generation) return;
                  await this.ensure(
                    ctx,
                    {
                      ...request,
                      args: config.hunk.args,
                      source: "shortcut",
                    },
                    config,
                  );
                }).catch((error) => {
                  ctx.ui.notify(
                    `Hunk toggle failed: ${error instanceof Error ? error.message : String(error)}`,
                    "error",
                  );
                });
              },
              showKey: config.bindings.show,
              onShowRequest: () => {
                if (gen !== this.generation) return;
                void this.scheduleTransition(async () => {
                  if (gen !== this.generation) return;
                  await this.ensure(
                    ctx,
                    { ...request, args: ["show"], source: "shortcut" },
                    config,
                  );
                }).catch((error) => {
                  ctx.ui.notify(
                    `Hunk show failed: ${error instanceof Error ? error.message : String(error)}`,
                    "error",
                  );
                });
              },
              done: (result) => {
                if (gen !== this.generation) return;
                this.onChildDone(gen, result, ctx);
              },
            });
            this.component = component;
            const pid = component.pid;
            this.currentPid =
              pid !== undefined && Number.isInteger(pid) && pid > 0 ? pid : undefined;
            return component;
          },
          {
            overlay: true,
            overlayOptions: {
              anchor: geometry.anchor,
              width: geometry.width,
              maxHeight: geometry.maxHeight,
              margin: 0,
            },
            onHandle: (handle) => {
              if (gen !== this.generation) {
                // Cancelled before mount completed — remove only this entry.
                try {
                  handle.hide();
                } catch {
                  // ignore
                }
                return;
              }
              this.handle = handle;
              this.component?.setVisible(true);
              // setHidden(false) auto-focuses when nonCapturing is false.
              if (handle.isHidden()) handle.setHidden(false);
              this.transitionState("visible");
              this.settleStart?.();
              this.emitStateChange();
            },
          },
        )
        .catch((error) => {
          // custom() rejected before/without onHandle (factory/PTY throw).
          if (gen === this.generation && this.state === "starting") {
            this.settleStart?.(error);
          }
        });

      // Wait only until the handle is captured (or failure/cancel), not child exit.
      await this.startPromise;

      // close() during pre-mount settles start without error so open() never hangs.
      // Treat a superseded/cancelled generation as a completed no-op, not a live open.
      if (gen !== this.generation || !this.isLive()) {
        return;
      }
    } catch (error) {
      if (gen === this.generation) {
        this.forceReset(gen);
      }
      throw error;
    } finally {
      if (gen === this.generation) this.startPromise = null;
    }
  }

  async show(): Promise<void> {
    if (this.state === "visible") {
      await this.focus();
      return;
    }
    if (this.state !== "hidden" || !this.handle) return;
    this.experimentalPiWrap?.setVisible(true);
    this.handle.setHidden(false);
    this.component?.setVisible(true);
    this.transitionState("visible");
    this.emitStateChange();
  }

  async hide(): Promise<void> {
    if (this.state !== "visible" || !this.handle) return;
    this.component?.setVisible(false);
    this.experimentalPiWrap?.setVisible(false);
    this.handle.setHidden(true);
    this.transitionState("hidden");
    this.emitStateChange();
  }

  async toggle(ctx: ExtensionContext, request: OpenRequest, config: HunkConfig): Promise<void> {
    await this.dispatchRequest("toggle", ctx, request, config);
  }

  async focus(): Promise<void> {
    if (!this.handle || this.state === "closed" || this.state === "closing") return;
    if (this.state === "hidden") {
      await this.show();
      return;
    }
    try {
      this.handle.focus();
    } catch {
      // Focus may fail if the overlay was removed concurrently.
    }
  }

  /** The overlay PTY is always owned by this instance, so release disposes it. */
  async release(): Promise<boolean> {
    if (this.state === "closed") return false;
    await this.close();
    return true;
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    if (this.state === "closing") {
      if (this.closePromise) {
        try {
          await this.closePromise;
        } catch {
          // ignore
        }
      }
      return;
    }

    const gen = this.generation;
    this.transitionState("closing");
    try {
      this.component?.setVisible(false);
    } catch {
      // ignore
    }

    if (this.handle) {
      // Mounted permanent close: owned handle + dispose. Never call done().
      this.removeOwned(gen);
      return;
    }

    // Pre-mount cancellation: invalidate callbacks, dispose local component,
    // settle start so open() cannot hang, and leave custom() unresolved.
    this.cancelBeforeMount(gen);
  }

  /**
   * Natural child exit:
   * - After mount: same owned-handle removal path as permanent close so a
   *   stacked dialog above Hunk is never removed by global hideOverlay().
   * - Before onHandle: pre-mount cancellation path so generation is invalidated
   *   and a late onHandle only hides the stale entry without resurrecting state.
   */
  private onChildDone(gen: number, result: HunkExit, ctx: ExtensionContext): void {
    if (gen !== this.generation || this.state === "closed" || this.state === "closing") return;
    const hadPresented = this.state === "visible" || this.state === "hidden";
    if (!hadPresented) {
      this.transitionState("closing");
      this.cancelBeforeMount(gen, new Error(formatHunkExitBeforeStartup(result)));
      return;
    }

    const message = formatUnexpectedHunkExit(result);
    this.emitChildExit(result);
    this.transitionState("closing");
    if (message) {
      try {
        ctx.ui.notify(message, "error");
      } catch {
        // Notification failure must not leave the PTY surface half-closed.
      }
    }
    if (this.handle) {
      this.removeOwned(gen);
      return;
    }
    // Child finished after presentation but before the overlay handle was observed.
    this.cancelBeforeMount(gen, message ? new Error(message) : undefined);
  }

  private removeOwned(gen: number): void {
    if (gen !== this.generation) return;

    const handle = this.handle;
    const component = this.component;
    // Drop refs first so re-entrant callbacks cannot observe a half-closed surface.
    this.handle = undefined;
    this.component = undefined;

    if (handle) {
      try {
        handle.hide();
      } catch {
        // ignore
      }
    }
    try {
      component?.dispose?.();
    } catch {
      // ignore
    }

    this.finishClosed(gen);
  }

  private cancelBeforeMount(gen: number, startError?: unknown): void {
    if (gen !== this.generation) return;

    // Invalidate late onHandle / child done for this generation.
    this.generation += 1;

    const component = this.component;
    const handle = this.handle;
    this.component = undefined;
    this.handle = undefined;

    try {
      handle?.hide();
    } catch {
      // ignore
    }
    try {
      component?.dispose?.();
    } catch {
      // ignore
    }

    // Unblock any awaiters of open(); child exits before presentation are
    // startup failures with an actionable child diagnostic.
    this.settleStart?.(startError);
    this.finishClosed(this.generation);
  }

  private armStartTimer(gen: number): void {
    this.clearStartTimer();
    if (this.startTimeoutMs <= 0) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.failStartTimeout(gen);
    }, this.startTimeoutMs);
    // Do not keep the event loop alive purely for this watchdog.
    this.startTimer.unref?.();
  }

  private clearStartTimer(): void {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
  }

  /**
   * The overlay handle never arrived. Run the pre-mount cancellation path
   * (generation bump + dispose the local component) and reject open() so the
   * coordinator falls through to the next display mode instead of hanging.
   */
  private failStartTimeout(gen: number): void {
    if (gen !== this.generation || this.state !== "starting") return;

    // Invalidate a late onHandle / child done for this generation.
    this.generation += 1;
    const newGen = this.generation;

    const component = this.component;
    this.component = undefined;
    this.handle = undefined;
    try {
      component?.dispose?.();
    } catch {
      // ignore
    }

    // Reject open()'s awaiter; finishClosed then clears session bookkeeping.
    this.settleStart?.(new Error(`Hunk overlay did not start within ${this.startTimeoutMs}ms`));
    this.finishClosed(newGen);
  }

  private forceReset(gen: number): void {
    if (gen !== this.generation) return;
    const component = this.component;
    const handle = this.handle;
    this.component = undefined;
    this.handle = undefined;
    try {
      handle?.hide();
    } catch {
      // ignore
    }
    try {
      component?.dispose?.();
    } catch {
      // ignore
    }
    this.finishClosed(gen);
  }

  private finishClosed(gen: number): void {
    if (gen !== this.generation) {
      // Still settle close waiters for the superseded generation.
      this.settleClose?.();
      return;
    }
    this.clearStartTimer();
    this.transitionState("closed");
    this.handle = undefined;
    this.component = undefined;
    this.currentPid = undefined;
    const experimentalPiWrap = this.experimentalPiWrap;
    this.experimentalPiWrap = undefined;
    try {
      experimentalPiWrap?.dispose();
    } catch {
      // Renderer restoration is best-effort and must not strand close waiters.
    }
    this.currentArgsKey = undefined;
    this.startPromise = null;
    this.settleStart = null;
    const settleClose = this.settleClose;
    this.closePromise = null;
    this.settleClose = null;
    settleClose?.();
    // Terminal transition for close / natural child exit / cancel / timeout.
    this.emitStateChange();
  }
}

function formatUnexpectedHunkExit(result: HunkExit): string | undefined {
  if (result.exitCode === 0 && (result.signal ?? 0) === 0) return undefined;
  const status = formatExitStatus(result);
  const detail = sanitizeNotificationDetail(result.detail);
  if (detail?.startsWith("Hunk startup failed:")) {
    return `${detail} (${status}).`;
  }
  return `Hunk exited unexpectedly (${status}).${detail ? `\n${detail}` : ""}`;
}

function formatHunkExitBeforeStartup(result: HunkExit): string {
  const status = formatExitStatus(result);
  const detail = sanitizeNotificationDetail(result.detail);
  return `Hunk exited before startup (${status}).${detail ? `\n${detail}` : ""}`;
}

function formatExitStatus(result: HunkExit): string {
  const status = [`code ${result.exitCode}`];
  if ((result.signal ?? 0) !== 0) status.push(`signal ${result.signal}`);
  return status.join(", ");
}

function sanitizeNotificationDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const lines = stripUnsafeControls(detail.replace(/\r\n?/g, "\n"))
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-NOTIFICATION_DETAIL_MAX_LINES);
  if (lines.length === 0) return undefined;
  let sanitized = lines.join("\n").trim();
  if (sanitized.length > NOTIFICATION_DETAIL_MAX_CHARS) {
    sanitized = `${sanitized.slice(0, NOTIFICATION_DETAIL_MAX_CHARS - 1)}…`;
  }
  return sanitized || undefined;
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
