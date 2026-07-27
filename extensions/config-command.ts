import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, parseKey, truncateToWidth, type KeyId } from "@earendil-works/pi-tui";
import {
  cloneConfig,
  isOverlayLayout,
  isPrefixBinding,
  isHotkeyBinding,
  type ConfigStore,
  type HunkConfig,
  type OverlayLayout,
} from "./config.ts";
import type { ReviewCoordinator } from "./coordinator.ts";

const LAYOUT_CHOICES: Array<{ value: OverlayLayout; label: string }> = [
  { value: "full", label: "Full — 100% terminal" },
  { value: "left", label: "Left — 50% split pane" },
  { value: "right", label: "Right — 50% split pane" },
  { value: "float", label: "Float — centered 75% pane" },
];

export interface ConfigCommandSelection {
  layout: OverlayLayout;
}

export function parseConfigCommand(input: string): ConfigCommandSelection | undefined {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length !== 1 || !isOverlayLayout(tokens[0])) return undefined;
  return { layout: tokens[0] };
}

function displayLayout(layout: OverlayLayout): string {
  return LAYOUT_CHOICES.find((choice) => choice.value === layout)?.label ?? layout;
}

/** Report the durable review value separately from higher-precedence runtime layers. */
export function reportPersistedReviewPolicy(
  ctx: ExtensionContext,
  store: ConfigStore,
  savedReview: HunkConfig["review"],
): void {
  const effective = store.get().review;
  if (effective !== savedReview) {
    ctx.ui.notify(
      `Hunk review=${savedReview} was saved to .pi/hunk.json, but PI_HUNK_REVIEW keeps review=${effective}.`,
      "warning",
    );
    return;
  }
  ctx.ui.notify(`Hunk review set to ${savedReview} in .pi/hunk.json.`, "info");
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
        if (binding && !unavailable.includes(binding)) {
          done(binding);
          return;
        }
        warning =
          binding && unavailable.includes(binding)
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

  const overlay: Record<string, unknown> = {};
  if (before.overlay.layout !== after.overlay.layout) {
    overlay.layout = after.overlay.layout;
  }
  if (Object.keys(overlay).length > 0) patch.overlay = overlay;

  const bindings: Record<string, unknown> = {};
  for (const action of ["prefix", "toggle", "show"] as const) {
    if (before.bindings[action] !== after.bindings[action]) {
      bindings[action] = after.bindings[action];
    }
  }
  if (Object.keys(bindings).length > 0) patch.bindings = bindings;
  return patch;
}

