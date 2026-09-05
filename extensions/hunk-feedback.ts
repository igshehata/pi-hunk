import { writeFileSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { bindingIdentity, toHunkChord, type HunkMode, type ReviewNote } from "./model.ts";

const CAPTURE_PATH_ENV = "PI_HUNK_FEEDBACK_PATH";
const PREFIX_KEY_ENV = "PI_HUNK_PREFIX_KEY";
const DIFF_KEY_ENV = "PI_HUNK_DIFF_KEY";
const SHOW_KEY_ENV = "PI_HUNK_SHOW_KEY";
const STASH_KEY_ENV = "PI_HUNK_STASH_KEY";
const REQUIRED_API_VERSION = 8;
const PREFIX_WAIT_MS = 800;
const BROKER_HOST_ENV = "HUNK_MCP_HOST";
const BROKER_PORT_ENV = "HUNK_MCP_PORT";
const DEFAULT_BROKER_HOST = "127.0.0.1";
const DEFAULT_BROKER_PORT = 47_657;
const BROKER_SNAPSHOT_TIMEOUT_MS = 500;
const BROKER_SNAPSHOT_ATTEMPTS = 3;
const BROKER_RETRY_DELAY_MS = 50;

interface BrokerNote {
  readonly noteId: string;
  readonly source: string;
  readonly filePath: string;
  readonly oldRange?: readonly [number, number];
  readonly newRange?: readonly [number, number];
  readonly body: string;
}

interface BrokerList {
  readonly sessions: readonly {
    readonly pid: number;
    readonly snapshot: {
      readonly state: {
        readonly reviewNotes: readonly BrokerNote[];
      };
    };
  }[];
}

interface ExtensionReviewNote {
  readonly id: string;
  readonly filePath: string;
  readonly side: "old" | "new";
  readonly line: number;
  readonly body: string;
  readonly draft: boolean;
}

interface ExtensionKeyEvent {
  readonly name?: string;
  readonly sequence?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly option?: boolean;
  readonly shift?: boolean;
}

interface ExtensionKeyboardModeControls {
  enterMode(id: string): boolean;
  exitMode(): boolean;
  isActive(id?: string): boolean;
}

interface ExtensionCommandControls {
  execute(commandId: string): boolean;
}

interface ExtensionReviewSnapshotFile {
  readonly fileKey: string;
  readonly path: string;
}

interface ExtensionReviewSnapshotNote {
  readonly id: string;
  readonly source: "ai" | "agent" | "user";
  readonly fileKey: string;
  readonly anchor: {
    readonly oldRange?: readonly [number, number];
    readonly newRange?: readonly [number, number];
    readonly preferred?: { readonly side: "old" | "new"; readonly line: number };
  };
  readonly summary: string;
  readonly rationale?: string;
}

interface ExtensionReviewSnapshot {
  readonly files: readonly ExtensionReviewSnapshotFile[];
  readonly notes: readonly ExtensionReviewSnapshotNote[];
}

interface ExtensionReviewControls {
  snapshot(): ExtensionReviewSnapshot | null;
}

interface ExtensionKeyboardModeContext {
  readonly commands: ExtensionCommandControls;
  readonly keyboardModes: ExtensionKeyboardModeControls;
}

interface ExtensionCommandContext extends ExtensionKeyboardModeContext {
  readonly review: ExtensionReviewControls;
}

interface HunkExtensionApi {
  readonly apiVersion: number;
  on(
    event: "note_created",
    handler: (payload: { readonly note: ExtensionReviewNote }) => void,
  ): void;
  on(event: "shutdown", handler: () => void): void;
  registerKeyboardMode(mode: {
    readonly id: string;
    readonly title: string;
    readonly onEnter?: (ctx: ExtensionKeyboardModeContext) => void;
    readonly onExit?: () => void;
    readonly onKey: (
      key: ExtensionKeyEvent,
      ctx: ExtensionKeyboardModeContext,
    ) => "handled" | "pass" | "exit";
  }): void;
  registerCommand(
    command: { readonly id: string; readonly title: string; readonly key: string },
    handler: (ctx: ExtensionCommandContext) => void,
  ): void;
  log(message: string): void;
}

function splitBinding(
  binding: string,
): { readonly base: string; readonly modifiers: Set<string> } | undefined {
  const identity = bindingIdentity(binding);
  if (!identity) return undefined;
  if (identity === "+") return { base: "+", modifiers: new Set() };
  if (identity.endsWith("++")) {
    return { base: "+", modifiers: new Set(identity.slice(0, -2).split("+")) };
  }
  const parts = identity.split("+");
  const base = parts.pop();
  return base ? { base, modifiers: new Set(parts) } : undefined;
}

function matchesBinding(key: ExtensionKeyEvent, binding: string): boolean {
  const parsed = splitBinding(binding);
  if (!parsed) return false;
  if (Boolean(key.ctrl) !== parsed.modifiers.has("ctrl")) return false;
  if (Boolean(key.shift) !== parsed.modifiers.has("shift")) return false;
  if (Boolean(key.option) !== parsed.modifiers.has("alt")) return false;
  if (Boolean(key.meta) !== parsed.modifiers.has("super")) return false;

  const base = parsed.base.toLowerCase();
  const name = key.name?.toLowerCase();
  if (base === "space") return name === "space" || key.sequence === " ";
  if (base === "enter") return name === "enter" || name === "return";
  if (base.length > 1) return name === base;
  return name === base || key.sequence?.toLowerCase() === base;
}

function noteFromEvent(note: ExtensionReviewNote): ReviewNote | undefined {
  if (note.draft || !Number.isInteger(note.line) || note.line <= 0) return undefined;
  const [summary = "", ...detail] = note.body.trim().split(/\r?\n/);
  const range: readonly [number, number] = [note.line, note.line];
  return {
    noteId: note.id,
    file: note.filePath,
    oldLine: note.side === "old" ? note.line : null,
    newLine: note.side === "new" ? note.line : null,
    oldRange: note.side === "old" ? range : null,
    newRange: note.side === "new" ? range : null,
    summary,
    rationale: detail.join("\n").trim(),
  };
}

function noteFromSnapshot(
  note: ExtensionReviewSnapshotNote,
  files: ReadonlyMap<string, string>,
): ReviewNote | undefined {
  if (note.source !== "user") return undefined;
  const file = files.get(note.fileKey);
  if (!file) return undefined;
  const oldRange = note.anchor.oldRange ? ([...note.anchor.oldRange] as [number, number]) : null;
  const newRange = note.anchor.newRange ? ([...note.anchor.newRange] as [number, number]) : null;
  const preferred = note.anchor.preferred;
  const oldLine = preferred?.side === "old" ? preferred.line : oldRange ? oldRange[0] : null;
  const newLine = preferred?.side === "new" ? preferred.line : newRange ? newRange[0] : null;
  if (oldLine === null && newLine === null) return undefined;
  return {
    noteId: note.id,
    file,
    oldLine,
    newLine,
    oldRange,
    newRange,
    summary: note.summary,
    rationale: note.rationale ?? "",
  };
}

function isBrokerRange(value: unknown): value is readonly [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isInteger(value[0]) &&
    value[0] > 0 &&
    Number.isInteger(value[1]) &&
    value[1] >= value[0]
  );
}

