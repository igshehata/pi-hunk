import { writeFileSync } from "node:fs";

const CAPTURE_PATH_ENV = "PI_HUNK_FEEDBACK_PATH";
const REQUIRED_API_VERSION = 2;

interface ExtensionReviewNote {
  id: string;
  filePath: string;
  side: "old" | "new";
  line: number;
  body: string;
  draft: boolean;
}

interface HunkExtensionApi {
  apiVersion: number;
  on(event: "note_created", handler: (payload: { note: ExtensionReviewNote }) => void): void;
  log(message: string): void;
}

interface CapturedReviewNote {
  noteId: string;
  file: string;
  oldLine: number | null;
  newLine: number | null;
  oldRange: [number, number] | null;
  newRange: [number, number] | null;
  summary: string;
  rationale: string;
}

/** Relay saved user notes out of Hunk before its session daemon unregisters the process. */
export default function captureHunkFeedback(hunk: HunkExtensionApi): void {
  const capturePath = process.env[CAPTURE_PATH_ENV];
  if (!capturePath) return;
  if (hunk.apiVersion < REQUIRED_API_VERSION) {
    hunk.log(`pi-hunk feedback requires Hunk extension API ${REQUIRED_API_VERSION} or newer.`);
    return;
  }

  const notes = new Map<string, CapturedReviewNote>();
  const flush = (): void => {
    try {
      writeFileSync(
        capturePath,
        JSON.stringify({ version: 1, ready: true, notes: [...notes.values()] }),
        { encoding: "utf8", mode: 0o600 },
      );
    } catch (error) {
      hunk.log(
        `pi-hunk could not capture review feedback: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  flush();
  hunk.on("note_created", ({ note }) => {
    if (note.draft) return;
    const [summary = "", ...detail] = note.body.trim().split(/\r?\n/);
    const lineRange: [number, number] = [note.line, note.line];
    notes.set(note.id, {
      noteId: note.id,
      file: note.filePath,
      oldLine: note.side === "old" ? note.line : null,
      newLine: note.side === "new" ? note.line : null,
      oldRange: note.side === "old" ? lineRange : null,
      newRange: note.side === "new" ? lineRange : null,
      summary,
      rationale: detail.join("\n").trim(),
    });
    flush();
  });
}
