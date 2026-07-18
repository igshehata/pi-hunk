import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionEvent,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

/**
 * Pi exports the discriminated `ExtensionEvent` union but not every member
 * interface; derive the tool-execution shapes instead of redeclaring them so
 * they can never drift from the package.
 */
type BeforeAgentStartEvent = Extract<ExtensionEvent, { type: "before_agent_start" }>;
type ToolExecutionStartEvent = Extract<ExtensionEvent, { type: "tool_execution_start" }>;
type ToolExecutionEndEvent = Extract<ExtensionEvent, { type: "tool_execution_end" }>;
import {
  isWorkspaceMutation,
  mutationTargetPath,
  toWorkspaceRelative,
  ChangeDetector,
} from "./change-detector.ts";
import {
  ConfigStore,
  explainSettledDecision,
  hunkArgumentCompletions,
  isReviewPolicy,
  resolveHunkArgs,
  settledAutoOpenAction,
  shouldEarlyOpenOnMutation,
  type HunkConfig,
  type SettledDecision,
} from "./config.ts";
import { ReviewCoordinator } from "./coordinator.ts";
import { handleConfigCommand } from "./config-command.ts";
import {
  readHunkReview,
  registerHunkReviewTool,
  ReviewHandoffGate,
  type BlockingReviewResult,
  type HunkReviewNote,
} from "./review-handoff.ts";
import type { HunkRunner } from "./hunk-session.ts";

/**
 * Injectable collaborators so tests can drive the registered /hunk command and
 * prefix chord end-to-end against a coordinator built from fake surfaces.
 * Pi calls the default export with a single argument; production always gets
 * the real defaults.
 */
export interface HunkExtensionDeps {
  store?: ConfigStore;
  detector?: ChangeDetector;
  coordinator?: ReviewCoordinator;
  /** Fake-runner seam for the isolated review handoff module. */
  reviewRun?: HunkRunner;
}

/** Last settled auto-open decision, kept per extension instance for /hunk status. */
interface SettledDiagnostics {
  decision: SettledDecision | null;
}

/**
 * Collaborators shared by the lifecycle handlers below. The factory builds
 * this once; each `pi.on` registration only wires it into one named handler.
 */
interface LifecycleDeps {
  store: ConfigStore;
  detector: ChangeDetector;
  coordinator: ReviewCoordinator;
  diagnostics: SettledDiagnostics;
  /** Registers the config-driven prefix; see the factory for why registration is late-bound. */
  registerPrefix: (ctx: ExtensionContext) => void;
  /** Selects the Pi session that receives live coordinator status updates. */
  setStatusContext: (ctx: ExtensionContext | undefined) => void;
}

