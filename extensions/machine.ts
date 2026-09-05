import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Cause, Data, Deferred, Effect, Either, Fiber, Queue, Ref } from "effect";
import { configureHotkeys, resetConfig } from "./config.ts";
import {
  DEFAULT_CONFIG,
  HUNK_MODES,
  type HunkConfig,
  type HunkMode,
  type LaunchIntent,
  type ReviewNote,
  type TakeoverResult,
} from "./model.ts";
import { launchTakeover, type TakeoverHandle } from "./takeover.ts";

export class MachineError extends Data.TaggedError("MachineError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface Session {
  readonly epoch: number;
  readonly intent: LaunchIntent;
  readonly ctx: ExtensionContext;
  readonly handle: TakeoverHandle;
  /** Finalized notes from preceding takeover epochs, reconciled by explicit tombstones. */
  readonly pendingNotes: readonly ReviewNote[];
}

type Completion = Deferred.Deferred<void, MachineError>;

interface Activity {
  readonly cancel: Deferred.Deferred<void>;
  readonly controller: AbortController;
  readonly fiber: Fiber.RuntimeFiber<void, never>;
}

interface ActivityState {
  readonly activity: Activity;
  readonly completion: Completion;
  readonly shutdowns: readonly Completion[];
}

type MachineState =
  | { readonly _tag: "Idle" }
  | ({ readonly _tag: "Choosing"; readonly ctx: ExtensionContext } & ActivityState)
  | ({ readonly _tag: "Configuring"; readonly ctx: ExtensionCommandContext } & ActivityState)
  | {
      readonly _tag: "Launching";
      readonly epoch: number;
      readonly intent: LaunchIntent;
      readonly ctx: ExtensionContext;
      readonly pendingNotes: readonly ReviewNote[];
      readonly completions: readonly Completion[];
      readonly shutdowns: readonly Completion[];
      readonly activity: Activity;
      readonly earlyExit?: TakeoverResult;
    }
  | ({ readonly _tag: "Running" } & Session)
  | {
      readonly _tag: "Stopping";
      readonly session: Session;
      readonly destination: "Idle" | "Stopped";
      readonly next?: { readonly intent: LaunchIntent; readonly ctx: ExtensionContext };
      readonly completions: readonly Completion[];
      readonly shutdowns: readonly Completion[];
    }
  | {
      readonly _tag: "Switching";
      readonly ctx: ExtensionContext;
      readonly notes: readonly ReviewNote[];
      readonly next: { readonly intent: LaunchIntent; readonly ctx: ExtensionContext };
      readonly completions: readonly Completion[];
      readonly shutdowns: readonly Completion[];
    }
  | {
      readonly _tag: "Delivering";
      readonly ctx: ExtensionContext;
      readonly notes: readonly ReviewNote[];
      readonly destination: "Idle" | "Stopped";
      readonly completions: readonly Completion[];
      readonly shutdowns: readonly Completion[];
    }
  | { readonly _tag: "Stopped" };

type ActivityOutcome<A> =
  | { readonly _tag: "Completed"; readonly result: Either.Either<A, MachineError> }
  | { readonly _tag: "Cancelled" };

type MachineCommand =
  | { readonly _tag: "Choose"; readonly ctx: ExtensionContext; readonly completion: Completion }
  | {
      readonly _tag: "Toggle";
      readonly ctx: ExtensionContext;
      readonly intent: LaunchIntent;
      readonly completion: Completion;
    }
  | {
      readonly _tag: "Configure";
      readonly ctx: ExtensionCommandContext;
      readonly operation: "edit" | "restore";
      readonly completion: Completion;
    }
  | { readonly _tag: "ChoiceResolved"; readonly outcome: ActivityOutcome<HunkMode | undefined> }
  | { readonly _tag: "ConfigurationResolved"; readonly outcome: ActivityOutcome<void> }
  | {
      readonly _tag: "LaunchResolved";
      readonly epoch: number;
      readonly outcome: ActivityOutcome<TakeoverHandle>;
    }
  | {
      readonly _tag: "TakeoverExited";
      readonly epoch: number;
      readonly result: TakeoverResult;
    }
  | { readonly _tag: "Shutdown"; readonly completion: Completion };

