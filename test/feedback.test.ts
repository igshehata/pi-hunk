import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import type { ReviewEvent, ReviewNote } from "../src/contract.js";
import { readFeedback } from "../src/feedback.js";

const original: ReviewNote = {
  id: "first",
  view: "diff",
  path: "working.ts",
  body: "Original comment",
};

async function collect(events: readonly ReviewEvent[], tail = ""): Promise<readonly ReviewNote[]> {
  const directory = await mkdtemp(join(tmpdir(), "pi-hunk-journal-"));
  try {
    const path = join(directory, "notes.jsonl");
    await writeFile(path, `${events.map((event) => JSON.stringify(event)).join("\n")}\n${tail}`);
    return await Effect.runPromise(readFeedback(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("saved review feedback", () => {
  it("keeps edited comments across bridge restarts without reviving removed comments", async () => {
    const notes = await collect([
      { _tag: "Ready" },
      { _tag: "Upsert", note: original },
      {
        _tag: "Upsert",
        note: { id: "removed", view: "show", path: "committed.ts", body: "Remove me" },
      },
      { _tag: "Upsert", note: { ...original, body: "Edited comment" } },
      { _tag: "Ready" },
      { _tag: "Remove", id: "removed" },
    ]);
    expect(notes.map(({ id, body }) => ({ id, body }))).toEqual([
      { id: "first", body: "Edited comment" },
    ]);
  });

  it("rejects the whole review when its final journal record is truncated", async () => {
    await expect(
      collect([{ _tag: "Ready" }, { _tag: "Upsert", note: original }], '{"_tag":"Upsert","note":'),
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
