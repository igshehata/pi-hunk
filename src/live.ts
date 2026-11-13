import { watch, type FSWatcher } from "node:fs";
import { open, mkdtemp, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, ReviewEvent, ReviewLaunch, ReviewNote, View } from "./contract.js";
import { deliver, type DeliveryTarget, type SendUserMessage } from "./deliver.js";
import { formatLiveChange } from "./feedback.js";
import type { HostContext } from "./host.js";
import {
  detectMultiplexer,
  resolveHunk,
  writeLauncher,
  type Multiplexer,
  type Pane,
} from "./multiplexer.js";
import { launchBase } from "./views.js";

/** What a live review needs from a session; `HostContext` satisfies it. */
type LiveContext = DeliveryTarget & { readonly cwd: string };

type LiveSession = { readonly ctx: HostContext; readonly config: Config };

export type LiveOpenResult = "opened" | "focused" | "unsupported" | "failed";

export interface LiveReview {
  /**
   * Opens the pane for `view`, or focuses the one already open. Resolves `unsupported` outside
   * Tern/Rex/Herdr, and `failed` once it has already reported why it could not open.
   */
  open(session: LiveSession, view: View): Promise<LiveOpenResult>;
  /** Closes the pane if one is open (session switch, reload, quit). Never throws. */
  close(): Promise<void>;
}

type LiveState = { readonly _tag: "Closed" } | { readonly _tag: "Opening" } | LiveOpen;

/**
 * One review living in a sibling pane. The journal is the only source of truth: Hunk appends a
 * record per saved change, and this state is what the agent has already been told about it.
 */
interface LiveOpen {
  readonly _tag: "Open";
  readonly pane: Pane;
  readonly multiplexer: Multiplexer;
  readonly journal: string;
  readonly directory: string;
  readonly ctx: LiveContext;
  readonly config: Config;
  /** Note id to the `#n` the agent has seen; a number is never reused within one review. */
  readonly numbers: Map<string, number>;
  /** The newest note per id, so an edit or a delete can be described. */
  readonly notes: Map<string, ReviewNote>;
  next: number;
  watcher: FSWatcher | undefined;
  /** Bytes of the journal already parsed. */
  offset: number;
  /** Bytes after the last newline: a torn append is not a record until its newline lands. */
  partial: Buffer;
  /** Aborts the deliveries still queued for a review that is going away. */
  readonly cancel: AbortController;
  /** Deliveries run on one chain, so the agent reads comments in the order they were saved. */
  sending: Promise<void>;
  /** An append the reader has not picked up yet. */
  dirty: boolean;
  /** True while one read pass owns `offset`. */
  reading: boolean;
  /** A `Failure` was reported: its journal holds the only copy of what went wrong. */
  failure: boolean;
  /** A malformed record is reported once per review, not once per read. */
  warned: boolean;
  /** An unreadable journal is reported once per review, not once per append. */
  warnRead: boolean;
  /** The first teardown wins; a second one would close a pane that is already gone. */
  closed: boolean;
}

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/** Everything a live message shows; a rewrite that changes none of it is not worth a turn. */
function sameNote(a: ReviewNote, b: ReviewNote): boolean {
  return (
    a.path === b.path &&
    a.previousPath === b.previousPath &&
    a.excerpt === b.excerpt &&
    a.body === b.body &&
    (a.stale === true) === (b.stale === true) &&
    sameRange(a.oldRange, b.oldRange) &&
    sameRange(a.newRange, b.newRange)
  );
}

function sameRange(
  a: readonly [number, number] | undefined,
  b: readonly [number, number] | undefined,
): boolean {
  return a === undefined || b === undefined ? a === b : a[0] === b[0] && a[1] === b[1];
}

