import type { ReviewPolicy } from "./config-schema.ts";

export type AutoOpenSuppressionReason = "review-complete" | "dismissed";

export function shouldEarlyOpenOnMutation(options: {
  review: ReviewPolicy;
  uiMode: string;
  alreadyOpenedForRun: boolean;
  activeBlocking: boolean;
}): boolean {
  return (
    options.review === "live" &&
    options.uiMode === "tui" &&
    !options.alreadyOpenedForRun &&
    !options.activeBlocking
  );
}

export type SettledOpenReason = "mutation" | "recover";
export type SettledSkipReason =
  | "no-change"
  | "review-off"
  | "already-open"
  | "not-tui"
  | "blocking"
  | "no-diff"
  | "target-required"
  | AutoOpenSuppressionReason;

export type SettledDecision =
  | { action: "opened"; reason: SettledOpenReason }
  | { action: "skipped"; reason: SettledSkipReason }
  | { action: "failed"; reason: SettledOpenReason; error: string };

export function settledAutoOpenAction(options: {
  review: ReviewPolicy;
  uiMode: string;
  activeBlocking: boolean;
  shouldReview: boolean;
  hasLiveSurface: boolean;
  autoOpenSuppression?: AutoOpenSuppressionReason | null;
}): "skip" | "launch" | "recover" {
  if (
    options.autoOpenSuppression ||
    !options.shouldReview ||
    options.review === "off" ||
    options.activeBlocking ||
    options.uiMode !== "tui"
  ) {
    return "skip";
  }
  if (options.review === "live") return options.hasLiveSurface ? "skip" : "recover";
  return "launch";
}

export function explainSettledDecision(options: {
  action: "skip" | "launch" | "recover";
  review: ReviewPolicy;
  uiMode: string;
  activeBlocking: boolean;
  activeVisible: boolean;
  activeLive?: boolean;
  autoOpenSuppression?: AutoOpenSuppressionReason | null;
}): SettledDecision {
  if (options.action === "skip") {
    if (options.review === "off") return { action: "skipped", reason: "review-off" };
    if (options.uiMode !== "tui") return { action: "skipped", reason: "not-tui" };
    if (options.activeBlocking) return { action: "skipped", reason: "blocking" };
    if (options.autoOpenSuppression)
      return { action: "skipped", reason: options.autoOpenSuppression };
    if (options.review === "live" && (options.activeLive ?? options.activeVisible)) {
      return { action: "skipped", reason: "already-open" };
    }
    return { action: "skipped", reason: "no-change" };
  }
  if (options.action === "recover") return { action: "opened", reason: "recover" };
  if (options.activeVisible) return { action: "skipped", reason: "already-open" };
  return { action: "opened", reason: "mutation" };
}
