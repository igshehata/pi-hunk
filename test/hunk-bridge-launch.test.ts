import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import type { ExtensionContext, HunkExtensionAPI } from "hunkdiff/extension";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVIEW_ENV } from "../src/contract.js";
import { readFeedback } from "../src/feedback.js";

afterEach(() => {
  delete process.env[REVIEW_ENV];
  vi.resetModules();
});

function createHunk() {
  const handlers = new Map<string, Array<(payload: unknown, context: ExtensionContext) => void>>();
  return {
    hunk: {
      apiVersion: 25,
      on(event: string, handler: (payload: unknown, context: ExtensionContext) => void) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerKeyboardMode() {},
      registerCommand() {},
    } as unknown as HunkExtensionAPI,
    emit(event: string, payload: unknown, context: ExtensionContext) {
      for (const handler of handlers.get(event) ?? []) handler(payload, context);
    },
  };
}

describe("review launch config boundary", () => {
  it("captures a saved note when the host omitted log from launch config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-hunk-bridge-launch-"));
    const journal = join(directory, "notes.jsonl");
    await writeFile(journal, "", { flag: "wx" });
    process.env[REVIEW_ENV] = JSON.stringify({
      cwd: directory,
      view: "diff",
      journal,
      config: {
        prefix: "ctrl+space",
        diff: "h",
        show: "s",
        delivery: "steer",
      },
    });
    try {
      // ownedReview is module state; resetModules requires a fresh factory load.
      const { default: hunkBridge } = await import("../src/hunk.js");
      const api = createHunk();
      hunkBridge(api.hunk);
      const context: ExtensionContext = { cwd: directory, notify() {} };
      api.emit("startup", { cwd: directory }, context);
      api.emit(
        "note_created",
        {
          note: {
            id: "note-1",
            fileId: "file-1",
            filePath: "working.ts",
            hunkIndex: 0,
            side: "new",
            line: 4,
            body: "Need a guard",
            draft: false,
          },
        },
        context,
      );
      api.emit(
        "note_changed",
        {
          kind: "created",
          note: {
            id: "note-1",
            source: "user",
            fileKey: "working.ts",
            anchor: { newRange: [4, 4] },
            summary: "Need a guard",
            editable: true,
            resolution: "active",
          },
        },
        context,
      );
      const notes = await Effect.runPromise(readFeedback(journal));
      expect(notes).toEqual([
        {
          id: "note-1",
          view: "diff",
          path: "working.ts",
          newRange: [4, 4],
          body: "Need a guard",
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
