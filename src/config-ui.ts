import * as Effect from "effect/Effect";
import { loadConfig, saveConfig } from "./config.js";
import type { Config, Delivery } from "./contract.js";

export interface ConfigUI {
  select(
    title: string,
    options: string[],
    dialogOptions?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  input(
    title: string,
    placeholder?: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

type KeyField = "prefix" | "diff" | "show";
type EditorState =
  | { readonly _tag: "Menu" }
  | { readonly _tag: "Key"; readonly field: KeyField }
  | { readonly _tag: "Delivery" }
  | { readonly _tag: "Save" };

const keyFields: readonly KeyField[] = ["prefix", "diff", "show"];
const deliveryChoices: readonly { value: Delivery; label: string }[] = [
  { value: "steer", label: "steer — deliver during the current response" },
  { value: "followUp", label: "followUp — wait until the current response finishes" },
  { value: "interrupt", label: "interrupt — stop the current response and deliver" },
];

function dialogError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function editConfig(path: string, ui: ConfigUI): Effect.Effect<Config | undefined, Error> {
  return Effect.gen(function* () {
    let draft = yield* loadConfig(path);
    let state: EditorState = { _tag: "Menu" };
    while (true) {
      switch (state._tag) {
        case "Menu": {
          const options = [
            ...keyFields.map((field) => `${field}: ${draft[field]}`),
            `delivery: ${draft.delivery}`,
            "Save",
            "Cancel",
          ];
          const choice = yield* Effect.tryPromise({
            try: (signal) => ui.select(`Hunk configuration — ${path}`, options, { signal }),
            catch: dialogError,
          });
          if (choice === undefined || choice === "Cancel") return undefined;
          const index = options.indexOf(choice);
          if (index >= 0 && index < keyFields.length) {
            state = { _tag: "Key", field: keyFields[index]! };
          } else if (choice === options[3]) {
            state = { _tag: "Delivery" };
          } else if (choice === "Save") {
            state = { _tag: "Save" };
          }
          break;
        }
        case "Key": {
          const field = state.field;
          const value = yield* Effect.tryPromise({
            try: (signal) =>
              ui.input(
                `${field} key binding (current: ${draft[field]}; blank keeps it)`,
                "e.g. ctrl+space, h, shift+h",
                { signal },
              ),
            catch: dialogError,
          });
          if (value !== undefined && value.trim() !== "") {
            draft = { ...draft, [field]: value.trim() };
          }
          state = { _tag: "Menu" };
          break;
        }
        case "Delivery": {
          const choice = yield* Effect.tryPromise({
            try: (signal) =>
              ui.select(
                `Comment delivery (current: ${draft.delivery})`,
                deliveryChoices.map(({ label }) => label),
                { signal },
              ),
            catch: dialogError,
          });
          const selected = deliveryChoices.find(({ label }) => label === choice);
          if (selected) draft = { ...draft, delivery: selected.value };
          state = { _tag: "Menu" };
          break;
        }
        case "Save": {
          // Validate the complete draft here, allowing intermediate trigger-key collisions.
          const saved = yield* saveConfig(path, draft).pipe(
            Effect.catch((error) => Effect.sync(() => ui.notify(error.message, "error"))),
          );
          if (saved !== undefined) return saved;
          state = { _tag: "Menu" };
          break;
        }
      }
    }
  });
}