/** Persist one UI change immediately. Configuration UI is project-only for now. */
async function persistProjectChange(
  ctx: ExtensionCommandContext,
  store: ConfigStore,
  coordinator: ReviewCoordinator,
  before: HunkConfig,
  after: HunkConfig,
  runtimeBindings: HunkConfig["bindings"],
  notifySaved: boolean,
): Promise<HunkConfig | undefined> {
  const patch = buildPatch(before, after);
  if (Object.keys(patch).length === 0) return after;

  let saved: HunkConfig;
  try {
    await store.persist(ctx, "project", patch);
    saved = store.getLoaded();
  } catch (error) {
    ctx.ui.notify(
      `Could not update project Hunk config: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return undefined;
  }

  const changedBindings = (["prefix", "toggle", "show"] as const).filter(
    (binding) => before.bindings[binding] !== saved.bindings[binding],
  );
  // Pi cannot unregister the old prefix, and a focused overlay has already
  // captured its chord. Keep the whole runtime chord stable until /reload.
  const loadedBindings = store.get().bindings;
  if (
    (["prefix", "toggle", "show"] as const).some(
      (binding) => loadedBindings[binding] !== runtimeBindings[binding],
    )
  ) {
    store.patchSession({ bindings: runtimeBindings });
  }

  const overlayChanged = before.overlay.layout !== saved.overlay.layout;
  const messages: string[] = [];
  if (notifySaved) messages.push("Hunk configuration updated in .pi/hunk.json.");
  if (overlayChanged && coordinator.hasLiveSurface()) {
    messages.push("Close and reopen the current Hunk review to apply the new layout.");
  }
  if (changedBindings.length > 0) {
    const chord = `${saved.bindings.prefix} then ${saved.bindings.toggle}/${saved.bindings.show}`;
    messages.push(`Run /reload to activate the Pi-hunk chord ${chord}.`);
  }
  if (notifySaved && overlayChanged) {
    messages.push(`Layout: ${displayLayout(saved.overlay.layout)}.`);
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
  coordinator: ReviewCoordinator,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      "Interactive Hunk configuration requires TUI mode. Usage: /hunk config restore | full|left|right|float",
      "warning",
    );
    return;
  }

  let current = store.get();
  const runtimeBindings = { ...current.bindings };
  while (true) {
    const choice = await ctx.ui.select(
      "Pi-hunk configuration — changes auto-save to .pi/hunk.json",
      [
        `Review behavior: ${current.review}`,
        `Follow edits: ${current.followEdits ? "on" : "off"}`,
        `Overlay layout: ${current.overlay.layout}`,
        `Hunk prefix: ${current.bindings.prefix}`,
        `Toggle hotkey: ${current.bindings.toggle}`,
        `Show hotkey: ${current.bindings.show}`,
        "Restore defaults…",
        "Done",
      ],
    );
    if (!choice || choice === "Done") return;

    if (choice === "Restore defaults…") {
      const confirmed = await ctx.ui.select("Restore default Hunk configuration?", [
        "Restore — remove project overrides",
        "Cancel",
      ]);
      if (!confirmed?.startsWith("Restore")) continue;
      try {
        await store.resetProject(ctx);
        const restored = store.getLoaded();
        if (
          (["prefix", "toggle", "show"] as const).some(
            (binding) => restored.bindings[binding] !== runtimeBindings[binding],
          )
        ) {
          store.patchSession({ bindings: runtimeBindings });
        }
        const reloadMessage = (["prefix", "toggle", "show"] as const).some(
          (binding) => current.bindings[binding] !== restored.bindings[binding],
        )
          ? ` Run /reload to activate the restored Hunk chord; the current chord remains active until then.`
          : "";
        const overlayMessage =
          coordinator.hasLiveSurface() && current.overlay.layout !== restored.overlay.layout
            ? " Close and reopen the current Hunk review to apply the restored layout."
            : "";
        ctx.ui.notify(
          `Project Hunk configuration removed; inherited/default settings restored.${reloadMessage}${overlayMessage}`,
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
    } else if (choice.startsWith("Overlay layout:")) {
      const selectedLabel = await ctx.ui.select(
        "Hunk overlay layout",
        LAYOUT_CHOICES.map((item) => item.label),
      );
      const selected = LAYOUT_CHOICES.find((item) => item.label === selectedLabel);
      if (!selected) continue;
      next.overlay.layout = selected.value;
    } else if (choice.startsWith("Hunk prefix:")) {
      const binding = await captureBinding(ctx, "prefix", current.bindings.prefix, "prefix", [
        current.bindings.toggle,
        current.bindings.show,
      ]);
      if (!binding) continue;
      next.bindings.prefix = binding;
    } else if (choice.startsWith("Toggle hotkey:")) {
      const binding = await captureBinding(
        ctx,
        "toggle hotkey",
        current.bindings.toggle,
        "hotkey",
        [current.bindings.prefix, current.bindings.show],
      );
      if (!binding) continue;
      next.bindings.toggle = binding;
    } else if (choice.startsWith("Show hotkey:")) {
      const binding = await captureBinding(ctx, "show hotkey", current.bindings.show, "hotkey", [
        current.bindings.prefix,
        current.bindings.toggle,
      ]);
      if (!binding) continue;
      next.bindings.show = binding;
    } else {
      continue;
    }

    const saved = await persistProjectChange(
      ctx,
      store,
      coordinator,
      current,
      next,
      runtimeBindings,
      false,
    );
    if (saved) current = saved;
  }
}

export async function handleConfigCommand(
  input: string,
  ctx: ExtensionCommandContext,
  store: ConfigStore,
  coordinator: ReviewCoordinator,
): Promise<void> {
  if (!ctx.isProjectTrusted()) {
    ctx.ui.notify(
      "Hunk configuration requires a trusted project so it can update .pi/hunk.json.",
      "warning",
    );
    return;
  }

  if (!input.trim()) {
    await configureInteractively(ctx, store, coordinator);
    return;
  }

  const current = store.get();
  if (input.trim() === "restore") {
    try {
      await store.resetProject(ctx);
      const restored = store.getLoaded();
      const shortcutsChanged = (["prefix", "toggle", "show"] as const).some(
        (binding) => restored.bindings[binding] !== current.bindings[binding],
      );
      if (shortcutsChanged) store.patchSession({ bindings: current.bindings });
      const overlayChanged = current.overlay.layout !== restored.overlay.layout;
      ctx.ui.notify(
        `Project Hunk configuration removed; inherited/default settings restored.${shortcutsChanged ? " Run /reload to activate the restored Hunk chord; the current chord remains active until then." : ""}${overlayChanged && coordinator.hasLiveSurface() ? " Close and reopen the current Hunk review to apply the restored layout." : ""}`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(
        `Could not restore Hunk defaults: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
    return;
  }

  const direct = parseConfigCommand(input);
  if (!direct) {
    ctx.ui.notify("Usage: /hunk config restore | full|left|right|float", "warning");
    return;
  }

  const next = cloneConfig(current);
  next.overlay.layout = direct.layout;
  if (Object.keys(buildPatch(current, next)).length === 0) {
    ctx.ui.notify("Hunk configuration is unchanged.", "info");
    return;
  }
  await persistProjectChange(ctx, store, coordinator, current, next, current.bindings, true);
}
