import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReviewEvent, ReviewNote } from "../src/contract.js";
import { readFeedback, type FeedbackRead } from "../src/feedback.js";

const original: ReviewNote = {
  id: "first",
  view: "diff",
  revision: { kind: "working-tree" },
  path: "working.ts",
  body: "Original comment",
};

async function collectRaw(text: string): Promise<FeedbackRead> {
  const directory = await mkdtemp(join(tmpdir(), "pi-hunk-journal-"));
  try {
    const path = join(directory, "notes.jsonl");
    await writeFile(path, text);
    return await readFeedback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function collect(events: readonly ReviewEvent[], tail = ""): Promise<FeedbackRead> {
  return await collectRaw(`${events.map((event) => JSON.stringify(event)).join("\n")}\n${tail}`);
}

describe("saved review feedback", () => {
  it("keeps edited comments across bridge restarts without reviving removed comments", async () => {
    const { notes } = await collect([
      { _tag: "Ready" },
      { _tag: "Upsert", note: original },
      {
        _tag: "Upsert",
        note: {
          id: "removed",
          view: "show",
          revision: { kind: "commit", commit: "a".repeat(40) },
          path: "committed.ts",
          body: "Remove me",
        },
      },
      { _tag: "Upsert", note: { ...original, body: "Edited comment" } },
      { _tag: "Ready" },
      { _tag: "Remove", id: "removed" },
    ]);
    expect(notes.map(({ id, body }) => ({ id, body }))).toEqual([
      { id: "first", body: "Edited comment" },
    ]);
  });

  // Guards the bug where one kill mid-append (SIGKILL, full disk) cost every earlier comment:
  // an unterminated final record is an uncommitted tail, not a corrupt journal.
  it("keeps committed comments when a killed append leaves the final record half-written", async () => {
    const torn = '{"_tag":"Upsert","note":';
    const read = await collect([{ _tag: "Ready" }, { _tag: "Upsert", note: original }], torn);
    expect(read.notes.map(({ body }) => body)).toEqual(["Original comment"]);
    expect(read.uncommitted).toEqual({ line: 3, text: torn });
    // Only an unterminated final record is tolerated; a committed-but-corrupt one still fails.
    await expect(
      collect([{ _tag: "Ready" }, { _tag: "Upsert", note: original }], `${torn}\n`),
    ).rejects.toThrow(Error);
  });

  it("rejects a corrupt record in the middle of the journal", async () => {
    const committed = [{ _tag: "Ready" }, { _tag: "Upsert", note: original }]
      .map((event) => JSON.stringify(event))
      .join("\n");
    await expect(
      collectRaw(`${committed}\n{oops\n{"_tag":"Remove","id":"first"}\n`),
    ).rejects.toThrow(Error);
  });

  it("rejects earlier saved comments after a reported capture failure", async () => {
    await expect(
      collect([
        { _tag: "Ready" },
        { _tag: "Upsert", note: original },
        { _tag: "Failure", message: "Journal storage failed" },
      ]),
    ).rejects.toThrow(Error);
  });
});
