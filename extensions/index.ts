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
type ToolExecutionStartEvent = Extract<ExtensionEvent, { type: "tool_execution_start" }>;
type ToolExecutionEndEvent = Extract<ExtensionEvent, { type: "tool_execution_end" }>;
import { isMutation, mutationTargetPaths, ChangeDetector } from "./change-detector.ts";
import {
  ConfigStore,
  explainSettledDecision,
  hunkArgumentCompletions,
  isReviewPolicy,
  resolveHunkArgs,
  resolveOverlayHostMode,
  settledAutoOpenAction,
  shouldEarlyOpenOnMutation,
  type HunkConfig,
  type SettledDecision,
} from "./config.ts";
import { ReviewCoordinator } from "./coordinator.ts";
import { handleConfigCommand, reportPersistedReviewPolicy } from "./config-command.ts";
import {
  readHunkReview,
  ReviewHandoffGate,
  type AutomaticReviewResult,
  type HunkFeedbackResult,
  type HunkReviewNote,
  type ReviewSessionDrain,
  type ReviewSessionWaiter,
} from "./review-handoff.ts";
import type { HunkRunner } from "./hunk-session.ts";
import { resolveLaunchDirectory } from "./path-routing.ts";

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
  /** Deterministic managed-session polling seam for integration tests. */
  reviewWaitForSession?: ReviewSessionWaiter;
}

/** Last settled auto-open decision, kept per extension instance for /hunk status. */
interface SettledDiagnostics {
  decision: SettledDecision | null;
}

const UNRESOLVED_MUTATION_WARNING =
  "Automatic Hunk review skipped a pathless mutation because its repository could not be inferred safely; open Hunk manually from the target repository.";

interface OmpAgentEndEvent {
  type: "agent_end";
  willContinue?: boolean;
}

interface OmpExtensionAPI {
  readonly zod: unknown;
  on(
    event: "agent_end",
    handler: (event: OmpAgentEndEvent, ctx: ExtensionContext) => Promise<void> | void,
  ): void;
}

interface RuntimeRegistrationOptions {
  registerSessionLifecycle: boolean;
  hostName: "Pi" | "OMP";
  settledEvent: "agent_settled" | "agent_end";
  preparedConfigWarnings?: readonly string[];
}

/**
 * Collaborators shared by the lifecycle handlers below. The factory builds
 * this once; each `pi.on` registration only wires it into one named handler.
 */
interface LifecycleDeps {
  store: ConfigStore;
  detector: ChangeDetector;
  coordinator: ReviewCoordinator;
  reviewGate: ReviewHandoffGate;
  diagnostics: SettledDiagnostics;
  /** Registers the config-driven prefix before the host snapshots shortcuts. */
  registerPrefix: (ctx?: ExtensionContext) => void;
  /** Selects the Pi session that receives live coordinator status updates. */
  setStatusContext: (ctx: ExtensionContext | undefined) => void;
}

interface HunkRuntimeLifecycle {
  startSession: (ctx: ExtensionContext) => Promise<void>;
  shutdownSession: (ctx: ExtensionContext) => Promise<void>;
  registerPrefix: () => void;
}