const ALLOWED_TRANSITIONS: Record<MachineState["_tag"], readonly MachineState["_tag"][]> = {
  Idle: ["Idle", "Choosing", "Configuring", "Launching", "Delivering", "Stopped"],
  Choosing: ["Choosing", "Idle", "Launching", "Stopped"],
  Configuring: ["Configuring", "Idle", "Stopped"],
  Launching: ["Launching", "Running", "Stopping", "Delivering", "Idle", "Stopped"],
  Running: ["Stopping", "Switching", "Delivering"],
  Stopping: ["Stopping", "Switching", "Delivering"],
  Switching: ["Launching", "Delivering", "Idle", "Stopped"],
  Delivering: ["Idle", "Stopped"],
  Stopped: ["Stopped"],
};

function formatFeedback(notes: readonly ReviewNote[]): string {
  return [
    "Hunk feedback was submitted. Address every note below comment-by-comment, then run the relevant checks.",
    JSON.stringify({ status: "submitted", notes }, null, 2),
  ].join("\n\n");
}

/**
 * Each takeover emits one final snapshot for its own Hunk process. Preserve finalized notes from
 * earlier mode processes, then apply explicit removals and replacements observed by this process.
 */
function reconcileSessionNotes(
  earlier: readonly ReviewNote[],
  result: TakeoverResult,
): readonly ReviewNote[] {
  const reconciled = new Map(earlier.map((note) => [note.noteId, note]));
  for (const noteId of result.removedNoteIds ?? []) reconciled.delete(noteId);
  for (const note of result.notes) reconciled.set(note.noteId, note);
  return [...reconciled.values()];
}

function describeTermination(result: TakeoverResult): string | undefined {
  switch (result.termination._tag) {
    case "Exited":
      return result.termination.exitCode === 0
        ? undefined
        : `Hunk exited unexpectedly with code ${result.termination.exitCode}.`;
    case "Signaled":
      return `Hunk exited unexpectedly from ${result.termination.signal}.`;
    case "StartupFailed":
      return result.termination.detail;
  }
}

