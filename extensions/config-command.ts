import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, parseKey, truncateToWidth, type KeyId } from "@earendil-works/pi-tui";
import {
  bindingIdentity,
  cloneConfig,
  globalConfigPath,
  isPrefixBinding,
  isHotkeyBinding,
  type ConfigStore,
  type HunkConfig,
} from "./config.ts";

/** Report the durable review value separately from higher-precedence runtime layers. */
export function reportPersistedReviewPolicy(
  ctx: ExtensionContext,
  store: ConfigStore,
  savedReview: HunkConfig["review"],
): void {
  const effective = store.get().review;
  const path = globalConfigPath();
  if (effective !== savedReview) {
    const source = process.env.PI_HUNK_REVIEW ? "PI_HUNK_REVIEW" : "a session override";
    ctx.ui.notify(
      `Hunk review=${savedReview} was saved to ${path}, but ${source} keeps review=${effective}.`,
      "warning",
    );
    return;
  }
  ctx.ui.notify(`Hunk review set to ${savedReview} in ${path}.`, "info");
}

/** Convert one raw terminal keypress into a safe Pi shortcut identifier. */
export function prefixBindingFromInput(data: string): KeyId | undefined {
  const binding = parseKey(data);
  return isPrefixBinding(binding) ? binding : undefined;
}

export function hotkeyBindingFromInput(data: string): KeyId | undefined {
  const binding = parseKey(data);
  return isHotkeyBinding(binding) ? binding : undefined;
}

async function captureBinding(
  ctx: ExtensionCommandContext,
  label: string,
  current: KeyId,
  kind: "prefix" | "hotkey",
  unavailable: readonly KeyId[] = [],
): Promise<KeyId | undefined> {
  return ctx.ui.custom<KeyId | undefined>((tui, theme, _keybindings, done) => {
    let warning: string | undefined;
    return {
      render(width: number): string[] {
        const lines = [
          theme.fg("accent", theme.bold(`Set Pi-hunk ${label}`)),
          `Current: ${current}`,
          `Press the ${label} you want to use.`,
          theme.fg(
            "dim",
            kind === "prefix"
              ? "Esc cancels. Plain typing and navigation keys are not allowed as prefixes."
              : "Esc cancels. The hotkey is combined with the Pi-hunk prefix.",
          ),
        ];
        if (warning) lines.push(theme.fg("warning", warning));
        return lines.map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string): void {
        if (matchesKey(data, "escape")) {
          done(undefined);
          return;
        }
        const binding =
          kind === "prefix" ? prefixBindingFromInput(data) : hotkeyBindingFromInput(data);
        const collides =
          binding !== undefined &&
          unavailable.some((candidate) => bindingIdentity(candidate) === bindingIdentity(binding));
        if (binding && !collides) {
          done(binding);
          return;
        }
        warning =
          binding && collides
            ? `That key is already assigned in the Hunk chord (${binding}).`
            : kind === "prefix"
              ? "That key would interfere with normal typing. Press a modified shortcut or a function key."
              : "That key cannot be used as a Hunk hotkey.";
        tui.requestRender();
      },
      invalidate(): void {
        warning = undefined;
      },
    };
  });
}

function buildPatch(before: HunkConfig, after: HunkConfig): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (before.review !== after.review) patch.review = after.review;
  if (before.followEdits !== after.followEdits) patch.followEdits = after.followEdits;

  const bindings: Record<string, unknown> = {};
  for (const action of ["prefix", "open", "show"] as const) {
    if (before.bindings[action] !== after.bindings[action]) {
      bindings[action] = after.bindings[action];
    }
  }
  if (Object.keys(bindings).length > 0) patch.bindings = bindings;
  return patch;
}

