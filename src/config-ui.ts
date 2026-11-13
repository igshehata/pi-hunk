import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config.js";
import type { Config, Delivery, Mode } from "./contract.js";

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

type KeyField = "prefix" | "diff" | "show" | "log" | "branch" | "codebase";

// The unsaved draft travels inside the state: no second mutable "current config" lives beside it.
type EditorState =
  | { readonly _tag: "Menu"; readonly draft: Config }
  | { readonly _tag: "Key"; readonly draft: Config; readonly field: KeyField }
  | { readonly _tag: "Delivery"; readonly draft: Config }
  | { readonly _tag: "Mode"; readonly draft: Config }
  | { readonly _tag: "Save"; readonly draft: Config };

// Each menu row carries the transition it selects, so no index arithmetic or label matching decides it.
type MenuChoice =
  | { readonly _tag: "Key"; readonly field: KeyField; readonly label: string }
  | { readonly _tag: "Delivery"; readonly label: string }
  | { readonly _tag: "Mode"; readonly label: string }
  | { readonly _tag: "Save"; readonly label: string }
  | { readonly _tag: "Cancel"; readonly label: string };

type Answer<T> = { readonly _tag: "Answer"; readonly value: T } | { readonly _tag: "Aborted" };

const keyFields: readonly KeyField[] = ["prefix", "diff", "show", "log", "branch", "codebase"];
const deliveryChoices: readonly { value: Delivery; label: string }[] = [
  { value: "steer", label: "steer — deliver during the current response" },
  { value: "followUp", label: "followUp — wait until the current response finishes" },
  { value: "interrupt", label: "interrupt — stop the current response and deliver" },
];
const modeChoices: readonly { value: Mode; label: string }[] = [
  {
    value: "static",
    label: "static — full-screen Hunk; comments are sent when you close it",
  },
  {
    value: "multiplexer",
    label:
      "multiplexer — Hunk opens beside the agent in Tern, Rex, or Herdr; each comment is sent as you save it",
  },
];

// A dialog that settles because the caller cancelled is cancellation, not an answer, and the
// rejection it may raise on cancellation must not become a configuration failure.
async function answer<T>(signal: AbortSignal, dialog: () => Promise<T>): Promise<Answer<T>> {
  try {
    const value = await dialog();
    return signal.aborted ? { _tag: "Aborted" } : { _tag: "Answer", value };
  } catch (error) {
    if (signal.aborted) return { _tag: "Aborted" };
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function editConfig(
  path: string,
  ui: ConfigUI,
  signal: AbortSignal,
): Promise<Config | undefined> {
  const loaded = await loadConfig(path);
  const broken = loaded._tag === "Broken";
  // A broken file is never rewritten until Save: the menu starts from defaults and says so.
  if (loaded._tag === "Broken")
    ui.notify(
      `${loaded.message}\nHunk shortcuts are off until this is fixed. This menu starts from defaults; Save replaces the file, Cancel leaves it untouched.`,
      "warning",
    );
  else if (loaded.ignored.length > 0)
    ui.notify(
      `Hunk configuration at ${path} sets unknown field(s) ${loaded.ignored.join(", ")}. They are ignored, and Save writes the known settings only.`,
      "warning",
    );
  // The host draws a select title on one row and truncates it, so the state that the user must act
  // on comes before the path: a long path must never hide "unreadable; Save replaces it".
  const title = broken
    ? `Hunk configuration (unreadable; Save replaces it) — ${path}`
    : `Hunk configuration — ${path}`;
  let state: EditorState = {
    _tag: "Menu",
    draft: loaded._tag === "Loaded" ? loaded.config : DEFAULT_CONFIG,
  };
  while (true) {
    // Covers the save, the one await that has no follow-up check: an abort during it must not reopen
    // a menu the caller has already cancelled.
    if (signal.aborted) return undefined;
    switch (state._tag) {
      case "Menu": {
        const draft: Config = state.draft;
        const menu: readonly MenuChoice[] = [
          ...keyFields.map((field) => ({
            _tag: "Key" as const,
            field,
            label: `${field}: ${draft[field]}`,
          })),
          { _tag: "Delivery", label: `delivery: ${draft.delivery}` },
          { _tag: "Mode", label: `mode: ${draft.mode}` },
          { _tag: "Save", label: "Save" },
          { _tag: "Cancel", label: "Cancel" },
        ];
        const answered: Answer<string | undefined> = await answer(
          signal,
          (): Promise<string | undefined> =>
            ui.select(
              title,
              menu.map(({ label }) => label),
              { signal },
            ),
        );
        if (answered._tag === "Aborted" || answered.value === undefined) return undefined;
        const choice: MenuChoice | undefined = menu.find(({ label }) => label === answered.value);
        // An unknown row is not an answer: re-render the same menu.
        if (choice === undefined) break;
        switch (choice._tag) {
          case "Cancel":
            return undefined;
          case "Key":
            state = { _tag: "Key", draft, field: choice.field };
            break;
          case "Delivery":
            state = { _tag: "Delivery", draft };
            break;
          case "Mode":
            state = { _tag: "Mode", draft };
            break;
          case "Save":
            state = { _tag: "Save", draft };
            break;
        }
        break;
      }
      case "Key": {
        const field: KeyField = state.field;
        const current: Config = state.draft;
        const answered: Answer<string | undefined> = await answer(
          signal,
          (): Promise<string | undefined> =>
            ui.input(
              `${field} key binding (current: ${current[field]}; blank keeps it)`,
              "e.g. ctrl+space, h, shift+h",
              { signal },
            ),
        );
        if (answered._tag === "Aborted") return undefined;
        const value: string | undefined = answered.value;
        const draft: Config =
          value !== undefined && value.trim() !== ""
            ? { ...current, [field]: value.trim() }
            : current;
        state = { _tag: "Menu", draft };
        break;
      }
      case "Delivery": {
        const current: Config = state.draft;
        const answered: Answer<string | undefined> = await answer(
          signal,
          (): Promise<string | undefined> =>
            ui.select(
              `Comment delivery (current: ${current.delivery})`,
              deliveryChoices.map(({ label }) => label),
              { signal },
            ),
        );
        if (answered._tag === "Aborted") return undefined;
        const selected: { value: Delivery; label: string } | undefined = deliveryChoices.find(
          ({ label }) => label === answered.value,
        );
        state = {
          _tag: "Menu",
          draft: selected ? { ...current, delivery: selected.value } : current,
        };
        break;
      }
      case "Mode": {
        const current: Config = state.draft;
        const answered: Answer<string | undefined> = await answer(
          signal,
          (): Promise<string | undefined> =>
            ui.select(
              `Hunk mode (current: ${current.mode})`,
              modeChoices.map(({ label }) => label),
              { signal },
            ),
        );
        if (answered._tag === "Aborted") return undefined;
        const selected: { value: Mode; label: string } | undefined = modeChoices.find(
          ({ label }) => label === answered.value,
        );
        state = {
          _tag: "Menu",
          draft: selected ? { ...current, mode: selected.value } : current,
        };
        break;
      }
      case "Save": {
        // Validate the complete draft here, allowing intermediate trigger-key collisions.
        const draft: Config = state.draft;
        try {
          return await saveConfig(path, draft);
        } catch (error) {
          ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        state = { _tag: "Menu", draft };
        break;
      }
    }
  }
}