function chooseMode(
  ctx: ExtensionContext,
  config: HunkConfig,
  signal: AbortSignal,
): Effect.Effect<HunkMode | undefined, MachineError> {
  return Effect.tryPromise({
    try: async () => {
      let cancel = (): void => {};
      const abort = (): void => cancel();
      signal.addEventListener("abort", abort, { once: true });
      try {
        const result = ctx.ui.custom<HunkMode | undefined>((_tui, theme, _keybindings, done) => {
          let settled = false;
          const finish = (mode: HunkMode | undefined): void => {
            if (settled) return;
            settled = true;
            done(mode);
          };
          cancel = () => finish(undefined);
          return {
            render(width: number): string[] {
              return [
                theme.fg("accent", theme.bold("Pi-hunk")),
                `${config.hotkeys.diff} diff · ${config.hotkeys.show} show · ${config.hotkeys.stash} stash · esc cancel`,
              ].map((line) => truncateToWidth(line, width));
            },
            handleInput(data: string): void {
              if (matchesKey(data, "escape")) {
                finish(undefined);
                return;
              }
              for (const mode of HUNK_MODES) {
                if (matchesKey(data, config.hotkeys[mode])) {
                  finish(mode);
                  return;
                }
              }
            },
            invalidate(): void {},
          };
        });
        if (signal.aborted) cancel();
        return await result;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    catch: (cause) => new MachineError({ message: "Could not open the Pi-hunk chooser.", cause }),
  });
}

function toMachineError(message: string, cause: unknown): MachineError {
  return cause instanceof MachineError ? cause : new MachineError({ message, cause });
}

export interface HunkMachine {
  readonly choose: (ctx: ExtensionContext) => Promise<void>;
  readonly toggle: (ctx: ExtensionContext, mode: HunkMode, target?: string) => Promise<void>;
  readonly configure: (
    ctx: ExtensionCommandContext,
    operation?: "edit" | "restore",
  ) => Promise<void>;
  readonly shutdown: () => Promise<void>;
}

export function makeHunkMachine(pi: ExtensionAPI, config: HunkConfig): Effect.Effect<HunkMachine> {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<MachineCommand>();
    const state = yield* Ref.make<MachineState>({ _tag: "Idle" });
    let nextEpoch = 1;

    const transition = (next: MachineState): Effect.Effect<void> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (!ALLOWED_TRANSITIONS[current._tag].includes(next._tag)) {
          return yield* Effect.die(
            new Error(`Invalid Pi-hunk state transition: ${current._tag} -> ${next._tag}.`),
          );
        }
        yield* Ref.set(state, next);
      });

    const notify = (
      ctx: ExtensionContext,
      message: string,
      type: "info" | "warning" | "error",
    ): Effect.Effect<void> =>
      Effect.ignore(
        Effect.try({
          try: () => ctx.ui.notify(message, type),
          catch: () => undefined,
        }),
      );

    const deliver = (
      ctx: ExtensionContext,
      notes: readonly ReviewNote[],
    ): Effect.Effect<void, MachineError> => {
      if (notes.length === 0) return Effect.void;
      return Effect.try({
        try: () => {
          pi.sendUserMessage(formatFeedback(notes));
        },
        catch: (cause) => new MachineError({ message: "Could not send Hunk feedback.", cause }),
      });
    };

    const complete = (completion: Completion): Effect.Effect<void> =>
      Deferred.succeed(completion, undefined).pipe(Effect.asVoid);
    const reject = (completion: Completion, error: MachineError): Effect.Effect<void> =>
      Deferred.fail(completion, error).pipe(Effect.asVoid);
    const completeAll = (completions: readonly Completion[]): Effect.Effect<void> =>
      Effect.all(completions.map(complete), { discard: true });
    const rejectAll = (
      completions: readonly Completion[],
      error: MachineError,
    ): Effect.Effect<void> =>
      Effect.all(
        completions.map((item) => reject(item, error)),
        { discard: true },
      );

    const startActivity = <A>(
      operation: (signal: AbortSignal) => Effect.Effect<A, MachineError>,
      command: (outcome: ActivityOutcome<A>) => MachineCommand,
    ): Effect.Effect<Activity> =>
      Effect.gen(function* () {
        const cancel = yield* Deferred.make<void>();
        const controller = new AbortController();
        const completed = Effect.either(operation(controller.signal)).pipe(
          Effect.map(
            (result): ActivityOutcome<A> => ({
              _tag: "Completed",
              result,
            }),
          ),
        );
        const cancelled = Deferred.await(cancel).pipe(
          Effect.as<ActivityOutcome<A>>({ _tag: "Cancelled" }),
        );
        const fiber = yield* Effect.forkDaemon(
          Effect.raceFirst(completed, cancelled).pipe(
            Effect.flatMap((outcome) =>
              Queue.offer(queue, command(outcome)).pipe(Effect.uninterruptible),
            ),
            Effect.asVoid,
          ),
        );
        return { cancel, controller, fiber };
      });

    const launchOperation = (
      epoch: number,
      intent: LaunchIntent,
      ctx: ExtensionContext,
      signal: AbortSignal,
    ): Effect.Effect<TakeoverHandle, MachineError> => {
      const waitForHost = ctx.isIdle()
        ? Effect.void
        : "waitForIdle" in ctx
          ? Effect.tryPromise({
              try: () => (ctx as ExtensionCommandContext).waitForIdle(),
              catch: (cause) =>
                new MachineError({ message: "Could not wait for the host to become idle.", cause }),
            })
          : Effect.fail(
              new MachineError({ message: "Wait for the agent to finish before opening Hunk." }),
            );
      return waitForHost.pipe(
        Effect.andThen(
          launchTakeover(
            {
              ctx,
              config,
              mode: intent.mode,
              target: intent.target,
              onExit: (result) => {
                queue.unsafeOffer({ _tag: "TakeoverExited", epoch, result });
              },
            },
            signal,
          ),
        ),
        Effect.mapError((cause) => toMachineError("Could not start Hunk.", cause)),
      );
    };

    const finishExit = (
      ctx: ExtensionContext,
      result: TakeoverResult,
      destination: "Idle" | "Stopped",
      completions: readonly Completion[] = [],
      shutdowns: readonly Completion[] = [],
      terminationPolicy: "report" | "ignore" = "report",
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const notes = result.feedbackError ? [] : result.notes;
        yield* transition({
          _tag: "Delivering",
          ctx,
          notes,
          destination,
          completions,
          shutdowns,
        });
        if (result.feedbackError) {
          yield* notify(
            ctx,
            `Pi-hunk could not capture feedback: ${result.feedbackError}`,
            "error",
          );
        }
        const delivery = yield* Effect.either(deliver(ctx, notes));
        if (Either.isLeft(delivery)) yield* notify(ctx, delivery.left.message, "error");
        const unexpected =
          terminationPolicy === "report" && !result.prefixAction
            ? describeTermination(result)
            : undefined;
        if (unexpected) yield* notify(ctx, unexpected, "error");
        yield* transition({ _tag: destination });
        yield* completeAll(completions);
        yield* completeAll(shutdowns);
      });

    const beginLaunch = (
      intent: LaunchIntent,
      ctx: ExtensionContext,
      completions: readonly Completion[] = [],
      pendingNotes: readonly ReviewNote[] = [],
      shutdowns: readonly Completion[] = [],
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (ctx.mode !== "tui") {
          const error = new MachineError({
            message: "Hunk takeover requires interactive TUI mode.",
          });
          if (pendingNotes.length > 0) {
            yield* transition({
              _tag: "Delivering",
              ctx,
              notes: pendingNotes,
              destination: shutdowns.length > 0 ? "Stopped" : "Idle",
              completions,
              shutdowns,
            });
            const delivery = yield* Effect.either(deliver(ctx, pendingNotes));
            if (Either.isLeft(delivery)) yield* notify(ctx, delivery.left.message, "error");
          }
          yield* transition({ _tag: shutdowns.length > 0 ? "Stopped" : "Idle" });
          yield* notify(ctx, error.message, "warning");
          yield* rejectAll(completions, error);
          yield* completeAll(shutdowns);
          return;
        }

        const epoch = nextEpoch++;
        const activity = yield* startActivity(
          (signal) => launchOperation(epoch, intent, ctx, signal),
          (outcome) => ({
            _tag: "LaunchResolved",
            epoch,
            outcome,
          }),
        );
        yield* transition({
          _tag: "Launching",
          epoch,
          intent,
          ctx,
          pendingNotes,
          completions,
          shutdowns,
          activity,
        });
      });

    const switchExit = (
      ctx: ExtensionContext,
      notes: readonly ReviewNote[],
      next: { readonly intent: LaunchIntent; readonly ctx: ExtensionContext },
      completions: readonly Completion[] = [],
      shutdowns: readonly Completion[] = [],
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* transition({ _tag: "Switching", ctx, notes, next, completions, shutdowns });
        yield* beginLaunch(next.intent, next.ctx, completions, notes, shutdowns);
      });

    const processRunningExit = (session: Session, result: TakeoverResult): Effect.Effect<void> => {
      const reconciled: TakeoverResult = {
        ...result,
        notes: result.feedbackError ? [] : reconcileSessionNotes(session.pendingNotes, result),
      };
      const nextMode =
        result.prefixAction && result.prefixAction !== session.intent.mode
          ? result.prefixAction
          : undefined;
      if (nextMode) {
        return switchExit(session.ctx, reconciled.notes, {
          intent: { mode: nextMode, cwd: session.intent.cwd },
          ctx: session.ctx,
        });
      }
      return finishExit(session.ctx, reconciled, "Idle");
    };

    const processStoppingExit = (
      stopping: Extract<MachineState, { readonly _tag: "Stopping" }>,
      result: TakeoverResult,
    ): Effect.Effect<void> => {
      const reconciled: TakeoverResult = {
        ...result,
        notes: result.feedbackError
          ? []
          : reconcileSessionNotes(stopping.session.pendingNotes, result),
      };
      if (stopping.next) {
        return switchExit(
          stopping.session.ctx,
          reconciled.notes,
          stopping.next,
          stopping.completions,
          stopping.shutdowns,
        );
      }
      return finishExit(
        stopping.session.ctx,
        reconciled,
        stopping.destination,
        stopping.completions,
        stopping.shutdowns,
        "ignore",
      );
    };

    const handleCommand = (command: MachineCommand): Effect.Effect<void> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        switch (command._tag) {
          case "Choose": {
            if (current._tag !== "Idle") {
              yield* reject(
                command.completion,
                new MachineError({ message: `Pi-hunk is ${current._tag.toLowerCase()}.` }),
              );
              return;
            }
            if (command.ctx.mode !== "tui") {
              const error = new MachineError({ message: "Pi-hunk requires interactive TUI mode." });
              yield* notify(command.ctx, error.message, "warning");
              yield* reject(command.completion, error);
              return;
            }
            const activity = yield* startActivity(
              (signal) => chooseMode(command.ctx, config, signal),
              (outcome) => ({
                _tag: "ChoiceResolved",
                outcome,
              }),
            );
            yield* transition({
              _tag: "Choosing",
              ctx: command.ctx,
              completion: command.completion,
              shutdowns: [],
              activity,
            });
            return;
          }
          case "ChoiceResolved": {
            if (current._tag !== "Choosing") return;
            yield* Fiber.await(current.activity.fiber);
            if (current.shutdowns.length > 0 || command.outcome._tag === "Cancelled") {
              yield* transition({ _tag: "Stopped" });
              yield* complete(current.completion);
              yield* completeAll(current.shutdowns);
              return;
            }
            if (Either.isLeft(command.outcome.result)) {
              yield* transition({ _tag: "Idle" });
              yield* reject(current.completion, command.outcome.result.left);
              return;
            }
            if (!command.outcome.result.right) {
              yield* transition({ _tag: "Idle" });
              yield* complete(current.completion);
              return;
            }
            yield* beginLaunch(
              { mode: command.outcome.result.right, cwd: current.ctx.cwd },
              current.ctx,
              [current.completion],
            );
            return;
          }
          case "Toggle": {
            if (current._tag === "Idle") {
              yield* beginLaunch(command.intent, command.ctx, [command.completion]);
              return;
            }
            if (current._tag === "Running") {
              const next =
                current.intent.mode === command.intent.mode
                  ? undefined
                  : { intent: command.intent, ctx: command.ctx };
              yield* transition({
                _tag: "Stopping",
                session: current,
                destination: "Idle",
                next,
                completions: [command.completion],
                shutdowns: [],
              });
              yield* current.handle.stop;
              return;
            }
            yield* reject(
              command.completion,
              new MachineError({ message: `Pi-hunk is ${current._tag.toLowerCase()}.` }),
            );
            return;
          }
          case "Configure": {
            if (current._tag !== "Idle") {
              yield* reject(
                command.completion,
                new MachineError({ message: `Pi-hunk is ${current._tag.toLowerCase()}.` }),
              );
              return;
            }
            if (command.ctx.mode !== "tui") {
              const error = new MachineError({
                message: "Interactive Pi-hunk configuration requires TUI mode.",
              });
              yield* notify(command.ctx, error.message, "warning");
              yield* reject(command.completion, error);
              return;
            }
            const operation = (signal: AbortSignal): Effect.Effect<void, MachineError> =>
              command.operation === "restore"
                ? resetConfig.pipe(
                    Effect.tap(() =>
                      notify(
                        command.ctx,
                        `Pi-hunk hotkeys restored. Reload host plugins to activate ${DEFAULT_CONFIG.hotkeys.prefix}.`,
                        "info",
                      ),
                    ),
                    Effect.mapError((cause) => toMachineError(cause.message, cause)),
                  )
                : configureHotkeys(command.ctx, config, signal).pipe(
                    Effect.mapError((cause) => toMachineError(cause.message, cause)),
                  );
            const activity = yield* startActivity(operation, (outcome) => ({
              _tag: "ConfigurationResolved",
              outcome,
            }));
            yield* transition({
              _tag: "Configuring",
              ctx: command.ctx,
              completion: command.completion,
              shutdowns: [],
              activity,
            });
            return;
          }
          case "ConfigurationResolved": {
            if (current._tag !== "Configuring") return;
            yield* Fiber.await(current.activity.fiber);
            if (current.shutdowns.length > 0 || command.outcome._tag === "Cancelled") {
              yield* transition({ _tag: "Stopped" });
              yield* complete(current.completion);
              yield* completeAll(current.shutdowns);
              return;
            }
            yield* transition({ _tag: "Idle" });
            if (Either.isLeft(command.outcome.result)) {
              yield* reject(current.completion, command.outcome.result.left);
              return;
            }
            yield* complete(current.completion);
            return;
          }
          case "LaunchResolved": {
            if (current._tag !== "Launching" || current.epoch !== command.epoch) {
              if (command.outcome._tag === "Completed" && Either.isRight(command.outcome.result)) {
                yield* command.outcome.result.right.stop;
              }
              return;
            }
            yield* Fiber.await(current.activity.fiber);
            if (current.shutdowns.length > 0) {
              if (command.outcome._tag === "Completed" && Either.isRight(command.outcome.result)) {
                const session: Session = {
                  epoch: current.epoch,
                  intent: current.intent,
                  ctx: current.ctx,
                  handle: command.outcome.result.right,
                  pendingNotes: current.pendingNotes,
                };
                if (current.earlyExit) {
                  yield* finishExit(
                    current.ctx,
                    current.earlyExit,
                    "Stopped",
                    current.completions,
                    current.shutdowns,
                    "ignore",
                  );
                  return;
                }
                yield* transition({
                  _tag: "Stopping",
                  session,
                  destination: "Stopped",
                  completions: current.completions,
                  shutdowns: current.shutdowns,
                });
                yield* session.handle.stop;
                return;
              }
              yield* transition({ _tag: "Stopped" });
              yield* completeAll(current.completions);
              yield* completeAll(current.shutdowns);
              return;
            }
            if (command.outcome._tag === "Cancelled") {
              const error = new MachineError({ message: "Hunk launch was cancelled." });
              yield* transition({ _tag: "Idle" });
              yield* rejectAll(current.completions, error);
              return;
            }
            if (Either.isLeft(command.outcome.result)) {
              if (current.pendingNotes.length > 0) {
                yield* transition({
                  _tag: "Delivering",
                  ctx: current.ctx,
                  notes: current.pendingNotes,
                  destination: "Idle",
                  completions: current.completions,
                  shutdowns: [],
                });
                const delivery = yield* Effect.either(deliver(current.ctx, current.pendingNotes));
                if (Either.isLeft(delivery)) {
                  yield* notify(current.ctx, delivery.left.message, "error");
                }
              }
              yield* transition({ _tag: "Idle" });
              yield* notify(current.ctx, command.outcome.result.left.message, "error");
              yield* rejectAll(current.completions, command.outcome.result.left);
              return;
            }
            const session: Session = {
              epoch: current.epoch,
              intent: current.intent,
              ctx: current.ctx,
              handle: command.outcome.result.right,
              pendingNotes: current.pendingNotes,
            };
            yield* transition({ _tag: "Running", ...session });
            yield* completeAll(current.completions);
            if (current.earlyExit) yield* processRunningExit(session, current.earlyExit);
            return;
          }
          case "TakeoverExited": {
            if (current._tag === "Launching" && current.epoch === command.epoch) {
              yield* transition({ ...current, earlyExit: command.result });
              return;
            }
            if (current._tag === "Running" && current.epoch === command.epoch) {
              yield* processRunningExit(current, command.result);
              return;
            }
            if (current._tag === "Stopping" && current.session.epoch === command.epoch) {
              yield* processStoppingExit(current, command.result);
            }
            return;
          }
          case "Shutdown": {
            if (current._tag === "Stopped") {
              yield* complete(command.completion);
              return;
            }
            if (current._tag === "Idle") {
              yield* transition({ _tag: "Stopped" });
              yield* complete(command.completion);
              return;
            }
            if (current._tag === "Choosing" || current._tag === "Configuring") {
              yield* transition({
                ...current,
                shutdowns: [...current.shutdowns, command.completion],
              });
              current.activity.controller.abort();
              yield* Deferred.succeed(current.activity.cancel, undefined).pipe(Effect.asVoid);
              return;
            }
            if (current._tag === "Launching") {
              yield* transition({
                ...current,
                shutdowns: [...current.shutdowns, command.completion],
              });
              yield* Deferred.succeed(current.activity.cancel, undefined).pipe(Effect.asVoid);
              current.activity.controller.abort();
              return;
            }
            if (current._tag === "Running") {
              yield* transition({
                _tag: "Stopping",
                session: current,
                destination: "Stopped",
                completions: [],
                shutdowns: [command.completion],
              });
              yield* current.handle.stop;
              return;
            }
            if (current._tag === "Stopping") {
              yield* transition({
                ...current,
                destination: "Stopped",
                next: undefined,
                shutdowns: [...current.shutdowns, command.completion],
              });
              return;
            }
            yield* transition({ _tag: "Stopped" });
            yield* completeAll([...current.completions, ...current.shutdowns, command.completion]);
          }
        }
      });

    const dispatchLoop = (): Effect.Effect<void> =>
      Effect.suspend(() =>
        Queue.take(queue).pipe(
          Effect.flatMap(handleCommand),
          Effect.catchAllCause((cause) =>
            Effect.sync(() => {
              console.error("Pi-hunk state machine failed", Cause.pretty(cause));
            }),
          ),
          Effect.flatMap(() => Ref.get(state)),
          Effect.flatMap((current) => (current._tag === "Stopped" ? Effect.void : dispatchLoop())),
        ),
      );
    const dispatcher = yield* Effect.forkDaemon(dispatchLoop());

    const requestEffect = (
      makeCommand: (completion: Completion) => MachineCommand,
    ): Effect.Effect<void, MachineError> =>
      Effect.gen(function* () {
        const completion = yield* Deferred.make<void, MachineError>();
        const command = makeCommand(completion);
        const current = yield* Ref.get(state);
        if (current._tag === "Stopped") {
          if (command._tag === "Shutdown") return;
          return yield* Effect.fail(new MachineError({ message: "Pi-hunk is stopped." }));
        }
        yield* Queue.offer(queue, command);
        yield* Deferred.await(completion);
      });
    const request = (makeCommand: (completion: Completion) => MachineCommand): Promise<void> =>
      Effect.runPromise(requestEffect(makeCommand));

    const preemptForShutdown = (): void => {
      const current = Effect.runSync(Ref.get(state));
      if (
        current._tag === "Choosing" ||
        current._tag === "Configuring" ||
        current._tag === "Launching"
      ) {
        current.activity.controller.abort();
      } else if (current._tag === "Running") {
        Effect.runSync(current.handle.stop);
      }
    };

    return {
      choose: (ctx) => request((completion) => ({ _tag: "Choose", ctx, completion })),
      toggle: (ctx, mode, target) =>
        request((completion) => ({
          _tag: "Toggle",
          ctx,
          intent: { mode, cwd: ctx.cwd, ...(target ? { target } : {}) },
          completion,
        })),
      configure: (ctx, operation = "edit") =>
        request((completion) => ({ _tag: "Configure", ctx, operation, completion })),
      shutdown: () => {
        preemptForShutdown();
        return Effect.runPromise(
          requestEffect((completion) => ({ _tag: "Shutdown", completion })).pipe(
            Effect.andThen(Fiber.await(dispatcher)),
            Effect.asVoid,
          ),
        );
      },
    };
  });
}
