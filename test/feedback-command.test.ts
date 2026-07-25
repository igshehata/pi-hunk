import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { formatManualFeedback, handleFeedback, handleReviewAction } from "../extensions/index.ts";
import type { HunkReviewNote } from "../extensions/review-handoff.ts";

function note(): HunkReviewNote {
  return {
    noteId: "user:1",
    file: "src/main.ts",
    oldLine: null,
    newLine: 12,
    oldRange: null,
    newRange: [12, 12],
    summary: "Handle the failure",
    rationale: "Do not swallow this error.",
  };
}

function context(mode: "tui" | "rpc" = "tui") {
  return {
    mode,
    cwd: "/repo",
    waitForIdle: vi.fn(async () => undefined),
    ui: { notify: vi.fn() },
  } as unknown as ExtensionCommandContext;
}

describe("feedback commands", () => {
  it("forces an immediate comment probe without waiting for agent idle", async () => {
    const ctx = context();
    const gate = {
      submit: vi.fn(async () => ({
        status: "pending" as const,
        message: "No new notes were found.",
        notes: [] as [],
      })),
    };

    await handleReviewAction(ctx, gate);

    expect(ctx.waitForIdle).not.toHaveBeenCalled();
    expect(gate.submit).toHaveBeenCalledWith(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("No new notes were found.", "info");
  });

  it("keeps /hunk feedback as an alias for the immediate probe", async () => {
    const ctx = context();
    const gate = {
      submit: vi.fn(async () => ({
        status: "submitted" as const,
        message: "1 open Hunk review note(s).",
        notes: [note()],
      })),
    };

    await handleFeedback(ctx, gate);

    expect(gate.submit).toHaveBeenCalledWith(ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("1 open Hunk review note(s).", "info");
  });

  it("does not probe outside TUI mode", async () => {
    const ctx = context("rpc");
    const gate = { submit: vi.fn() };

    await handleFeedback(ctx, gate);

    expect(gate.submit).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Hunk feedback requires Pi's interactive TUI mode.",
      "warning",
    );
  });

  it("formats comments for automatic user-turn delivery", () => {
    const message = formatManualFeedback([note()]);
    expect(message).toContain("Hunk feedback was submitted");
    expect(message).toContain("Handle the failure");
  });
});
