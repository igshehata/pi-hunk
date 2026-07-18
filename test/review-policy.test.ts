import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  explainSettledDecision,
  isReviewPolicy,
  settledAutoOpenAction,
  shouldEarlyOpenOnMutation,
} from "../extensions/config.ts";
import { isMutation } from "../extensions/change-detector.ts";

describe("shouldEarlyOpenOnMutation", () => {
  const base = {
    review: "live" as const,
    uiMode: "tui",
    alreadyOpenedForRun: false,
    activeBlocking: false,
  };

  it("allows the first live overlay mutation open", () => {
    expect(shouldEarlyOpenOnMutation(base)).toBe(true);
  });

  it("rejects after-run, off, non-tui, already-open, and blocking modes", () => {
    expect(shouldEarlyOpenOnMutation({ ...base, review: "after-run" })).toBe(false);
    expect(shouldEarlyOpenOnMutation({ ...base, review: "off" })).toBe(false);
    expect(shouldEarlyOpenOnMutation({ ...base, uiMode: "rpc" })).toBe(false);
    expect(shouldEarlyOpenOnMutation({ ...base, alreadyOpenedForRun: true })).toBe(false);
    expect(shouldEarlyOpenOnMutation({ ...base, activeBlocking: true })).toBe(false);
  });

  it("pairs with isMutation so reads never trigger early open", () => {
    const gate = shouldEarlyOpenOnMutation(base);
    expect(gate && isMutation("edit", { path: "a.ts" })).toBe(true);
    expect(gate && isMutation("write", { path: "a.ts" })).toBe(true);
    expect(gate && isMutation("bash", { command: "npm test" })).toBe(false);
    expect(gate && isMutation("read", { path: "a.ts" })).toBe(false);
    expect(gate && isMutation("bash", { command: "sed -i s/a/b/ x.ts" })).toBe(true);
  });
});

describe("settledAutoOpenAction", () => {
  it("skips when there is nothing to review, UI is blocked, or review was completed", () => {
    expect(
      settledAutoOpenAction({
        review: "after-run",
        uiMode: "tui",
        activeBlocking: false,
        shouldReview: false,
        hasLiveSurface: false,
      }),
    ).toBe("skip");

    expect(
      settledAutoOpenAction({
        review: "off",
        uiMode: "tui",
        activeBlocking: false,
        shouldReview: true,
        hasLiveSurface: false,
      }),
    ).toBe("skip");

    expect(
      settledAutoOpenAction({
        review: "after-run",
        uiMode: "tui",
        activeBlocking: true,
        shouldReview: true,
        hasLiveSurface: false,
      }),
    ).toBe("skip");

    expect(
      settledAutoOpenAction({
        review: "after-run",
        uiMode: "tui",
        activeBlocking: false,
        shouldReview: true,
        hasLiveSurface: false,
        autoOpenSuppression: "review-complete",
      }),
    ).toBe("skip");
  });

  it("launches after-run when the worktree changed", () => {
    expect(
      settledAutoOpenAction({
        review: "after-run",
        uiMode: "tui",
        activeBlocking: false,
        shouldReview: true,
        hasLiveSurface: false,
      }),
    ).toBe("launch");
  });

  it("for live skips any existing surface or recovers when none remains", () => {
    expect(
      settledAutoOpenAction({
        review: "live",
        uiMode: "tui",
        activeBlocking: false,
        shouldReview: true,
        hasLiveSurface: true,
      }),
    ).toBe("skip");

    expect(
      settledAutoOpenAction({
        review: "live",
        uiMode: "tui",
        activeBlocking: false,
        shouldReview: true,
        hasLiveSurface: false,
      }),
    ).toBe("recover");
  });
});

describe("explainSettledDecision (T17)", () => {
  const base = {
    review: "after-run" as const,
    uiMode: "tui",
    activeBlocking: false,
    activeVisible: false,
  };

  it("names skip reasons with review-off outranking no-change", () => {
    expect(explainSettledDecision({ ...base, action: "skip" })).toEqual({
      action: "skipped",
      reason: "no-change",
    });
    expect(explainSettledDecision({ ...base, action: "skip", review: "off" })).toEqual({
      action: "skipped",
      reason: "review-off",
    });
    expect(explainSettledDecision({ ...base, action: "skip", uiMode: "rpc" })).toEqual({
      action: "skipped",
      reason: "not-tui",
    });
    expect(explainSettledDecision({ ...base, action: "skip", activeBlocking: true })).toEqual({
      action: "skipped",
      reason: "blocking",
    });
    expect(
      explainSettledDecision({
        ...base,
        action: "skip",
        autoOpenSuppression: "review-complete",
      }),
    ).toEqual({
      action: "skipped",
      reason: "review-complete",
    });
    expect(
      explainSettledDecision({ ...base, action: "skip", autoOpenSuppression: "dismissed" }),
    ).toEqual({
      action: "skipped",
      reason: "dismissed",
    });
  });

  it("attributes recoveries and mutation-driven opens", () => {
    expect(explainSettledDecision({ ...base, action: "recover" })).toEqual({
      action: "opened",
      reason: "recover",
    });
    expect(explainSettledDecision({ ...base, action: "launch" })).toEqual({
      action: "opened",
      reason: "mutation",
    });
  });

  it("reports live skips and launches onto existing surfaces as skipped(already-open)", () => {
    expect(
      explainSettledDecision({
        ...base,
        action: "skip",
        review: "live",
        activeLive: true,
      }),
    ).toEqual({
      action: "skipped",
      reason: "already-open",
    });
    expect(explainSettledDecision({ ...base, action: "launch", activeVisible: true })).toEqual({
      action: "skipped",
      reason: "already-open",
    });
  });
});

describe("policy defaults", () => {
  it("validates review strings and ships overlay defaults", () => {
    expect(isReviewPolicy("after-run")).toBe(true);
    expect(isReviewPolicy("nope")).toBe(false);
    expect(DEFAULT_CONFIG.review).toBe("after-run");
    expect(DEFAULT_CONFIG.hunk.args).toContain("--watch");
    expect(DEFAULT_CONFIG).not.toHaveProperty("display");
  });
});