function noteFromBroker(note: BrokerNote): ReviewNote | undefined {
  const { noteId, source, filePath, oldRange: encodedOld, newRange: encodedNew, body } = note;
  if (
    source !== "user" ||
    (encodedOld !== undefined && !isBrokerRange(encodedOld)) ||
    (encodedNew !== undefined && !isBrokerRange(encodedNew)) ||
    (encodedOld === undefined && encodedNew === undefined)
  ) {
    return undefined;
  }
  const oldRange = encodedOld === undefined ? null : ([...encodedOld] as [number, number]);
  const newRange = encodedNew === undefined ? null : ([...encodedNew] as [number, number]);
  const [summary = "", ...detail] = body.trim().split(/\r?\n/);
  return {
    noteId,
    file: filePath,
    oldLine: oldRange?.[0] ?? null,
    newLine: newRange?.[0] ?? null,
    oldRange,
    newRange,
    summary,
    rationale: detail.join("\n").trim(),
  };
}

type AuthoritativeNotes =
  | { readonly _tag: "Captured"; readonly notes: readonly ReviewNote[] }
  | { readonly _tag: "Failed"; readonly detail: string };

async function readAuthoritativeNotes(): Promise<AuthoritativeNotes> {
  const host = process.env[BROKER_HOST_ENV] ?? DEFAULT_BROKER_HOST;
  const port = Number(process.env[BROKER_PORT_ENV] ?? DEFAULT_BROKER_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return { _tag: "Failed", detail: "Hunk feedback broker port is invalid." };
  }
  const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  let detail = "Hunk feedback broker did not return the current review session.";

  for (let attempt = 1; attempt <= BROKER_SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`http://${address}:${port}/session-api`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "list" }),
        signal: AbortSignal.timeout(BROKER_SNAPSHOT_TIMEOUT_MS),
      });
      if (!response.ok) {
        detail = `Hunk feedback broker returned HTTP ${response.status}.`;
      } else {
        const payload = (await response.json()) as BrokerList;
        const session = payload.sessions.find((candidate) => candidate.pid === process.pid);
        if (session) {
          return {
            _tag: "Captured",
            notes: session.snapshot.state.reviewNotes
              .map(noteFromBroker)
              .filter((note): note is ReviewNote => note !== undefined),
          };
        }
      }
    } catch (cause) {
      detail = `Hunk feedback broker failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    if (attempt < BROKER_SNAPSHOT_ATTEMPTS) await wait(BROKER_RETRY_DELAY_MS);
  }
  return { _tag: "Failed", detail };
}

/** Capture user comments and takeover prefix actions before Hunk releases the terminal. */
export default function captureHunkFeedback(hunk: HunkExtensionApi): void {
  const capturePath = process.env[CAPTURE_PATH_ENV];
  if (!capturePath) return;

  const notes = new Map<string, ReviewNote>();
  const knownNoteIds = new Set<string>();
  let prefixAction: HunkMode | undefined;
  let hasAuthoritativeSnapshot = false;
  const writeCapture = (
    state:
      | { readonly status: "pending" }
      | {
          readonly status: "ready";
          readonly notes: readonly ReviewNote[];
          readonly removedNoteIds: readonly string[];
        }
      | { readonly status: "failed"; readonly detail: string },
  ): void => {
    try {
      writeFileSync(
        capturePath,
        JSON.stringify({
          version: 1,
          ...state,
          ...(prefixAction ? { prefixAction } : {}),
        }),
        { encoding: "utf8", mode: 0o600 },
      );
    } catch (cause) {
      hunk.log(
        `pi-hunk could not capture review feedback: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };
  const writePending = (): void => writeCapture({ status: "pending" });
  const writeReady = (): void =>
    writeCapture({
      status: "ready",
      notes: [...notes.values()],
      removedNoteIds: [...knownNoteIds].filter((noteId) => !notes.has(noteId)),
    });

  if (hunk.apiVersion < REQUIRED_API_VERSION) {
    const detail = `Pi-hunk requires Hunk extension API ${REQUIRED_API_VERSION} or newer.`;
    writeCapture({ status: "failed", detail });
    hunk.log(detail);
    return;
  }

  const baseline = readAuthoritativeNotes();

  const captureEvent = ({ note }: { readonly note: ExtensionReviewNote }): void => {
    const captured = noteFromEvent(note);
    if (!captured) return;
    notes.set(captured.noteId, captured);
    knownNoteIds.add(captured.noteId);
    hasAuthoritativeSnapshot = false;
    writePending();
  };
  const captureSnapshot = (snapshot: ExtensionReviewSnapshot | null): void => {
    if (!snapshot) return;
    const files = new Map(snapshot.files.map((file) => [file.fileKey, file.path]));
    const authoritative = snapshot.notes
      .map((note) => noteFromSnapshot(note, files))
      .filter((note): note is ReviewNote => note !== undefined);
    notes.clear();
    for (const note of authoritative) {
      knownNoteIds.add(note.noteId);
      notes.set(note.noteId, note);
    }
    hasAuthoritativeSnapshot = true;
    writeReady();
  };

  writePending();
  hunk.on("note_created", captureEvent);
  hunk.on("shutdown", async () => {
    const initial = await baseline;
    if (initial._tag === "Captured") {
      for (const note of initial.notes) knownNoteIds.add(note.noteId);
    }
    const authoritative = await readAuthoritativeNotes();
    if (authoritative._tag === "Captured") {
      notes.clear();
      for (const note of authoritative.notes) {
        knownNoteIds.add(note.noteId);
        notes.set(note.noteId, note);
      }
      hasAuthoritativeSnapshot = true;
      writeReady();
      return;
    }
    if (hasAuthoritativeSnapshot) {
      writeReady();
      return;
    }
    writeCapture({ status: "failed", detail: authoritative.detail });
  });

  const prefix = process.env[PREFIX_KEY_ENV];
  const actions: ReadonlyArray<readonly [HunkMode, string | undefined]> = [
    ["diff", process.env[DIFF_KEY_ENV]],
    ["show", process.env[SHOW_KEY_ENV]],
    ["stash", process.env[STASH_KEY_ENV]],
  ];
  const hunkPrefix = prefix ? toHunkChord(prefix) : undefined;
  if (!prefix || !hunkPrefix || actions.some(([, binding]) => !binding)) {
    hunk.log("pi-hunk takeover chords were not registered because their bindings are invalid.");
    return;
  }

  let timer:
    | { readonly _tag: "Idle" }
    | { readonly _tag: "Armed"; readonly handle: ReturnType<typeof setTimeout> } = {
    _tag: "Idle",
  };
  const clearTimer = (): void => {
    if (timer._tag === "Armed") clearTimeout(timer.handle);
    timer = { _tag: "Idle" };
  };

  try {
    hunk.registerKeyboardMode({
      id: "prefix",
      title: "Pi-hunk prefix",
      onEnter(ctx) {
        clearTimer();
        const handle = setTimeout(() => {
          timer = { _tag: "Idle" };
          ctx.keyboardModes.exitMode();
        }, PREFIX_WAIT_MS);
        handle.unref();
        timer = { _tag: "Armed", handle };
      },
      onExit: clearTimer,
      onKey(key, ctx) {
        const action = actions.find(([, binding]) => binding && matchesBinding(key, binding))?.[0];
        clearTimer();
        if (!action) {
          ctx.keyboardModes.exitMode();
          return "pass";
        }
        prefixAction = action;
        if (hasAuthoritativeSnapshot) writeReady();
        else writePending();
        ctx.keyboardModes.exitMode();
        if (!ctx.commands.execute("hunk.app.quit")) process.kill(process.pid, "SIGTERM");
        return "handled";
      },
    });
    hunk.registerCommand({ id: "prefix", title: "Pi-hunk prefix", key: hunkPrefix }, (ctx) => {
      captureSnapshot(ctx.review.snapshot());
      ctx.keyboardModes.enterMode("prefix");
    });
  } catch (cause) {
    hunk.log(
      `pi-hunk could not register takeover chords: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
