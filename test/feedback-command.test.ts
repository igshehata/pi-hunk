import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { formatManualFeedback, handleFeedback } from "../extensions/index.ts";
import type { BlockingReviewResult, HunkReviewNote } from "../extensions/review-handoff.ts";

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

describe("/hunk feedback", () => {
  it("waits for review and sends submitted notes back as a user turn", async () => {
    const ctx = context();
    const result: BlockingReviewResult = {
      status: "submitted",
      message: "1 open Hunk review note(s).",
      notes: [note()],
    };
    const gate = { wait: vi.fn(async () => result) };
    const sendUserMessage = vi.fn();

    await handleFeedback(ctx, gate, sendUserMessage);

    expect(ctx.waitForIdle).toHaveBeenCalledOnce();
    expect(gate.wait).toHaveBeenCalledWith(ctx);
    expect(sendUserMessage).toHaveBeenCalledOnce();
    expect(sendUserMessage.mock.calls[0]?.[0]).toBe(formatManualFeedback(result.notes));
    expect(sendUserMessage.mock.calls[0]?.[0]).toContain("Handle the failure");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Sent 1 Hunk feedback note to the agent.", "info");
  });

  it("reports approval without starting an unnecessary agent turn", async () => {
    const ctx = context();
    const gate = {
      wait: vi.fn(async () => ({
        status: "approved" as const,
        message: "No new Hunk user notes were found.",
        notes: [] as [],
      })),
    };
    const sendUserMessage = vi.fn();

    await handleFeedback(ctx, gate, sendUserMessage);

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("No new Hunk user notes were found.", "info");
  });

  it("does not start feedback collection outside TUI mode", async () => {
    const ctx = context("rpc");
    const gate = { wait: vi.fn() };

    await handleFeedback(ctx, gate, vi.fn());

    expect(ctx.waitForIdle).not.toHaveBeenCalled();
    expect(gate.wait).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Hunk feedback requires Pi's interactive TUI mode.",
      "warning",
    );
  });
});
