import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
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
    case "Exited":
      // Written by the multiplexer launcher after Hunk exits; it records no comment.
      return state;
    default:
      throw new Error("Unrecognized review journal entry");
  }
}

/** A journal that never reached `Recording` is a failed capture, not an empty review. */
function recordedNotes(state: JournalState): readonly ReviewNote[] {
  if (state._tag !== "Recording") throw new Error("The Hunk review bridge did not initialize");
  return [...state.notes.values()];
}

/** A record whose append never finished: a kill or full disk, not repository garbage. */
export interface UncommittedRecord {
  /** 1-based line number in the journal. */
  readonly line: number;
  /** The partial text that could not be replayed. */
  readonly text: string;
}

/** The committed notes plus, at most, the one record an interrupted append left behind. */
export interface FeedbackRead {
  readonly notes: readonly ReviewNote[];
  readonly uncommitted?: UncommittedRecord;
}

/**
 * Readline hands back a final line whether or not it was terminated, and only the file itself
 * knows which: an unterminated last line is an append that never completed and was never a
 * record the bridge committed to.
 */
async function endsWithNewline(journal: string): Promise<boolean> {
  const handle = await open(journal, "r");
  try {
    const { size } = await handle.stat();
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    const { bytesRead } = await handle.read(last, 0, 1, size - 1);
    return bytesRead === 0 || last[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

function journalFailure(journal: string, error: unknown): Error {
  return new Error(
    `Cannot collect review feedback from ${journal}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

export async function readFeedback(journal: string, signal?: AbortSignal): Promise<FeedbackRead> {
  // Settled before the stream exists: a readline interface created ahead of an await can miss the
  // end of a short journal, and every answer below depends on whether the file ended with a newline.
  let terminated: boolean;
  try {
    terminated = await endsWithNewline(journal);
  } catch (error) {
    throw journalFailure(journal, error);
  }
  const stream = createReadStream(journal, { encoding: "utf8", signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let state: JournalState = { _tag: "AwaitingBridge" };
    let uncommitted: UncommittedRecord | undefined;
    // One record is held back so the last line of the file is known to be the last line.
    let held: { readonly line: number; readonly text: string } | undefined;
    let position = 0;
    const commit = (entry: { readonly line: number; readonly text: string }): void => {
      if (entry.text.length === 0) return;
      state = replay(state, JSON.parse(entry.text) as ReviewEvent);
    };
    for await (const text of lines) {
      position += 1;
      if (held !== undefined) commit(held);
      held = { line: position, text };
    }
    if (held !== undefined && held.text.length > 0) {
      if (terminated) commit(held);
      else {
        // Only an unparsable final record is tolerated. A parseable one still replays, so a
        // journaled Failure keeps rejecting the review, and mid-file garbage keeps failing.
        let event: ReviewEvent | undefined;
        try {
          event = JSON.parse(held.text) as ReviewEvent;
        } catch {
          event = undefined;
        }
        if (event === undefined) uncommitted = { line: held.line, text: held.text };
        else state = replay(state, event);
      }
    }
    const notes = recordedNotes(state);
    return uncommitted === undefined ? { notes } : { notes, uncommitted };
  } catch (error) {
    throw journalFailure(journal, error);
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
    case "branch":
      return `branch:${revision.base}`;
    case "codebase":
      return "codebase";
    case "unresolved":
      return `unresolved:${revision.description}`;
  }
}

/** SHAs are shown at git's own unique abbreviation; grouping still uses the full ids. */
function revisionHeading(revision: Revision): string {
  switch (revision.kind) {
    case "working-tree":
      return "## Working tree (old: index, new: working tree)";
    case "commit": {
      const commit = revision.commit.slice(0, revision.abbrev);
      return revision.parent === undefined
        ? `## Commit ${commit} (root commit; old side empty)`
        : `## Commit ${commit} (old: parent ${revision.parent.slice(0, revision.abbrev)}, new: ${commit})`;
    }
    case "range": {
      const to = revision.to.slice(0, revision.abbrev);
      if (revision.from === undefined)
        return `## Range from the empty tree to ${to} (includes the root commit)`;
      const from = revision.from.slice(0, revision.abbrev);
      return `## Range ${from}..${to} (old: ${from}, new: ${to})`;
    }
    case "branch": {
      const base = revision.base.slice(0, revision.abbrev);
      return `## Branch (old: merge-base ${base}, new: working tree)`;
    }
    case "codebase":
      return "## Whole codebase (new: working tree)";
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

/** The location heading, with the one qualifier its caller adds. */
function locationLine(note: ReviewNote, suffix = ""): string {
  const renamed = note.previousPath === undefined ? "" : ` (renamed from ${note.previousPath})`;
  return `### ${note.path}${renamed} · ${locationOf(note)}${suffix}`;
}

/** The reviewed diff lines, fenced past the longest backtick run so the diff cannot end it. */
function excerptBlock(excerpt: string): string {
  const longest = Math.max(0, ...Array.from(excerpt.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}diff\n${excerpt}\n${fence}`;
}

/** One top-level comment with its excerpt, body, and threaded replies. */
function commentBlocks(
  note: ReviewNote,
  replies: ReadonlyMap<string, ReviewNote[]>,
  orphan: boolean,
): string[] {
  const blocks = [locationLine(note, orphan ? " (reply to a deleted comment)" : "")];
  if (note.excerpt !== undefined) blocks.push(excerptBlock(note.excerpt));
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

/**
 * One change the live review (multiplexer mode) sends as it happens. The number is the review's
 * own `#n`, assigned when the change was first seen, so an edit or a delete can name what the
 * agent already read.
 */
export type LiveChange =
  | {
      readonly kind: "added";
      readonly number: number;
      readonly note: ReviewNote;
      /** The parent thread, when the agent has already been told about it. */
      readonly parent?: { readonly number: number; readonly note: ReviewNote };
    }
  | { readonly kind: "edited"; readonly number: number; readonly note: ReviewNote }
  | { readonly kind: "deleted"; readonly number: number };

/** What a comment saved against older disk content still refers to. */
const STALE_NOTE =
  "The file changed after this review loaded; line numbers refer to the reviewed version.";

/**
 * One comment saved, edited, or deleted, as the agent reads it live. Same facts as a review
 * handoff, one change at a time, and again no instructions: how to act on a review belongs to the
 * user's own agent configuration.
 */
export function formatLiveChange(change: LiveChange): string {
  switch (change.kind) {
    case "deleted":
      return `Hunk comment #${change.number} deleted.`;
    case "edited": {
      const { note } = change;
      const blocks = [`Hunk comment #${change.number} edited`, locationLine(note)];
      if (note.stale === true) blocks.push(STALE_NOTE);
      if (note.body.length > 0) blocks.push(note.body);
      return blocks.join("\n\n");
    }
    case "added": {
      const { note, parent } = change;
      const title =
        parent === undefined
          ? `Hunk comment #${change.number}`
          : `Hunk comment #${change.number} (reply to #${parent.number})`;
      // Only a new top-level comment needs its revision: a reply sits in the thread it answers,
      // and an edit is about a comment the agent already located.
      const blocks = [title];
      if (parent === undefined) blocks.push(revisionHeading(note.revision));
      blocks.push(locationLine(note));
      if (note.stale === true) blocks.push(STALE_NOTE);
      if (parent === undefined && note.excerpt !== undefined)
        blocks.push(excerptBlock(note.excerpt));
      if (parent !== undefined && parent.note.body.length > 0)
        blocks.push(`> ${parent.note.body.split("\n").join("\n> ")}`);
      if (note.body.length > 0) blocks.push(note.body);
      return blocks.join("\n\n");
    }
  }
}
