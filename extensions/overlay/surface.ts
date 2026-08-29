import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { TakeoverHunk } from "./takeover.ts";
import {
  argsKey,
  type HunkExit,
  type OpenRequest,
  type SurfaceSessionInfo,
  type SurfaceState,
} from "./types.ts";

export type SurfaceChildExitListener = (result: HunkExit) => Promise<void> | void;
export type SurfaceReplacementGuard = () => Promise<void>;

export interface OverlaySurfaceOptions {
  onStateChange?: () => void;
  onChildExit?: SurfaceChildExitListener;
}

const ALLOWED_STATE_TRANSITIONS: Record<SurfaceState, readonly SurfaceState[]> = {
  closed: ["starting"],
  starting: ["visible", "closing", "closed"],
  visible: ["closing"],
  closing: ["closed"],
};

/** One full-screen Hunk process with no embedded renderer or persistent PTY. */
export class OverlaySurface {
  private state: SurfaceState = "closed";
  private generation = 0;
  private stateListener: (() => void) | undefined;
  private childExitListener: SurfaceChildExitListener | undefined;
  private replacementGuard: SurfaceReplacementGuard | undefined;
  private component: TakeoverHunk | undefined;
  private currentPid: number | undefined;
  private currentLaunchCwd: string | undefined;
  private currentSource: OpenRequest["source"] | undefined;
  private currentSessionId: string | undefined;
  private currentRepoRoot: string | undefined;
  private currentFileCount: number | undefined;
  private currentArgsKey: string | undefined;
  private startPromise: Promise<void> | null = null;
  private settleStart: ((error?: unknown) => void) | null = null;
  private closePromise: Promise<void> | null = null;
  private settleClose: (() => void) | null = null;

  constructor(options: OverlaySurfaceOptions = {}) {
    this.stateListener = options.onStateChange;
    this.childExitListener = options.onChildExit;
  }

  setStateListener(listener: (() => void) | undefined): void {
    this.stateListener = listener;
  }

  setChildExitListener(listener: SurfaceChildExitListener | undefined): void {
    this.childExitListener = listener;
  }

  setReplacementGuard(guard: SurfaceReplacementGuard | undefined): void {
    this.replacementGuard = guard;
  }

  getState(): SurfaceState {
    return this.state;
  }

  isLive(): boolean {
    return this.state === "starting" || this.state === "visible";
  }

  getInfo(): SurfaceSessionInfo | null {
    if (this.state === "closed") return null;
    return {
      state: this.state,
      argsKey: this.currentArgsKey ?? "",
      launchCwd: this.currentLaunchCwd ?? "",
      source: this.currentSource ?? "manual",
      pid: this.currentPid,
      sessionId: this.currentSessionId,
      repoRoot: this.currentRepoRoot,
      fileCount: this.currentFileCount,
      detail: "full-screen",
    };
  }

  /** Adopt authoritative metadata from the Hunk session with this exact child PID. */
  adoptManagedSession(metadata: {
    sessionId: string;
    pid: number;
    repoRoot?: string;
    fileCount: number;
  }): boolean {
    if (this.state !== "visible" || this.currentPid === undefined) return false;
    if (!Number.isInteger(metadata.pid) || metadata.pid <= 0 || metadata.pid !== this.currentPid) {
      return false;
    }
    this.currentSessionId = metadata.sessionId;
    this.currentRepoRoot = metadata.repoRoot;
    this.currentFileCount = metadata.fileCount;
    return true;
  }

  async ensure(ctx: ExtensionContext, request: OpenRequest): Promise<void> {
    if (this.state === "starting" && this.startPromise) await this.startPromise;
    if (this.state === "closing" && this.closePromise) await this.closePromise;

    if (this.state === "visible") {
      const requestedKey = argsKey(request.command, request.args, resolve(request.cwd));
      if (this.currentArgsKey === requestedKey) return;
      await this.replacementGuard?.();
      await this.close();
    }

    if (this.state === "closed") await this.open(ctx, request);
  }

  async open(ctx: ExtensionContext, request: OpenRequest): Promise<void> {
    if (ctx.mode !== "tui") {
      throw new Error("Hunk full-screen takeover requires Pi's interactive TUI mode.");
    }
    if (this.state !== "closed") {
      await this.ensure(ctx, request);
      return;
    }

    const generation = ++this.generation;
    this.currentLaunchCwd = resolve(request.cwd);
    this.currentSource = request.source;
    this.currentArgsKey = argsKey(request.command, request.args, this.currentLaunchCwd);
    this.currentPid = undefined;
    this.currentSessionId = undefined;
    this.currentRepoRoot = undefined;
    this.currentFileCount = undefined;
    this.transitionState("starting");

    let startSettled = false;
    this.startPromise = new Promise<void>((resolveStart, rejectStart) => {
      this.settleStart = (error?: unknown) => {
        if (startSettled) return;
        startSettled = true;
        this.settleStart = null;
        if (error === undefined) resolveStart();
        else rejectStart(error);
      };
    });

    let closeSettled = false;
    this.closePromise = new Promise<void>((resolveClose) => {
      this.settleClose = () => {
        if (closeSettled) return;
        closeSettled = true;
        this.settleClose = null;
        resolveClose();
      };
    });

    try {
      const customPromise = ctx.ui.custom<HunkExit>((tui, _theme, _keybindings, done) => {
        const component = new TakeoverHunk({
          command: request.command,
          args: request.args,
          cwd: this.currentLaunchCwd!,
          tui,
          onStart: (pid) => this.onStarted(generation, pid),
          onExit: (result) => {
            done(result);
            this.onChildDone(generation, result, ctx);
          },
        });
        this.component = component;
        return component;
      });
      void customPromise.catch((error) => this.onCustomFailure(generation, error));
      await this.startPromise;
    } catch (error) {
      if (generation === this.generation && this.state !== "closed") {
        this.component?.dispose();
        this.finishClosed(generation);
      }
      throw error;
    } finally {
      if (generation === this.generation) this.startPromise = null;
    }
  }

