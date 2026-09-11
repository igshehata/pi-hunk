import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import * as Effect from "effect/Effect";
import type { ReviewEvent, ReviewNote } from "./contract.js";

type JournalState =
  | { readonly _tag: "AwaitingBridge" }
  | { readonly _tag: "Recording"; readonly notes: Map<string, ReviewNote> };

export function readFeedback(journal: string): Effect.Effect<readonly ReviewNote[], Error> {
  return Effect.tryPromise({
    try: async (signal) => {
      const stream = createReadStream(journal, { encoding: "utf8", signal });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let state: JournalState = { _tag: "AwaitingBridge" };
      try {
        for await (const line of lines) {
          if (line.length === 0) continue;
          const event = JSON.parse(line) as ReviewEvent;
          switch (event._tag) {
            case "Ready":
              if (state._tag === "AwaitingBridge") {
                state = { _tag: "Recording", notes: new Map() };
              }
              break;
            case "Upsert":
              if (state._tag !== "Recording")
                throw new Error("Comment arrived before bridge initialization");
              state.notes.set(event.note.id, event.note);
              break;
            case "Remove":
              if (state._tag !== "Recording")
                throw new Error("Comment removal arrived before bridge initialization");
              state.notes.delete(event.id);
              break;
            case "Failure":
              throw new Error(event.message);
            default:
              throw new Error("Unrecognized review journal entry");
          }
        }
        if (state._tag !== "Recording")
          throw new Error("The Hunk review bridge did not initialize");
        return [...state.notes.values()];
      } finally {
        lines.close();
        stream.destroy();
      }
    },
    catch: (error) =>
      new Error(
        `Cannot collect review feedback from ${journal}: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
}

export function formatFeedback(notes: readonly ReviewNote[]): string {
  return `Hunk review comments:\n\n${JSON.stringify(notes, null, 2)}\n\nAddress every comment. Use its view, file path, and line ranges to locate the reviewed code.`;
}