export default function hunkExtension(pi: ExtensionAPI, deps: HunkExtensionDeps = {}): void {
  const store = deps.store ?? new ConfigStore();
  const detector = deps.detector ?? new ChangeDetector();
  const coordinator = deps.coordinator ?? new ReviewCoordinator();
  const reviewGate = new ReviewHandoffGate(coordinator, () => store.get(), deps.reviewRun);

  /**
   * The dedicated prefix is configurable, but config only loads inside
   * session_start. Pi snapshots extension shortcuts after session_start
   * handlers settle, so late registration here is still early enough.
   */
  let registeredPrefix: string | undefined;
  const registeredPrefixes = new Set<string>();
  const registerPrefix = (ctx: ExtensionContext): void => {
    const prefix = store.get().bindings.prefix;
    if (registeredPrefix === prefix) return;
    if (registeredPrefix !== undefined) {
      // Pi has no shortcut unregistration: within one extension load the old
      // prefix stays bound. Say so instead of pretending the rebind was clean.
      ctx.ui.notify(
        `Pi-hunk prefix changed to ${prefix}; ${registeredPrefix} stays active until Pi reloads extensions.`,
        "warning",
      );
    }
    if (!registeredPrefixes.has(prefix)) {
      pi.registerShortcut(prefix, {
        description: `Pi-hunk prefix (then ${store.get().bindings.toggle} to toggle or ${store.get().bindings.show} to show)`,
        handler: (shortcutCtx) => handlePrefix(shortcutCtx, store, coordinator),
      });
      registeredPrefixes.add(prefix);
    }
    registeredPrefix = prefix;
  };

  let statusContext: ExtensionContext | undefined;
  coordinator.onStateChange(() => {
    if (statusContext) updateStatus(statusContext, store.get(), coordinator);
  });

  const diagnostics: SettledDiagnostics = { decision: null };
  const lifecycle: LifecycleDeps = {
    store,
    detector,
    coordinator,
    diagnostics,
    registerPrefix,
    setStatusContext: (ctx) => {
      statusContext = ctx;
    },
  };

  pi.on("session_start", (_event, ctx) => onSessionStart(ctx, lifecycle));
  pi.on("session_shutdown", (_event, ctx) => onSessionShutdown(ctx, lifecycle));
  pi.on("before_agent_start", (event, ctx) => onBeforeAgentStart(event, ctx, store));
  pi.on("agent_start", (_event, ctx) => onAgentStart(ctx, lifecycle));
  pi.on("agent_settled", (_event, ctx) => onAgentSettled(ctx, lifecycle));
  pi.on("tool_call", (event, ctx) => onToolCall(event, ctx, lifecycle));
  pi.on("tool_execution_start", (event, ctx) => onToolExecutionStart(event, ctx, lifecycle));
  pi.on("tool_execution_end", (event, ctx) => onToolExecutionEnd(event, ctx, lifecycle));

  registerHunkReviewTool(pi, reviewGate);
  pi.registerCommand("hunk", {
    description:
      "Hunk review: /hunk [target] · feedback · close · toggle · status · review [policy] · config",
    getArgumentCompletions: (argumentText) => hunkArgumentCompletions(argumentText),
    handler: (input, ctx) =>
      routeHunkCommand(
        input,
        ctx,
        store,
        coordinator,
        diagnostics,
        deps.reviewRun,
        reviewGate,
        (message) => pi.sendUserMessage(message),
      ),
  });
}

/**
 * session_start: defensive activation cleans leftover surfaces before reviving
 * so a repeated session_start cannot drop active pointers while resources
 * remain. The full config reload follows, then config-driven wiring (toggle
 * key and status line).
 */
async function onSessionStart(ctx: ExtensionContext, deps: LifecycleDeps): Promise<void> {
  const { store, detector, coordinator, diagnostics, registerPrefix, setStatusContext } = deps;
  setStatusContext(ctx);
  try {
    await coordinator.activateSession();
  } catch {
    // Best-effort; never block session startup indefinitely.
    coordinator.revive();
  }
  detector.reset();
  diagnostics.decision = null;
  try {
    await store.reload(ctx, (message) => ctx.ui.notify(message, "warning"));
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
  }
  registerPrefix(ctx);
  updateStatus(ctx, store.get(), coordinator);
}

/** session_shutdown: release surfaces and clear the status segment. */
async function onSessionShutdown(ctx: ExtensionContext, deps: LifecycleDeps): Promise<void> {
  const { detector, coordinator, setStatusContext } = deps;
  detector.reset();
  try {
    await coordinator.shutdown();
  } catch {
    // Best-effort.
  }
  setStatusContext(undefined);
  ctx.ui.setStatus("hunk", undefined);
}

/**
 * Tell the agent to enter the blocking hunk_review gate only after a coding
 * mutation. This keeps chat/read-only turns quiet while ensuring automatic
 * policies actually wait for human comments (or Hunk close/Q) before the agent
 * can finish and receive review notes.
 */
function onBeforeAgentStart(
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
  store: ConfigStore,
): { systemPrompt: string } | undefined {
  const review = store.get().review;
  if (review === "off" || ctx.mode !== "tui") return undefined;
  return {
    systemPrompt:
      `${event.systemPrompt}\n\n` +
      `Pi-hunk automatic review policy is "${review}". ` +
      `If this run successfully changes code, you MUST call hunk_review after the changes and before finishing. ` +
      `The tool blocks until the human hides Hunk; it returns fresh notes, approved when there are no new notes, or cancelled when Hunk closes/Q. ` +
      `Address every returned note, then call hunk_review again after any fixes until it returns approved. ` +
      `Do not call hunk_review for conversation-only or read-only turns.`,
  };
}