export function createLiveReview(bindings: {
  readonly bridge: string;
  readonly sendUserMessage: SendUserMessage;
}): LiveReview {
  let state: LiveState = { _tag: "Closed" };
  /**
   * Open and close are serialized. A chord during a launch, or a quit during one, must not leave
   * a half-open review behind, and `queue` is what `close` waits on so a pane is never orphaned.
   */
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** The parent a reply points at, when the agent has already been told about it. */
  function parentOf(
    review: LiveOpen,
    id: string,
  ): { number: number; note: ReviewNote } | undefined {
    const number = review.numbers.get(id);
    const note = review.notes.get(id);
    return number === undefined || note === undefined ? undefined : { number, note };
  }

  /**
   * Sends one live message. Deliveries are chained: `interrupt` delivery can wait a long time for
   * the turn to stop, and a comment saved meanwhile must still arrive after the one before it.
   */
  function send(review: LiveOpen, message: string): Promise<void> {
    review.sending = review.sending
      .then(() =>
        deliver(
          review.ctx,
          bindings.sendUserMessage,
          review.config.delivery,
          message,
          review.cancel.signal,
          review.journal,
        ),
      )
      .catch((error: unknown) => {
        // A host that throws while accepting the message still leaves the journal on disk.
        if (!review.closed)
          review.ctx.ui.notify(`Hunk review failed: ${asError(error).message}`, "error");
      });
    return review.sending;
  }

  function upsert(review: LiveOpen, note: ReviewNote): void {
    const number = review.numbers.get(note.id);
    if (number === undefined) {
      const assigned = review.next++;
      review.numbers.set(note.id, assigned);
      const parent = note.parentId === undefined ? undefined : parentOf(review, note.parentId);
      review.notes.set(note.id, note);
      void send(
        review,
        formatLiveChange(
          parent === undefined
            ? { kind: "added", number: assigned, note }
            : { kind: "added", number: assigned, note, parent },
        ),
      );
      return;
    }
    const previous = review.notes.get(note.id);
    review.notes.set(note.id, note);
    if (previous !== undefined && sameNote(previous, note)) return;
    void send(review, formatLiveChange({ kind: "edited", number, note }));
  }

  function remove(review: LiveOpen, id: string): void {
    const number = review.numbers.get(id);
    // A note the agent never saw needs no retraction.
    if (number === undefined) return;
    review.numbers.delete(id);
    review.notes.delete(id);
    void send(review, formatLiveChange({ kind: "deleted", number }));
  }

  async function exited(review: LiveOpen, status: number): Promise<void> {
    if (status !== 0) {
      review.ctx.ui.notify(
        `Hunk exited with code ${status}. Comments sent so far were delivered. Journal: ${review.journal}`,
        "warning",
      );
      // Whatever is already chained was read from the journal before this record: deliver it,
      // then let the teardown abort the chain's signal for anything still to come. The pane is
      // left alone: Tern keeps a failed program's pane open so its error output stays readable.
      await review.sending;
      await tearDown(review, true, false);
      return;
    }
    // All comments were delivered as they were saved, so a clean exit has nothing left to hand
    // off; only the last chained deliveries still need to land before the review goes away.
    await review.sending;
    await tearDown(review, review.failure);
  }

  function apply(review: LiveOpen, line: string): void {
    let event: ReviewEvent;
    try {
      event = JSON.parse(line) as ReviewEvent;
    } catch {
      // A torn append costs that record only; the rest of the journal still reaches the agent.
      if (!review.warned) {
        review.warned = true;
        review.ctx.ui.notify(
          `Hunk journal ${review.journal} contains a record that could not be read; it was skipped.`,
          "warning",
        );
      }
      return;
    }
    switch (event._tag) {
      case "Ready":
        // The bridge announcing itself; no comment changed.
        return;
      case "Upsert":
        upsert(review, event.note);
        return;
      case "Remove":
        remove(review, event.id);
        return;
      case "Failure":
        review.failure = true;
        review.ctx.ui.notify(
          `Hunk reported a failure: ${event.message}\nJournal: ${review.journal}`,
          "error",
        );
        return;
      case "Exited":
        void exited(review, event.status);
        return;
    }
  }

  /** Reads everything appended since `offset`, parsing only records whose newline is written. */
  async function readOnce(review: LiveOpen): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await open(review.journal, "r");
    } catch (error) {
      if (!review.warnRead) {
        review.warnRead = true;
        review.ctx.ui.notify(
          `Hunk journal ${review.journal} could not be read: ${asError(error).message}`,
          "warning",
        );
      }
      return;
    }
    try {
      const { size } = await handle.stat();
      if (size <= review.offset) return;
      const chunk = Buffer.alloc(size - review.offset);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, review.offset);
      review.offset += bytesRead;
      // Bytes, not text: a multi-byte character split across two appends must survive the join.
      const text = Buffer.concat([review.partial, chunk.subarray(0, bytesRead)]);
      const end = text.lastIndexOf(0x0a);
      if (end === -1) {
        review.partial = text;
        return;
      }
      review.partial = Buffer.from(text.subarray(end + 1));
      for (const line of text.subarray(0, end).toString("utf8").split("\n")) {
        // An `Exited` record ends the review; the records after it are not comments.
        if (review.closed) return;
        if (line.length === 0) continue;
        apply(review, line);
      }
    } catch (error) {
      if (!review.warnRead) {
        review.warnRead = true;
        review.ctx.ui.notify(
          `Hunk journal ${review.journal} could not be read: ${asError(error).message}`,
          "warning",
        );
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * Marks the journal dirty and reads it. One pass at a time, and the pass re-checks `dirty`: an
   * append that lands while the reader is busy would otherwise be lost with the event that saw it.
   */
  function schedule(review: LiveOpen): void {
    review.dirty = true;
    if (review.reading || review.closed) return;
    review.reading = true;
    void (async () => {
      try {
        while (review.dirty && !review.closed) {
          review.dirty = false;
          await readOnce(review);
        }
      } finally {
        review.reading = false;
      }
    })();
  }

  /**
   * Releases one review. `keepDirectory` keeps the journal a notice named as the only copy of what
   * went wrong; otherwise nothing in it is worth keeping. `closePane` is false only after Hunk
   * failed, when its pane still shows why.
   */
  async function tearDown(
    review: LiveOpen,
    keepDirectory: boolean,
    closePane = true,
  ): Promise<void> {
    if (review.closed) return;
    review.closed = true;
    if (state === review) state = { _tag: "Closed" };
    review.watcher?.close();
    if (closePane) await review.multiplexer.close(review.pane).catch(() => undefined);
    review.cancel.abort();
    if (!keepDirectory)
      await rm(review.directory, { recursive: true, force: true }).catch(() => undefined);
  }

  async function openNow(session: LiveSession, view: View): Promise<LiveOpenResult> {
    const current = state;
    if (current._tag === "Open") {
      const alive = await current.multiplexer.alive(current.pane).catch(() => false);
      if (alive) {
        try {
          await current.multiplexer.focus(current.pane);
        } catch (error) {
          // The review is open; the host must not open a second one over a focus failure.
          current.ctx.ui.notify(
            `Hunk could not focus the pane: ${asError(error).message}`,
            "error",
          );
        }
        return "focused";
      }
      // The pane went away without its `Exited` record (killed, or crashed before the trap ran).
      await tearDown(current, current.failure);
    }
    const multiplexer = detectMultiplexer(process.env);
    if (multiplexer === undefined) return "unsupported";
    state = { _tag: "Opening" };
    let directory: string | undefined;
    let pane: Pane | undefined;
    try {
      const hunk = await resolveHunk(process.env);
      // Every launch carries the base when one exists: the bridge needs it to switch to the
      // branch view inside Hunk. Only that view refuses to open without one.
      const resolvedBase = await launchBase(session.ctx.cwd, session.config, view);
      if (resolvedBase._tag === "Refused") throw new Error(resolvedBase.message);
      directory = await mkdtemp(join(tmpdir(), "pi-hunk-"));
      const journal = join(directory, "notes.jsonl");
      // Created here, empty: the launcher only ever appends, and the reader starts at byte 0.
      await writeFile(journal, "", { mode: 0o600, flag: "wx" });
      const launcher = join(directory, "launch.sh");
      const launch: ReviewLaunch = {
        cwd: session.ctx.cwd,
        view,
        config: session.config,
        journal,
        ...(resolvedBase.base === undefined ? {} : { base: resolvedBase.base }),
      };
      await writeLauncher(launcher, {
        hunk,
        bridge: bindings.bridge,
        launch,
        env: process.env,
      });
      pane = await multiplexer.open(session.ctx.cwd, launcher);
      const review: LiveOpen = {
        _tag: "Open",
        pane,
        multiplexer,
        journal,
        directory,
        ctx: session.ctx,
        config: session.config,
        numbers: new Map(),
        notes: new Map(),
        next: 1,
        watcher: undefined,
        offset: 0,
        partial: Buffer.alloc(0),
        cancel: new AbortController(),
        sending: Promise.resolve(),
        dirty: false,
        reading: false,
        failure: false,
        warned: false,
        warnRead: false,
        closed: false,
      };
      review.watcher = watch(journal, () => schedule(review));
      state = review;
      // The bridge may have written its handshake before the watcher existed: read from byte 0.
      schedule(review);
      return "opened";
    } catch (error) {
      // A pane without a journal to read is useless: close it before saying what failed.
      if (pane !== undefined) await multiplexer.close(pane).catch(() => undefined);
      if (directory !== undefined)
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      state = { _tag: "Closed" };
      session.ctx.ui.notify(
        `Hunk could not open in ${multiplexer.name}: ${asError(error).message}`,
        "error",
      );
      return "failed";
    }
  }

  function closeNow(): Promise<void> {
    const current = state;
    // `Opening` cannot be observed here: the queue means a launch has finished before a close runs.
    if (current._tag !== "Open") return Promise.resolve();
    return tearDown(current, current.failure);
  }

  return {
    open: (session, view) => enqueue(() => openNow(session, view)),
    close: () => enqueue(closeNow),
  };
}
