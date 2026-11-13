import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      apiVersion: 33,
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
        "changeset_loaded",
        {
          changeset: {
            id: "changeset-1",
            sourceLabel: directory,
            title: "working tree",
            files: [],
          },
        },
        context,
      );
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
      const { notes } = await readFeedback(journal);
      expect(notes).toEqual([
        {
          id: "note-1",
          view: "diff",
          revision: { kind: "working-tree" },
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

describe("changeset revision resolution", () => {
  // Guards the freeze: `changeset_loaded` is emitted from a layout effect, so a synchronous git
  // query blocked Hunk's whole render for every spawn (a slow repository stalled for seconds).
  it("does not block Hunk while git resolves the mounted changeset revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-hunk-async-revision-"));
    const journal = join(directory, "notes.jsonl");
    await writeFile(journal, "", { flag: "wx" });
    const shim = join(directory, "bin");
    await mkdir(shim);
    // One git query costs two seconds; the old synchronous path blocked for exactly that.
    await writeFile(join(shim, "git"), '#!/bin/sh\nsleep 2\nexec /usr/bin/git "$@"\n', {
      mode: 0o755,
    });
    const path = process.env.PATH;
    process.env.PATH = `${shim}:${path}`;
    process.env[REVIEW_ENV] = JSON.stringify({ cwd: directory, view: "show", journal, config: {} });
    try {
      const { default: hunkBridge } = await import("../src/hunk.js");
      const api = createHunk();
      hunkBridge(api.hunk);
      const context: ExtensionContext = { cwd: directory, notify() {} };
      api.emit("startup", { cwd: directory }, context);
      const started = Date.now();
      api.emit(
        "changeset_loaded",
        {
          changeset: {
            id: "changeset-1",
            sourceLabel: directory,
            title: `${directory} show deadbeef`,
            files: [],
          },
        },
        context,
      );
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      process.env.PATH = path;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records a note saved right after a switch against the newly mounted revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-hunk-pending-revision-"));
    const journal = join(directory, "notes.jsonl");
    await writeFile(journal, "", { flag: "wx" });
    const shim = join(directory, "bin");
    await mkdir(shim);
    await writeFile(join(shim, "git"), '#!/bin/sh\nsleep 1\nexec /usr/bin/git "$@"\n', {
      mode: 0o755,
    });
    const path = process.env.PATH;
    process.env[REVIEW_ENV] = JSON.stringify({ cwd: directory, view: "show", journal, config: {} });
    try {
      const { default: hunkBridge } = await import("../src/hunk.js");
      const api = createHunk();
      hunkBridge(api.hunk);
      const context: ExtensionContext = { cwd: directory, notify() {} };
      api.emit("startup", { cwd: directory }, context);
      api.emit(
        "changeset_loaded",
        {
          changeset: {
            id: "changeset-1",
            sourceLabel: directory,
            title: `${directory} show aaaa1111`,
            files: [],
          },
        },
        context,
      );
      // The second mount resolves behind a one-second git query: a note saved in that window
      // must wait for its revision instead of recording the previous changeset's.
      process.env.PATH = `${shim}:${path}`;
      api.emit(
        "changeset_loaded",
        {
          changeset: {
            id: "changeset-2",
            sourceLabel: directory,
            title: `${directory} show bbbb2222`,
            files: [],
          },
        },
        context,
      );
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
      await vi.waitFor(
        async () => {
          const { notes } = await readFeedback(journal);
          expect(notes).toHaveLength(1);
          expect(notes[0]!.revision).toEqual({
            kind: "unresolved",
            description: `${directory} show bbbb2222`,
          });
        },
        { timeout: 5_000 },
      );
    } finally {
      process.env.PATH = path;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("capture failure", () => {
  // Guards the note-save failure that used to end in process.exit: Hunk died mid-render with
  // the review, drafts included, and left the terminal in its alternate screen.
  it("keeps Hunk open and journals the cause when a saved note cannot be captured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-hunk-capture-failure-"));
    const journal = join(directory, "notes.jsonl");
    await writeFile(journal, "", { flag: "wx" });
    process.env[REVIEW_ENV] = JSON.stringify({ cwd: directory, view: "diff", journal, config: {} });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const notices: string[] = [];
    try {
      // The bridge keeps its review in module state; resetModules needs a fresh factory load.
      const { default: hunkBridge } = await import("../src/hunk.js");
      const api = createHunk();
      hunkBridge(api.hunk);
      const context: ExtensionContext = {
        cwd: directory,
        notify(message) {
          notices.push(message);
        },
      };
      api.emit("startup", { cwd: directory }, context);
      // Hunk committed a note it never announced through note_created, so its path is unknown
      // and the save cannot be journaled.
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
      // Saves run on the serialized journal queue, so the failure lands after the event returns.
      await vi.waitFor(() => expect(notices).toHaveLength(1));
      // The review stays on screen; the user closes it when they are done.
      expect(exit).not.toHaveBeenCalled();
      expect(notices[0]).toContain(
        "pi-hunk cannot capture review feedback: Hunk did not provide a public file path for saved note note-1",
      );
      // The recorded failure is what makes the host refuse to submit the journal.
      await expect(readFeedback(journal)).rejects.toThrow(
        "pi-hunk cannot capture review feedback: Hunk did not provide a public file path",
      );
    } finally {
      exit.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