/** agent_start: reset coordinator flags for the new agent turn. */
function onAgentStart(_ctx: ExtensionContext, deps: LifecycleDeps): void {
  deps.coordinator.resetRunFlags();
}

/**
 * Live policy: visibly open at the first mutating tool preflight so the user can
 * watch --watch follow the turn. Never block the tool on launch — the open runs
 * detached; agent_settled awaits and clears it.
 */
function onToolCall(event: ToolCallEvent, ctx: ExtensionContext, deps: LifecycleDeps): void {
  maybeOpenLiveReview(event.toolName, event.input, ctx, deps);
}

/**
 * Pi emits tool_execution_start before tool_call. Use both boundaries so live
 * review remains reliable for built-ins, dynamically registered tools, and Pi
 * versions that omit or delay one of the notifications. openedForRun makes the
 * pair idempotent.
 */
function maybeOpenLiveReview(
  toolName: string,
  input: unknown,
  ctx: ExtensionContext,
  deps: LifecycleDeps,
): void {
  const { store, coordinator } = deps;
  const config = store.get();
  if (
    !shouldEarlyOpenOnMutation({
      review: config.review,
      uiMode: ctx.mode,
      alreadyOpenedForRun: coordinator.hasOpenedForRun(),
      activeBlocking: coordinator.isBlocking(),
    })
  ) {
    return;
  }
  if (!isWorkspaceMutation(toolName, input, ctx.cwd)) return;

  coordinator.markOpenedForRun();
  if (coordinator.hasLiveSurface()) return;

  const promise = coordinator.ensureOpen(ctx, config, config.hunk.args, "live").catch((error) => {
    ctx.ui.notify(
      `Early Hunk open failed: ${error instanceof Error ? error.message : String(error)}`,
      "warning",
    );
  });
  coordinator.setEarlyOpenPromise(promise);
}

/**
 * tool_execution_start: stash args by toolCallId — tool_execution_end does not
 * carry them, and follow-edits needs the mutation target path.
 */
function onToolExecutionStart(
  event: ToolExecutionStartEvent,
  ctx: ExtensionContext,
  deps: LifecycleDeps,
): void {
  deps.detector.rememberToolArgs(event.toolCallId, event.args);
  maybeOpenLiveReview(event.toolName, event.args, ctx, deps);
}

/** tool_execution_end: record successful mutations and steer follow-edits. */
function onToolExecutionEnd(
  event: ToolExecutionEndEvent,
  ctx: ExtensionContext,
  deps: LifecycleDeps,
): void {
  const { store, detector, coordinator } = deps;
  const args = detector.takeToolArgs(event.toolCallId);
  if (event.isError || !isWorkspaceMutation(event.toolName, args, ctx.cwd)) return;
  detector.markChanged();

  const config = store.get();
  if (ctx.mode !== "tui") return;
  if (!config.followEdits) return;
  if (!coordinator.hasLiveSurface() && !coordinator.getEarlyOpenPromise()) return;

  const target = mutationTargetPath(args, ctx.cwd);
  if (!target) return;
  const relative = toWorkspaceRelative(target, ctx.cwd);
  coordinator.scheduleFollowEdit(ctx, config, relative);
}

/**
 * agent_settled: settle any detached early open first (so its surface is
 * accounted for), then decide the auto-open action from the run's change
 * evidence.
 */