/** Persist one UI change immediately to the global Pi config directory. */
async function persistGlobalChange(
  ctx: ExtensionCommandContext,
  store: ConfigStore,
  before: HunkConfig,
  after: HunkConfig,
  runtimeBindings: HunkConfig["bindings"],
  notifySaved: boolean,
): Promise<HunkConfig | undefined> {
  const patch = buildPatch(before, after);
  if (Object.keys(patch).length === 0) return after;

  let saved: HunkConfig;
  try {
    await store.persist(ctx, "global", patch);
    saved = store.getLoaded();
  } catch (error) {
    ctx.ui.notify(
      `Could not update global Hunk config: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return undefined;
  }

  const changedBindings = (["prefix", "open", "show"] as const).filter(
    (binding) => before.bindings[binding] !== saved.bindings[binding],
  );
  // Pi cannot unregister a shortcut. Keep the runtime chord stable until /reload.
  const loadedBindings = store.get().bindings;
  if (
    (["prefix", "open", "show"] as const).some(
      (binding) => loadedBindings[binding] !== runtimeBindings[binding],
    )
  ) {
    store.patchSession({ bindings: runtimeBindings });
  }

  const messages: string[] = [];
  if (notifySaved) messages.push(`Hunk configuration updated in ${globalConfigPath()}.`);
  if (changedBindings.length > 0) {
    const chord = `${saved.bindings.prefix} then ${saved.bindings.open}/${saved.bindings.show}`;
    messages.push(`Run /reload to activate the Pi-hunk chord ${chord}.`);
  }
  if (before.review !== after.review) {
    reportPersistedReviewPolicy(ctx, store, after.review);
  }
  if (messages.length > 0) ctx.ui.notify(messages.join(" "), "info");
  return saved;
}

async function configureInteractively(
  ctx: ExtensionCommandContext,
  store: ConfigStore,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      "Interactive Hunk configuration requires TUI mode. Usage: /hunk config restore",
      "warning",
    );
    return;
  }

  let current = store.get();
  const runtimeBindings = { ...current.bindings };
  while (true) {
    const choice = await ctx.ui.select(
      `Pi-hunk configuration — changes auto-save to ${globalConfigPath()}`,
      [
        `Review behavior: ${current.review}`,
        `Follow edits: ${current.followEdits ? "on" : "off"}`,
        `Hunk prefix: ${current.bindings.prefix}`,
        `Open hotkey: ${current.bindings.open}`,
        `Show hotkey: ${current.bindings.show}`,
        "Restore defaults…",
        "Done",
      ],
    );
    if (!choice || choice === "Done") return;

    if (choice === "Restore defaults…") {
      const confirmed = await ctx.ui.select("Restore default Hunk configuration?", [
        "Restore — remove global overrides",
        "Cancel",
      ]);
      if (!confirmed?.startsWith("Restore")) continue;
      try {
        await store.resetGlobal(ctx);
        const restored = store.getLoaded();
        if (
          (["prefix", "open", "show"] as const).some(
            (binding) => restored.bindings[binding] !== runtimeBindings[binding],
          )
        ) {
          store.patchSession({ bindings: runtimeBindings });
        }
        const reloadMessage = (["prefix", "open", "show"] as const).some(
          (binding) => current.bindings[binding] !== restored.bindings[binding],
        )
          ? " Run /reload to activate the restored Hunk chord; the current chord remains active until then."
          : "";
        ctx.ui.notify(
          `Global Hunk overrides removed from ${globalConfigPath()}.${reloadMessage}`,
          "info",
        );
        current = restored;
      } catch (error) {
        ctx.ui.notify(
          `Could not restore Hunk defaults: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
      continue;
    }

    const next = cloneConfig(current);
    if (choice.startsWith("Review behavior:")) {
      const review = await ctx.ui.select("Automatic Hunk review", ["off", "after-run", "live"]);
      if (review !== "off" && review !== "after-run" && review !== "live") continue;
      next.review = review;
    } else if (choice.startsWith("Follow edits:")) {
      const follow = await ctx.ui.select("Follow successful edits in Hunk", ["on", "off"]);
      if (!follow) continue;
      next.followEdits = follow === "on";
    } else if (choice.startsWith("Hunk prefix:")) {
      const binding = await captureBinding(ctx, "prefix", current.bindings.prefix, "prefix", [
        current.bindings.open,
        current.bindings.show,
      ]);
      if (!binding) continue;
      next.bindings.prefix = binding;
    } else if (choice.startsWith("Open hotkey:")) {
      const binding = await captureBinding(ctx, "open hotkey", current.bindings.open, "hotkey", [
        current.bindings.prefix,
        current.bindings.show,
      ]);
      if (!binding) continue;
      next.bindings.open = binding;
    } else if (choice.startsWith("Show hotkey:")) {
      const binding = await captureBinding(ctx, "show hotkey", current.bindings.show, "hotkey", [
        current.bindings.prefix,
        current.bindings.open,
      ]);
      if (!binding) continue;
      next.bindings.show = binding;
    } else {
      continue;
    }

    const saved = await persistGlobalChange(ctx, store, current, next, runtimeBindings, false);
    if (saved) current = saved;
  }
}

export async function handleConfigCommand(
  input: string,
  ctx: ExtensionCommandContext,
  store: ConfigStore,
): Promise<void> {
  if (!input.trim()) {
    await configureInteractively(ctx, store);
    return;
  }

  if (input.trim() !== "restore") {
    ctx.ui.notify("Usage: /hunk config restore", "warning");
    return;
  }

  const current = store.get();
  try {
    await store.resetGlobal(ctx);
    const restored = store.getLoaded();
    const shortcutsChanged = (["prefix", "open", "show"] as const).some(
      (binding) => restored.bindings[binding] !== current.bindings[binding],
    );
    if (shortcutsChanged) store.patchSession({ bindings: current.bindings });
    ctx.ui.notify(
      `Global Hunk overrides removed from ${globalConfigPath()}.${shortcutsChanged ? " Run /reload to activate the restored Hunk chord; the current chord remains active until then." : ""}`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(
      `Could not restore Hunk defaults: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}