function registerHunkRuntime(
  pi: ExtensionAPI,
  deps: HunkExtensionDeps,
  options: RuntimeRegistrationOptions,
): HunkRuntimeLifecycle {
  const store = deps.store ?? new ConfigStore();
  const detector = deps.detector ?? new ChangeDetector();
  const coordinator = deps.coordinator ?? new ReviewCoordinator();
  const reviewGate = new ReviewHandoffGate(
    coordinator,
    () => store.get(),
    deps.reviewRun,
    deps.reviewWaitForSession,
  );

  /**
   * Pi loads config during session_start, before it snapshots shortcuts. OMP
   * snapshots registrations earlier, so its bootstrap preloads config and calls
   * this once before the async extension factory resolves.
   */
  let registeredPrefix: string | undefined;
  const registeredPrefixes = new Set<string>();
  const registerPrefix = (ctx?: ExtensionContext): void => {
    const prefix = store.get().bindings.prefix;
    if (registeredPrefix === prefix) return;
    if (registeredPrefix !== undefined) {
      // Neither host exposes shortcut unregistration within an extension load.
      ctx?.ui.notify(
        `Pi-hunk prefix changed to ${prefix}; ${registeredPrefix} stays active until ${options.hostName} reloads extensions.`,
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
  reviewGate.onLateProbeWarning((message) => {
    statusContext?.ui.notify(message, "warning");
  });
  reviewGate.onLateSubmission(async (notes, delivery) => {
    const ctx = statusContext;
    if (!ctx || delivery.signal.aborted) {
      throw new Error("The Pi session ended before late Hunk feedback was delivered.");
    }
    try {
      const message = formatManualFeedback(notes);
      // Pi's current API is fire-and-forget: followUp avoids the idle-check
      // race, but a void return still cannot confirm asynchronous acceptance.
      pi.sendUserMessage(message, { deliverAs: "followUp" });
    } catch (error) {
      try {
        ctx.ui.notify(
          `Could not send Hunk feedback; it remains queued for /hunk feedback: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      } catch {
        // Delivery failure is still reflected by the rejected handler below.
      }
      throw error;
    }
    // A return from sendUserMessage does not acknowledge host acceptance.
    // Keep the queue/dedupe record recoverable until Pi exposes such a signal.
    return { status: "unconfirmed" };
  });

  const diagnostics: SettledDiagnostics = { decision: null };
  const lifecycle: LifecycleDeps = {
    store,
    detector,
    coordinator,
    reviewGate,
    diagnostics,
    registerPrefix,
    setStatusContext: (ctx) => {
      statusContext = ctx;
    },
  };

  let preparedConfigWarnings = options.preparedConfigWarnings;
  const runtime: HunkRuntimeLifecycle = {
    startSession: (ctx) => {
      const prepared = preparedConfigWarnings;
      preparedConfigWarnings = undefined;
      return onSessionStart(ctx, lifecycle, prepared);
    },
    shutdownSession: (ctx) => onSessionShutdown(ctx, lifecycle),
    registerPrefix: () => registerPrefix(),
  };
  if (options.registerSessionLifecycle) {
    pi.on("session_start", (_event, ctx) => runtime.startSession(ctx));
    pi.on("session_shutdown", (_event, ctx) => runtime.shutdownSession(ctx));
  }
  pi.on("agent_start", (_event, ctx) => onAgentStart(ctx, lifecycle));
  if (options.settledEvent === "agent_end") {
    const omp = pi as unknown as OmpExtensionAPI;
    omp.on("agent_end", (event, ctx) => {
      if (!event.willContinue) return onAgentSettled(ctx, lifecycle);
    });
  } else {
    pi.on("agent_settled", (_event, ctx) => onAgentSettled(ctx, lifecycle));
  }
  pi.on("tool_call", (event, ctx) => onToolCall(event, ctx, lifecycle));
  pi.on("tool_execution_start", (event, ctx) => onToolExecutionStart(event, ctx, lifecycle));
  pi.on("tool_execution_end", (event, ctx) => onToolExecutionEnd(event, ctx, lifecycle));

  pi.registerCommand("hunk", {
    description:
      "Hunk review: /hunk [target] · submit · feedback · next · close · toggle · status · review [policy] · config",
    getArgumentCompletions: (argumentText) => hunkArgumentCompletions(argumentText),
    handler: (input, ctx) =>
      routeHunkCommand(input, ctx, store, coordinator, diagnostics, deps.reviewRun, reviewGate),
  });
  return runtime;
}

/** Register directly for deterministic integration tests with injected collaborators. */
export function registerHunkExtension(pi: ExtensionAPI, deps: HunkExtensionDeps = {}): void {
  registerHunkRuntime(pi, deps, {
    registerSessionLifecycle: true,
    hostName: "Pi",
    settledEvent: "agent_settled",
  });
}

interface ProductionSessionLifecycle {
  startSession: (ctx: ExtensionContext) => Promise<void>;
  shutdownSession: (ctx: ExtensionContext) => Promise<void>;
}

/**
 * A host may repeat a lifecycle notification or begin a replacement context
 * before the prior context's shutdown arrives. Serialize real transitions,
 * remember starts by context identity, and revoke old shutdown ownership
 * synchronously when a distinct context starts.
 */
function productionSessionLifecycle(runtime: HunkRuntimeLifecycle): ProductionSessionLifecycle {
  const starts = new WeakMap<ExtensionContext, Promise<void>>();
  let currentContext: ExtensionContext | undefined;
  let transitions = Promise.resolve();

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const pending = transitions.then(operation);
    transitions = pending.catch(() => undefined);
    return pending;
  };

  return {
    startSession: (ctx) => {
      const existing = starts.get(ctx);
      if (existing) return existing;

      // This assignment precedes queued initialization deliberately: once the
      // host presents a newer context, a late shutdown for the old one is stale.
      currentContext = ctx;
      const pending = enqueue(async () => {
        await runtime.startSession(ctx);
      });
      starts.set(ctx, pending);
      return pending;
    },
    shutdownSession: (ctx) => {
      if (currentContext !== ctx) return Promise.resolve();
      currentContext = undefined;
      return enqueue(() => runtime.shutdownSession(ctx));
    },
  };
}

function isOmpExtensionApi(pi: ExtensionAPI): pi is ExtensionAPI & OmpExtensionAPI {
  return "zod" in pi;
}

async function registerOmpProductionExtension(pi: ExtensionAPI & OmpExtensionAPI): Promise<void> {
  const store = new ConfigStore();
  const preparedConfigWarnings: string[] = [];
  try {
    await store.startSession({ cwd: process.cwd() }, (message) =>
      preparedConfigWarnings.push(message),
    );
  } catch (error) {
    preparedConfigWarnings.push(error instanceof Error ? error.message : String(error));
  }

  const runtime = registerHunkRuntime(
    pi,
    { store },
    {
      registerSessionLifecycle: false,
      hostName: "OMP",
      settledEvent: "agent_end",
      preparedConfigWarnings,
    },
  );
  runtime.registerPrefix();
  const sessions = productionSessionLifecycle(runtime);
  pi.on("session_start", (_event, ctx) => sessions.startSession(ctx));
  pi.on("session_shutdown", (_event, ctx) => sessions.shutdownSession(ctx));
}

/**
 * Production bootstrap. Pi can register its config-driven shortcut during
 * session_start. OMP snapshots shortcuts earlier, so its async bootstrap
 * preloads config and registers eagerly before the factory resolves.
 */
export default function hunkExtension(
  pi: ExtensionAPI,
  deps?: HunkExtensionDeps,
): void | Promise<void> {
  // Explicit dependency injection is a deterministic Pi-compatible test seam.
  if (deps !== undefined) {
    registerHunkExtension(pi, deps);
    return;
  }
  if (isOmpExtensionApi(pi)) return registerOmpProductionExtension(pi);

  const runtime = registerHunkRuntime(
    pi,
    {},
    {
      registerSessionLifecycle: false,
      hostName: "Pi",
      settledEvent: "agent_settled",
    },
  );
  const sessions = productionSessionLifecycle(runtime);
  pi.on("session_start", (_event, ctx) => sessions.startSession(ctx));
  pi.on("session_shutdown", (_event, ctx) => sessions.shutdownSession(ctx));
}

/**
 * session_start: defensive activation cleans leftover surfaces before reviving
 * so a repeated session_start cannot drop active pointers while resources
 * remain. Pi loads config here; OMP consumes the config prepared before its
 * factory resolved. Config-driven wiring and status follow either path.
 */
async function onSessionStart(
  ctx: ExtensionContext,
  deps: LifecycleDeps,
  preparedConfigWarnings?: readonly string[],
): Promise<void> {
  const {
    store,
    detector,
    coordinator,
    reviewGate,
    diagnostics,
    registerPrefix,
    setStatusContext,
  } = deps;
  // Keep the retiring epoch and delivery context alive while activation's
  // coordinator barrier inspects any surviving exact surface. After cleanup,
  // quarantine old asynchronous work and keep status revoked until fresh
  // config is ready for the replacement context.
  try {
    await coordinator.activateSession();
  } catch {
    // Best-effort; never leave a surviving surface orphaned during recovery.
    try {
      await coordinator.revive();
    } catch {
      // Session setup continues even when final cleanup is unavailable.
    }
  }
  reportSessionDrain(ctx, reviewGate.resetSession());
  setStatusContext(undefined);
  detector.reset();
  diagnostics.decision = null;
  if (preparedConfigWarnings !== undefined) {
    for (const message of preparedConfigWarnings) ctx.ui.notify(message, "warning");
  } else {
    try {
      await store.startSession(ctx, (message) => ctx.ui.notify(message, "warning"));
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    }
  }
  registerPrefix(ctx);
  setStatusContext(ctx);
  updateStatus(ctx, store.get(), coordinator);
}

/** session_shutdown: release surfaces and clear the status segment. */
async function onSessionShutdown(ctx: ExtensionContext, deps: LifecycleDeps): Promise<void> {
  const { detector, coordinator, reviewGate, setStatusContext } = deps;
  detector.reset();
  // Keep the ending session's delivery context alive until shutdown's exact
  // surface barrier has inspected and attempted every final note. Teardown is
  // best-effort on probe failure; reset then quarantines unconfirmed work.
  try {
    await coordinator.shutdown();
  } catch {
    // Best-effort.
  }
  const drained = reviewGate.resetSession();
  setStatusContext(undefined);
  reportSessionDrain(ctx, drained);
  ctx.ui.setStatus("hunk", undefined);
}

function reportSessionDrain(ctx: ExtensionContext, drain: ReviewSessionDrain): void {
  if (drain.notes.length === 0) return;
  const summaries = drain.notes.map((note) => `${note.file}: ${note.summary}`).join("; ");
  try {
    ctx.ui.notify(
      `${drain.notes.length} Hunk feedback note${drain.notes.length === 1 ? "" : "s"} ` +
        `from the ending session remain recoverable in their originating Hunk review; delivery ` +
        `was not confirmed, and they will not be sent through the new Pi session: ${summaries}`,
      "warning",
    );
  } catch {
    // The full drain has already been returned to this lifecycle boundary;
    // teardown must not fail solely because the old UI context is unavailable.
  }
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
  // Keep the latest paired args. Pi normally emits execution_start first, while
  // dynamically registered tools may provide the more complete payload here.
  deps.detector.rememberToolArgs(event.toolCallId, event.input);
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
    })
  ) {
    return;
  }
  if (!isMutation(toolName, input)) return;
  let target: string | undefined;
  try {
    target = mutationTargetPaths(input, ctx.cwd)[0];
  } catch (error) {
    ctx.ui.notify(
      `Could not resolve Hunk mutation target: ${error instanceof Error ? error.message : String(error)}`,
      "warning",
    );
    return;
  }
  // Pathless shell commands are intentionally not guessed because they may
  // have changed directories through arbitrary shell syntax.
  if (!target) return;

  coordinator.markOpenedForRun();
  // A speculative live preflight must never replace a pre-existing/manual
  // surface. Successful settled evidence can reconcile a different repository.
  if (coordinator.hasLiveSurface()) return;
  const promise = resolveLaunchDirectory(target)
    .then((launchCwd) => coordinator.ensureOpen(ctx, config, config.hunk.args, "live", launchCwd))
    .catch((error) => {
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
  const { store, detector, coordinator, reviewGate } = deps;
  const args = detector.takeToolArgs(event.toolCallId);
  if (event.isError || !isMutation(event.toolName, args)) return;
  let evidence;
  try {
    evidence = detector.recordSuccessfulMutation(event.toolName, args, ctx.cwd);
  } catch (error) {
    // Invalid structured paths remain unresolved evidence rather than being
    // interpolated into a process launch.
    evidence = detector.markChanged();
    ctx.ui.notify(
      `Could not normalize Hunk mutation target: ${error instanceof Error ? error.message : String(error)}`,
      "warning",
    );
  }
  reviewGate.addEvidence(evidence);

  const config = store.get();
  if (ctx.mode !== "tui") return;
  if (!config.followEdits) return;
  if (!coordinator.hasLiveSurface() && !coordinator.getEarlyOpenPromise()) return;

  if (evidence.targets.length === 0) return;
  void coordinator.scheduleFollowEditCandidates(ctx, config, evidence.targets);
}

/**
 * agent_settled: settle any detached early open first (so its surface is
 * accounted for), then decide the auto-open action from the run's change
 * evidence.
 */
async function onAgentSettled(ctx: ExtensionContext, deps: LifecycleDeps): Promise<void> {
  const { store, detector, coordinator, reviewGate, diagnostics } = deps;
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
  const action = settledAutoOpenAction({
    review: config.review,
    uiMode: ctx.mode,
    shouldReview: evidence.mutation,
    hasLiveSurface: coordinator.hasLiveSurface(),
    autoOpenSuppression: suppression,
  });

  // Record WHY for /hunk status before current-run suppression flags are reset.
  const info = coordinator.getActiveInfo();
  const decision = explainSettledDecision({
    action,
    review: config.review,
    uiMode: ctx.mode,
    activeVisible: coordinator.hasLiveSurface() && info?.state === "visible",
    activeLive: coordinator.hasLiveSurface(),
    autoOpenSuppression: suppression,
  });
  diagnostics.decision = decision;

  const canPresent =
    evidence.mutation && config.review !== "off" && ctx.mode === "tui" && !suppression;

  try {
    if (!canPresent) return;

    // Even an existing live surface must be reconciled: its cwd may belong to
    // a failed preflight or a different/manual repository.
    const source =
      config.review === "live" ? (coordinator.hasLiveSurface() ? "live" : "recover") : "auto";
    const presented = await reviewGate.presentAutomatic(ctx, source);
    if (presented.status === "reviewable") {
      diagnostics.decision =
        presented.routing === "reused"
          ? { action: "skipped", reason: "already-open" }
          : presented.routing === "recovered"
            ? { action: "opened", reason: "recover" }
            : presented.routing === "rerouted"
              ? { action: "opened", reason: "reroute" }
              : presented.routing === "replaced"
                ? { action: "opened", reason: "replacement" }
                : { action: "opened", reason: "mutation" };
      updateStatus(ctx, store.get(), coordinator);
      if (presented.unresolved) ctx.ui.notify(UNRESOLVED_MUTATION_WARNING, "warning");
      return;
    }
    if (presented.status === "no-diff") {
      diagnostics.decision = { action: "skipped", reason: "no-diff" };
      updateStatus(ctx, store.get(), coordinator);
      return;
    }
    if (presented.status === "target-required") {
      diagnostics.decision = { action: "skipped", reason: "target-required" };
      ctx.ui.notify(UNRESOLVED_MUTATION_WARNING, "warning");
      return;
    }
    if (presented.status === "no-evidence") return;
    throw new Error(
      presented.detail ? `${presented.reason}: ${presented.detail}` : presented.reason,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.decision = {
      action: "failed",
      reason: action === "recover" ? "recover" : "mutation",
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
  reviewGate: Pick<ReviewHandoffGate, "submit" | "next">,
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
      await handleFeedback(ctx, reviewGate);
      return;
    case "submit":
      if (!acceptsNoArguments("submit", rest, ctx)) return;
      await handleReviewAction(ctx, reviewGate);
      return;
    case "next":
      if (!acceptsNoArguments("next", rest, ctx)) return;
      await handleNextRepository(ctx, reviewGate);
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
  subcommand: "close" | "toggle" | "status" | "feedback" | "submit" | "next",
  input: string,
  ctx: ExtensionContext,
): boolean {
  if (!input) return true;
  ctx.ui.notify(`Usage: /hunk ${subcommand}`, "warning");
  return false;
}

export function formatManualFeedback(notes: HunkReviewNote[]): string {
  return [
    "Hunk feedback was submitted. Address every note below comment-by-comment, then run the relevant checks.",
    JSON.stringify({ status: "submitted", notes }, null, 2),
  ].join("\n\n");
}

/** Force an immediate fresh-comment probe; normal hides do this automatically. */
export async function handleReviewAction(
  ctx: ExtensionCommandContext,
  gate: Pick<ReviewHandoffGate, "submit">,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Hunk feedback requires Pi's interactive TUI mode.", "warning");
    return;
  }

  let result: HunkFeedbackResult;
  try {
    result = await gate.submit(ctx);
  } catch (error) {
    ctx.ui.notify(
      `Could not collect Hunk feedback: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  ctx.ui.notify(
    result.message,
    result.status === "submitted" || result.status === "pending" || result.status === "no-diff"
      ? "info"
      : "warning",
  );
}

/** Manual recovery alias for the same immediate probe used by /hunk submit. */
export async function handleFeedback(
  ctx: ExtensionCommandContext,
  gate: Pick<ReviewHandoffGate, "submit">,
): Promise<void> {
  await handleReviewAction(ctx, gate);
}

async function handleNextRepository(
  ctx: ExtensionCommandContext,
  gate: Pick<ReviewHandoffGate, "next">,
): Promise<void> {
  let result: AutomaticReviewResult;
  try {
    result = await gate.next(ctx);
  } catch (error) {
    ctx.ui.notify(
      `Could not open the next Hunk review: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }

  if (result.status === "reviewable") {
    ctx.ui.notify(`Opened the next Hunk review (${result.repoRoot}).`, "info");
  } else if (result.status === "no-evidence") {
    ctx.ui.notify("No additional repository is queued for review.", "info");
  } else if (result.status === "no-diff") {
    ctx.ui.notify("No additional queued repository has a reviewable diff.", "info");
  } else if (result.status === "target-required") {
    ctx.ui.notify("The next review target could not be inferred safely.", "warning");
  } else {
    ctx.ui.notify(`Could not open the next Hunk review (${result.reason}).`, "warning");
  }
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
  const exclusiveStats = coordinator.getExclusiveFrameStats();
  const active = info
    ? `overlay:${info.state}${info.detail ? `(${info.detail})` : ""}` +
      ` launchCwd=${info.launchCwd}${info.repoRoot ? ` repoRoot=${info.repoRoot}` : ""}`
    : "none";
  let openNotes = "no-live-session";
  try {
    const review = await readHunkReview({
      cwd: info?.repoRoot ?? info?.launchCwd ?? ctx.cwd,
      sessionId: info?.sessionId,
      managedPid: info?.pid,
      hunkBinary: config.hunk.command,
      run: reviewRun,
    });
    if (review.status === "live") openNotes = String(review.notes.length);
  } catch (error) {
    openNotes = `unavailable(${error instanceof Error ? error.message : String(error)})`;
  }
  const hostMode = resolveOverlayHostMode(config.overlay);
  ctx.ui.notify(
    `Hunk: review=${config.review}, layout=${config.overlay.layout}, ` +
      `host=${hostMode}, ` +
      `active=${active}, command=${config.hunk.command}\n` +
      `open-notes=${openNotes}, last-auto-open=${describeSettledDecision(diagnostics.decision)}` +
      (exclusiveStats
        ? `\nexclusive-frame: state=${exclusiveStats.state}, direct=${exclusiveStats.directFrames}, ` +
          `rows=${exclusiveStats.directRows}, bytes=${exclusiveStats.directBytes}, ` +
          `revocations=${exclusiveStats.revocations}, suppressed-input=${exclusiveStats.suppressedInputRenders}`
        : ""),
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

  // The prefix and focused-overlay action keys were bound at session start.
  // A sparse review write reloads the file and may discover a concurrent
  // external binding edit, but it must not pretend those keys are live before
  // Pi reloads extensions.
  const runtimeBindings = store.get().bindings;
  try {
    await store.persist(ctx, "global", { review: value });
  } catch (error) {
    ctx.ui.notify(
      `Could not update global Hunk config: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return;
  }
  if (
    (["prefix", "toggle", "show"] as const).some(
      (binding) => store.get().bindings[binding] !== runtimeBindings[binding],
    )
  ) {
    store.patchSession({ bindings: runtimeBindings });
  }
  reportPersistedReviewPolicy(ctx, store, value);
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
  mutationTargetPaths,
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