async function onAgentSettled(ctx: ExtensionContext, deps: LifecycleDeps): Promise<void> {
  const { store, detector, coordinator, diagnostics } = deps;
  const config = store.get();
  const early = coordinator.getEarlyOpenPromise();
  if (early) {
    try {
      await early;
    } catch {
      // Already reported.
    } finally {
      coordinator.setEarlyOpenPromise(null);
    }
  }

  const evidence = detector.consumeSettled();
  const suppression = coordinator.getAutoOpenSuppressionReason();
  const openedEarlySurface = coordinator.hasEarlySurfaceOpenedForRun();

  if (!evidence.mutation && openedEarlySurface && !suppression) {
    try {
      await coordinator.closeEarlySurfaceOpenedForRun();
      updateStatus(ctx, store.get(), coordinator);
    } catch (error) {
      ctx.ui.notify(
        `Could not close unused early Hunk review: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  }

  // Automatic review is mutation-tool driven across every policy. Conversation
  // and read-only work never pop open Hunk, regardless of the workspace VCS.
  const shouldReview = evidence.mutation;
  const action = settledAutoOpenAction({
    review: config.review,
    uiMode: ctx.mode,
    activeBlocking: coordinator.isBlocking(),
    shouldReview,
    hasLiveSurface: coordinator.hasLiveSurface(),
    autoOpenSuppression: suppression,
  });

  // Record WHY for /hunk status before current-run suppression flags are reset.
  const info = coordinator.getActiveInfo();
  const decision = explainSettledDecision({
    action,
    review: config.review,
    uiMode: ctx.mode,
    activeBlocking: coordinator.isBlocking(),
    activeVisible: coordinator.hasLiveSurface() && info?.state === "visible",
    activeLive: coordinator.hasLiveSurface(),
    autoOpenSuppression: suppression,
  });
  diagnostics.decision = decision;

  try {
    if (action === "skip") return;

    await coordinator.ensureOpen(
      ctx,
      config,
      config.hunk.args,
      action === "recover" ? "recover" : "auto",
    );
    updateStatus(ctx, store.get(), coordinator);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The change evidence (why the open was attempted) survives the failure.
    diagnostics.decision = {
      action: "failed",
      reason: decision.action === "opened" ? decision.reason : "mutation",
      error: message,
    };
    ctx.ui.notify(`Auto Hunk review failed: ${message}`, "warning");
  } finally {
    coordinator.resetRunFlags();
  }
}

/** /hunk command router: dispatch subcommands to their named handlers. */
async function routeHunkCommand(
  input: string,
  ctx: ExtensionCommandContext,
  store: ConfigStore,
  coordinator: ReviewCoordinator,
  diagnostics: SettledDiagnostics,
  reviewRun: HunkRunner | undefined,
  reviewGate: Pick<ReviewHandoffGate, "wait">,
  sendUserMessage: (message: string) => void,
): Promise<void> {
  const trimmed = input.trim();
  const first = trimmed.split(/\s+/)[0] ?? "";
  const rest = trimmed.slice(first.length).trim();
  switch (first) {
    case "close":
      if (!acceptsNoArguments("close", rest, ctx)) return;
      await handleClose(ctx, store, coordinator);
      return;
    case "toggle":
      if (!acceptsNoArguments("toggle", rest, ctx)) return;
      await handleToggle(ctx, store, coordinator);
      return;
    case "status":
      if (!acceptsNoArguments("status", rest, ctx)) return;
      await handleStatus(ctx, store, coordinator, diagnostics, reviewRun);
      return;
    case "feedback":
      if (!acceptsNoArguments("feedback", rest, ctx)) return;
      await handleFeedback(ctx, reviewGate, sendUserMessage);
      return;
    case "review":
      await handleReviewCommand(rest, ctx, store);
      updateStatus(ctx, store.get(), coordinator);
      return;
    case "config":
      await handleConfigCommand(rest, ctx, store, coordinator);
      updateStatus(ctx, store.get(), coordinator);
      return;
    default:
      // Anything else (empty, "staged", "show HEAD~1", "main...HEAD", flags,
      // hunk verbs) flows through the passthrough and opens a manual review.
      await handleOpen(input, ctx, store, coordinator);
      return;
  }
}

function acceptsNoArguments(
  subcommand: "close" | "toggle" | "status" | "feedback",
  input: string,
  ctx: ExtensionContext,
): boolean {
  if (!input) return true;
  ctx.ui.notify(`Usage: /hunk ${subcommand}`, "warning");
  return false;
}

export function formatManualFeedback(notes: HunkReviewNote[]): string {
  return [
    "Manual Hunk feedback was submitted. Address every note below comment-by-comment, then run the relevant checks.",
    JSON.stringify({ status: "submitted", notes }, null, 2),
  ].join("\n\n");
}

/** Manual fallback when an agent finishes without entering the blocking hunk_review tool. */
export async function handleFeedback(
  ctx: ExtensionCommandContext,
  gate: Pick<ReviewHandoffGate, "wait">,
  sendUserMessage: (message: string) => void,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Hunk feedback requires Pi's interactive TUI mode.", "warning");
    return;
  }

  await ctx.waitForIdle();
  let result: BlockingReviewResult;
  try {
    result = await gate.wait(ctx);
  } catch (error) {
    ctx.ui.notify(
      `Could not collect Hunk feedback: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }

  if (result.status === "submitted") {
    try {
      sendUserMessage(formatManualFeedback(result.notes));
      ctx.ui.notify(
        `Sent ${result.notes.length} Hunk feedback note${result.notes.length === 1 ? "" : "s"} to the agent.`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(
        `Could not send Hunk feedback to the agent: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
    return;
  }

  ctx.ui.notify(result.message, result.status === "approved" ? "info" : "warning");
}

async function handleOpen(
  input: string,
  ctx: ExtensionCommandContext,
  store: ConfigStore,
  coordinator: ReviewCoordinator,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Hunk requires Pi's interactive TUI mode.", "warning");
    return;
  }
  await ctx.waitForIdle();
  const config = store.get();
  let args: string[];
  try {
    args = resolveHunkArgs(input, config.hunk.args);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return;
  }
  try {
    await coordinator.ensureOpen(ctx, config, args, "manual");
    updateStatus(ctx, store.get(), coordinator);
  } catch (error) {
    ctx.ui.notify(
      `Hunk failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

export type HunkPrefixAction = "toggle" | "show";

/** Capture the action key after Pi dispatches the dedicated Hunk prefix. */
export async function readHunkPrefixAction(
  ctx: ExtensionContext,
  bindings: HunkConfig["bindings"],
): Promise<HunkPrefixAction | undefined> {
  return ctx.ui.custom<HunkPrefixAction | undefined>((_tui, theme, _keybindings, done) => ({
    render(width: number): string[] {
      return [
        truncateToWidth(
          `${theme.fg("accent", theme.bold("Pi-hunk"))}  ${bindings.toggle} toggle · ${bindings.show} show last commit · esc cancel`,
          width,
        ),
      ];
    },
    handleInput(data: string): void {
      if (matchesKey(data, bindings.toggle)) done("toggle");
      else if (matchesKey(data, bindings.show)) done("show");
      else done(undefined);
    },
    invalidate(): void {},
  }));
}

async function handlePrefix(
  ctx: ExtensionContext,
  store: ConfigStore,
  coordinator: ReviewCoordinator,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Pi-hunk shortcuts require Pi's interactive TUI mode.", "warning");
    return;
  }
  const action = await readHunkPrefixAction(ctx, store.get().bindings);
  if (action === "toggle") await handleToggle(ctx, store, coordinator);
  else if (action === "show") await handleShow(ctx, store, coordinator);
}

async function handleShow(
  ctx: ExtensionContext,
  store: ConfigStore,
  coordinator: ReviewCoordinator,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Hunk requires Pi's interactive TUI mode.", "warning");
    return;
  }
  const config = store.get();
  try {
    await coordinator.ensureOpen(ctx, config, ["show"], "shortcut");
    updateStatus(ctx, store.get(), coordinator);
  } catch (error) {
    ctx.ui.notify(
      `Hunk show failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

async function handleToggle(
  ctx: ExtensionContext,
  store: ConfigStore,
  coordinator: ReviewCoordinator,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Hunk requires Pi's interactive TUI mode.", "warning");
    return;
  }
  const config = store.get();
  // Toggle must work while the agent is busy (overlay is non-blocking) — no waitForIdle.
  try {
    await coordinator.toggleOverlay(ctx, config, config.hunk.args, "shortcut");
    updateStatus(ctx, store.get(), coordinator);
  } catch (error) {
    ctx.ui.notify(
      `Hunk toggle failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

async function handleClose(
  ctx: ExtensionContext,
  store: ConfigStore,
  coordinator: ReviewCoordinator,
): Promise<void> {
  try {
    const closed = await coordinator.closeActive();
    updateStatus(ctx, store.get(), coordinator);
    ctx.ui.notify(closed ? "Closed Hunk review." : "No active Hunk review to close.", "info");
  } catch (error) {
    ctx.ui.notify(
      `Could not close Hunk: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

/** One line each for the T17 status fields, kept support-readable. */
export function describeSettledDecision(decision: SettledDecision | null): string {
  if (!decision) return "none (no agent run has settled yet)";
  if (decision.action === "failed") return `failed(${decision.reason}: ${decision.error})`;
  return `${decision.action}(${decision.reason})`;
}

/** Support status: policy, active overlay, binary, open notes, and last auto-open decision. */
async function handleStatus(
  ctx: ExtensionContext,
  store: ConfigStore,
  coordinator: ReviewCoordinator,
  diagnostics: SettledDiagnostics,
  reviewRun?: HunkRunner,
): Promise<void> {
  const config = store.get();
  const info = coordinator.getActiveInfo();
  const active = info ? `overlay:${info.state}${info.detail ? `(${info.detail})` : ""}` : "none";
  let openNotes = "no-live-session";
  try {
    const review = await readHunkReview({
      cwd: ctx.cwd,
      managedPid: info?.pid,
      hunkBinary: config.hunk.command,
      run: reviewRun,
    });
    if (review.status === "live") openNotes = String(review.notes.length);
  } catch (error) {
    openNotes = `unavailable(${error instanceof Error ? error.message : String(error)})`;
  }
  ctx.ui.notify(
    `Hunk: review=${config.review}, layout=${config.overlay.layout}, ` +
      `experimental-pi-wrap=${config.overlay.experimentalPiWrap ? "on" : "off"}, ` +
      `active=${active}, command=${config.hunk.command}\n` +
      `open-notes=${openNotes}, last-auto-open=${describeSettledDecision(diagnostics.decision)}`,
    "info",
  );
}

async function handleReviewCommand(
  input: string,
  ctx: ExtensionContext,
  store: ConfigStore,
): Promise<void> {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    ctx.ui.notify(`Hunk review: ${store.get().review}`, "info");
    return;
  }

  const value = tokens[0];
  if (tokens.length !== 1 || !value || !isReviewPolicy(value)) {
    ctx.ui.notify("Usage: /hunk review off|after-run|live", "warning");
    return;
  }
  if (!ctx.isProjectTrusted()) {
    ctx.ui.notify(
      "Hunk configuration requires a trusted project so it can update .pi/hunk.json.",
      "warning",
    );
    return;
  }

  try {
    await store.persist(ctx, "project", { review: value });
  } catch (error) {
    ctx.ui.notify(
      `Could not update project Hunk config: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  const effective = store.get().review;
  if (effective !== value) {
    ctx.ui.notify(
      `Hunk review=${value} was saved to .pi/hunk.json, but PI_HUNK_REVIEW keeps review=${effective}.`,
      "warning",
    );
    return;
  }
  ctx.ui.notify(`Hunk review set to ${value} in .pi/hunk.json.`, "info");
}

function updateStatus(
  ctx: ExtensionContext,
  config: HunkConfig,
  coordinator: ReviewCoordinator,
): void {
  const info = coordinator.getActiveInfo();
  let label: string | undefined;
  if (info?.state === "visible") label = "hunk: visible";
  else if (info?.state === "hidden") label = "hunk: hidden";
  else if (info?.state === "starting") label = "hunk: starting";
  else if (config.review !== "off") label = `hunk: ${config.review}`;
  ctx.ui.setStatus(
    "hunk",
    label ? ctx.ui.theme.fg(info?.state === "visible" ? "success" : "dim", label) : undefined,
  );
}

export {
  isMutation,
  isWorkspaceMutation,
  mutationTargetPath,
  toWorkspaceRelative,
  ChangeDetector,
} from "./change-detector.ts";
export type { SettledEvidence } from "./change-detector.ts";
export { ReviewCoordinator } from "./coordinator.ts";
export {
  DEFAULT_CONFIG,
  ConfigStore,
  resolveHunkArgs,
  settledAutoOpenAction,
  shouldEarlyOpenOnMutation,
  explainSettledDecision,
} from "./config.ts";
export type { HunkConfig, OverlayLayout, ReviewPolicy, SettledDecision } from "./config.ts";
