import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { ReviewEvent, ReviewNote, Revision } from "./contract.js";

/**
 * Replay lifecycle of the journal: the bridge announces itself with `Ready`;
 * only then may notes be recorded. A `Ready` seen while already recording is a
 * restarted bridge and changes nothing, so retained notes stay authoritative.
 */
type JournalState =
  | { readonly _tag: "AwaitingBridge" }
  | { readonly _tag: "Recording"; readonly notes: Map<string, ReviewNote> };

/** The single place where a journal event advances the replay state. */
function replay(state: JournalState, event: ReviewEvent): JournalState {
  switch (event._tag) {
    case "Ready":
      return state._tag === "Recording" ? state : { _tag: "Recording", notes: new Map() };
    case "Upsert":
      if (state._tag !== "Recording")
        throw new Error("Comment arrived before bridge initialization");
      state.notes.set(event.note.id, event.note);
      return state;
    case "Remove":
      if (state._tag !== "Recording")
        throw new Error("Comment removal arrived before bridge initialization");
      state.notes.delete(event.id);
      return state;
    case "Failure":
      throw new Error(event.message);
    default:
      throw new Error("Unrecognized review journal entry");
  }
}

/** A journal that never reached `Recording` is a failed capture, not an empty review. */
function recordedNotes(state: JournalState): readonly ReviewNote[] {
  if (state._tag !== "Recording") throw new Error("The Hunk review bridge did not initialize");
  return [...state.notes.values()];
}

export async function readFeedback(
  journal: string,
  signal?: AbortSignal,
): Promise<readonly ReviewNote[]> {
  const stream = createReadStream(journal, { encoding: "utf8", signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let state: JournalState = { _tag: "AwaitingBridge" };
    for await (const line of lines) {
      if (line.length === 0) continue;
      const event = JSON.parse(line) as ReviewEvent;
      state = replay(state, event);
    }
    return recordedNotes(state);
  } catch (error) {
    throw new Error(
      `Cannot collect review feedback from ${journal}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Group notes by exact revision, not by equal-looking display text. */
function revisionKey(revision: Revision): string {
  switch (revision.kind) {
    case "working-tree":
      return "working-tree";
    case "commit":
      return `commit:${revision.commit}:${revision.parent ?? ""}`;
    case "range":
      return `range:${revision.from ?? ""}:${revision.to}`;
    case "unresolved":
      return `unresolved:${revision.description}`;
  }
}

function revisionHeading(revision: Revision): string {
  switch (revision.kind) {
    case "working-tree":
      return "## Working tree (old: index, new: working tree)";
    case "commit":
      return revision.parent === undefined
        ? `## Commit ${revision.commit} (root commit; old side empty)`
        : `## Commit ${revision.commit} (old: parent ${revision.parent}, new: ${revision.commit})`;
    case "range":
      return revision.from === undefined
        ? `## Range from the empty tree to ${revision.to} (includes the root commit)`
        : `## Range ${revision.from}..${revision.to} (old: ${revision.from}, new: ${revision.to})`;
    case "unresolved":
      return `## Unverified revision: Hunk reported "${revision.description}"`;
  }
}

function locationOf(note: ReviewNote): string {
  const sides: string[] = [];
  for (const [label, range] of [
    ["old", note.oldRange],
    ["new", note.newRange],
  ] as const) {
    if (range === undefined) continue;
    sides.push(
      range[0] === range[1]
        ? `${label} line ${range[0]}`
        : `${label} lines ${range[0]}–${range[1]}`,
    );
  }
  return sides.length === 0 ? "whole file" : sides.join(" → ");
}

/** One top-level comment with its excerpt, body, and threaded replies. */
function commentBlocks(
  note: ReviewNote,
  replies: ReadonlyMap<string, ReviewNote[]>,
  orphan: boolean,
): string[] {
  const renamed = note.previousPath === undefined ? "" : ` (renamed from ${note.previousPath})`;
  const suffix = orphan ? " (reply to a deleted comment)" : "";
  const blocks = [`### ${note.path}${renamed} · ${locationOf(note)}${suffix}`];
  if (note.excerpt !== undefined) {
    const longest = Math.max(
      0,
      ...Array.from(note.excerpt.matchAll(/`+/g), (match) => match[0].length),
    );
    const fence = "`".repeat(Math.max(3, longest + 1));
    blocks.push(`${fence}diff\n${note.excerpt}\n${fence}`);
  }
  if (note.body.length > 0) blocks.push(note.body);
  blocks.push(...replyBlocks(note, replies));
  return blocks;
}

/** Threaded replies render as blockquotes, depth-first in save order. */
function replyBlocks(note: ReviewNote, replies: ReadonlyMap<string, ReviewNote[]>): string[] {
  const blocks: string[] = [];
  for (const reply of replies.get(note.id) ?? []) {
    blocks.push(`> Reply: ${reply.body.split("\n").join("\n> ")}`);
    blocks.push(...replyBlocks(reply, replies));
  }
  return blocks;
}

/**
 * A self-describing review: comments grouped by the exact revision they refer
 * to, each with its file, old/new lines, reviewed diff lines, and replies.
 * Deliberately carries no instructions; how to act on a review belongs to the
 * user's own agent configuration.
 */
export function formatFeedback(notes: readonly ReviewNote[]): string {
  const saved = new Map(notes.map((note) => [note.id, note] as const));
  const replies = new Map<string, ReviewNote[]>();
  for (const note of notes) {
    const parent = note.parentId === undefined ? undefined : saved.get(note.parentId);
    if (parent === undefined) continue;
    const thread = replies.get(parent.id) ?? [];
    thread.push(note);
    replies.set(parent.id, thread);
  }

  const groups = new Map<string, { heading: string; notes: ReviewNote[] }>();
  for (const note of notes) {
    // A reply belongs to its parent's block; only top-level notes open a group.
    if (note.parentId !== undefined && saved.has(note.parentId)) continue;
    const key = revisionKey(note.revision);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { heading: revisionHeading(note.revision), notes: [note] });
    } else {
      group.notes.push(note);
    }
  }

  const sections = [`Hunk review: ${notes.length} comment${notes.length === 1 ? "" : "s"}`];
  for (const group of groups.values()) {
    sections.push(
      [
        group.heading,
        ...group.notes.map((note) =>
          commentBlocks(note, replies, note.parentId !== undefined).join("\n\n"),
        ),
      ].join("\n\n"),
    );
  }
  return sections.join("\n\n");
}
