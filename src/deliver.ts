import { setTimeout as delay } from "node:timers/promises";
import type { Delivery } from "./contract.js";

/** What delivering a message needs from a session; the host context and the live review both have it. */
export interface DeliveryTarget {
  isIdle(): boolean;
  abort(): void;
  readonly ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

/** A host's one-message entrypoint; identical to `HostBindings["sendUserMessage"]`. */
export type SendUserMessage = (
  message: string,
  options?: { deliverAs: "steer" | "followUp" },
) => void;

/** How long `interrupt` delivery waits for the aborted turn to become idle before queueing. */
const INTERRUPT_IDLE_TIMEOUT_MS = 30_000;

/**
 * Waits `ms`, returning as soon as `signal` aborts. Callers re-check `signal.aborted`; an abort is
 * never an error, because a cancelled operation sends nothing.
 */
export async function idleTick(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

/**
 * Hands one message to the agent under the configured delivery. It is the same handoff for the
 * static review, which sends everything at once when Hunk closes, and the live review, which sends
 * one comment change at a time: a busy agent gets the message mid-turn (steer), after the turn
 * (followUp), or only once the interrupted turn has really stopped (interrupt).
 *
 * `recoveryHint` names the journal a timed-out interrupt still owes the user; without it the
 * warning is the same text a review that never ran with a journal would raise.
 */
export async function deliver(
  ctx: DeliveryTarget,
  send: SendUserMessage,
  delivery: Delivery,
  message: string,
  signal: AbortSignal,
  recoveryHint?: string,
): Promise<void> {
  if (!ctx.isIdle() && delivery === "interrupt") {
    // Native abort returns void. In particular Pi restores prior queues to
    // its composer; we neither await abort nor replace those native semantics.
    ctx.abort();
    // An abort that never makes the session idle must not leave the review silent and the
    // keyboard unowned: the wait is bounded and says what it is waiting for.
    const deadline = Date.now() + INTERRUPT_IDLE_TIMEOUT_MS;
    let announced = false;
    while (!ctx.isIdle() && !signal.aborted && Date.now() < deadline) {
      if (!announced) {
        announced = true;
        ctx.ui.notify(
          "Hunk review: interrupting the current turn; waiting for the agent to become idle.",
          "info",
        );
      }
      await idleTick(20, signal);
    }
    if (!ctx.isIdle() && !signal.aborted)
      ctx.ui.notify(
        `Hunk review: the agent is still busy after interrupting; the comments were queued as a follow-up.${
          recoveryHint === undefined ? "" : ` Recovery: ${recoveryHint}`
        }`,
        "warning",
      );
  }
  // A review cancelled during the wait sends nothing: its journal is the only copy left.
  if (signal.aborted) return;
  if (ctx.isIdle()) send(message);
  else
    send(message, {
      // An interrupt that timed out falls back to the follow-up queue; comments are never
      // dropped because the turn did not stop.
      deliverAs: delivery === "steer" ? "steer" : "followUp",
    });
}