  /** The owned child cannot be hidden or detached, so release terminates it. */
  async release(): Promise<boolean> {
    if (this.state === "closed") return false;
    await this.close();
    return true;
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    if (this.state === "closing") {
      await this.closePromise;
      return;
    }

    const generation = this.generation;
    this.transitionState("closing");
    this.emitStateChange();
    const component = this.component;
    if (!component) {
      this.settleStart?.();
      this.finishClosed(generation);
      return;
    }
    component.dispose();
    await this.closePromise;
  }

  private onStarted(generation: number, pid: number): void {
    if (generation !== this.generation || this.state !== "starting") return;
    this.currentPid = pid;
    this.transitionState("visible");
    this.settleStart?.();
    this.emitStateChange();
  }

  private onCustomFailure(generation: number, error: unknown): void {
    if (generation !== this.generation || this.state === "closed") return;
    this.settleStart?.(error);
    this.finishClosed(generation);
  }

  private onChildDone(generation: number, result: HunkExit, ctx: ExtensionContext): void {
    if (generation !== this.generation || this.state === "closed") return;
    if (this.state === "starting") {
      const error = new Error(formatHunkExitBeforeStartup(result));
      this.settleStart?.(error);
      this.finishClosed(generation);
      return;
    }
    if (this.state === "closing") {
      this.finishClosed(generation);
      return;
    }

    this.transitionState("closing");
    this.emitStateChange();
    void this.finishNaturalExit(generation, result, ctx);
  }

  private async finishNaturalExit(
    generation: number,
    result: HunkExit,
    ctx: ExtensionContext,
  ): Promise<void> {
    try {
      await this.childExitListener?.(result);
    } catch {
      // The child already exited; teardown cannot be blocked by an observer.
    }
    if (generation !== this.generation || this.state !== "closing") return;

    const message = formatUnexpectedHunkExit(result);
    if (message) {
      try {
        ctx.ui.notify(message, "error");
      } catch {
        // Notification failure cannot retain a completed takeover.
      }
    }
    this.finishClosed(generation);
  }

  private finishClosed(generation: number): void {
    if (generation !== this.generation) return;
    if (this.state !== "closed") this.transitionState("closed");
    this.component = undefined;
    this.currentPid = undefined;
    this.currentLaunchCwd = undefined;
    this.currentSource = undefined;
    this.currentSessionId = undefined;
    this.currentRepoRoot = undefined;
    this.currentFileCount = undefined;
    this.currentArgsKey = undefined;
    this.settleStart = null;
    this.startPromise = null;
    const settleClose = this.settleClose;
    this.closePromise = null;
    this.settleClose = null;
    settleClose?.();
    this.emitStateChange();
  }

  private transitionState(next: SurfaceState): void {
    if (next === this.state) return;
    if (!ALLOWED_STATE_TRANSITIONS[this.state].includes(next)) {
      throw new Error(`Invalid Hunk takeover state transition: ${this.state} -> ${next}.`);
    }
    this.state = next;
  }

  private emitStateChange(): void {
    try {
      this.stateListener?.();
    } catch {
      // A listener cannot corrupt takeover state.
    }
  }
}

function formatUnexpectedHunkExit(result: HunkExit): string | undefined {
  if (result.exitCode === 0 && !result.signal) return undefined;
  const detail = sanitizeNotificationDetail(result.detail);
  if (detail?.startsWith("Hunk startup failed:")) return detail;
  return `Hunk exited unexpectedly (${formatExitStatus(result)})${detail ? `: ${detail}` : "."}`;
}

function formatHunkExitBeforeStartup(result: HunkExit): string {
  const detail = sanitizeNotificationDetail(result.detail);
  return detail?.startsWith("Hunk startup failed:")
    ? detail
    : `Hunk exited before takeover started (${formatExitStatus(result)})${detail ? `: ${detail}` : "."}`;
}

function formatExitStatus(result: HunkExit): string {
  return result.signal ? `signal ${result.signal}` : `exit code ${result.exitCode}`;
}

function sanitizeNotificationDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const printable = [...detail].filter((character) => {
    const code = character.charCodeAt(0);
    return code === 9 || code === 10 || code === 13 || (code >= 32 && (code < 127 || code > 159));
  });
  const safe = printable.join("").split(/\r?\n/).slice(0, 4).join("\n").slice(0, 500).trim();
  return safe || undefined;
}
