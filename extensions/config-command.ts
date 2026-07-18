import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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
  experimentalPiWrap: boolean;
}

export function parseConfigCommand(
  input: string,
  currentExperimentalPiWrap: boolean,
): ConfigCommandSelection | undefined {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || !isOverlayLayout(tokens[0])) return undefined;

  let experimentalPiWrap = currentExperimentalPiWrap;
  let requestedExperimentalWrap = false;
  for (const token of tokens.slice(1)) {
    if (token === "experimental-wrap" || token === "wrap") {
      experimentalPiWrap = true;
      requestedExperimentalWrap = true;
    } else if (token === "no-experimental-wrap" || token === "no-wrap") experimentalPiWrap = false;
    else return undefined;
  }

  if (tokens[0] === "full" || tokens[0] === "float") {
    if (requestedExperimentalWrap) return undefined;
    experimentalPiWrap = false;
  }
  return { layout: tokens[0], experimentalPiWrap };
}

function displayLayout(layout: OverlayLayout): string {
  return LAYOUT_CHOICES.find((choice) => choice.value === layout)?.label ?? layout;
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
  if (before.overlay.layout !== after.overlay.layout) overlay.layout = after.overlay.layout;
  if (before.overlay.experimentalPiWrap !== after.overlay.experimentalPiWrap) {
    overlay.experimentalPiWrap = after.overlay.experimentalPiWrap;
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
): Promise<boolean> {
  const patch = buildPatch(before, after);
  if (Object.keys(patch).length === 0) return true;

  try {
    await store.persist(ctx, "project", patch);
  } catch (error) {
    ctx.ui.notify(
      `Could not update project Hunk config: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return false;
  }

  const changedBindings = (["prefix", "toggle", "show"] as const).filter(
    (binding) => before.bindings[binding] !== after.bindings[binding],
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

  const overlayChanged =
    before.overlay.layout !== after.overlay.layout ||
    before.overlay.experimentalPiWrap !== after.overlay.experimentalPiWrap;
  const messages: string[] = [];
  if (notifySaved) messages.push("Hunk configuration updated in .pi/hunk.json.");
  if (overlayChanged && coordinator.hasLiveSurface()) {
    messages.push("Close and reopen the current Hunk review to apply the new layout.");
  }
  if (changedBindings.length > 0) {
    const chord = `${after.bindings.prefix} then ${after.bindings.toggle}/${after.bindings.show}`;
    messages.push(`Run /reload to activate the Pi-hunk chord ${chord}.`);
  }
  if (notifySaved && overlayChanged) {
    messages.push(
      `Layout: ${displayLayout(after.overlay.layout)}${after.overlay.experimentalPiWrap ? ", Pi wrapping experimental" : ""}.`,
    );
  }
  if (messages.length > 0) ctx.ui.notify(messages.join(" "), "info");
  return true;
}

async function configureInteractively(
  ctx: ExtensionCommandContext,
  store: ConfigStore,
  coordinator: ReviewCoordinator,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      "Interactive Hunk configuration requires TUI mode. Usage: /hunk config restore | full|left|right|float [experimental-wrap|no-wrap]",
      "warning",
    );
    return;
  }

  let current = store.get();
  const runtimeBindings = { ...current.bindings };
  while (true) {
    const wrapState = current.overlay.experimentalPiWrap ? "on (experimental)" : "off";
    const choice = await ctx.ui.select(
      "Pi-hunk configuration — changes auto-save to .pi/hunk.json",
      [
        `Review behavior: ${current.review}`,
        `Follow edits: ${current.followEdits ? "on" : "off"}`,
        `Overlay layout: ${current.overlay.layout}`,
        `Pi word wrap: ${wrapState}`,
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
        const restored = await store.resetProject(ctx);
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
          coordinator.hasLiveSurface() &&
          (current.overlay.layout !== restored.overlay.layout ||
            current.overlay.experimentalPiWrap !== restored.overlay.experimentalPiWrap)
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
      if (selected.value === "full" || selected.value === "float") {
        next.overlay.experimentalPiWrap = false;
      }
    } else if (choice.startsWith("Pi word wrap:")) {
      if (current.overlay.layout !== "left" && current.overlay.layout !== "right") {
        ctx.ui.notify("Experimental Pi word wrap only applies to left and right layouts.", "info");
        continue;
      }
      const wrap = await ctx.ui.select("Pi word wrapping", [
        "Off — overlay only (stable)",
        "On — wrap Pi beside Hunk (experimental)",
      ]);
      if (!wrap) continue;
      next.overlay.experimentalPiWrap = wrap.startsWith("On");
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

    if (
      await persistProjectChange(ctx, store, coordinator, current, next, runtimeBindings, false)
    ) {
      current = next;
    }
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
      const restored = await store.resetProject(ctx);
      const shortcutsChanged = (["prefix", "toggle", "show"] as const).some(
        (binding) => restored.bindings[binding] !== current.bindings[binding],
      );
      if (shortcutsChanged) store.patchSession({ bindings: current.bindings });
      const overlayChanged =
        current.overlay.layout !== restored.overlay.layout ||
        current.overlay.experimentalPiWrap !== restored.overlay.experimentalPiWrap;
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

  const direct = parseConfigCommand(input, current.overlay.experimentalPiWrap);
  if (!direct) {
    const tokens = input.trim().split(/\s+/);
    const requestsWrap = tokens
      .slice(1)
      .some((token) => token === "experimental-wrap" || token === "wrap");
    const nonSplitLayout = tokens[0] === "full" || tokens[0] === "float";
    ctx.ui.notify(
      requestsWrap && nonSplitLayout
        ? "Experimental Pi word wrap only applies to left and right layouts."
        : "Usage: /hunk config restore | full|left|right|float [experimental-wrap|no-wrap]",
      "warning",
    );
    return;
  }

  const next = cloneConfig(current);
  next.overlay.layout = direct.layout;
  next.overlay.experimentalPiWrap = direct.experimentalPiWrap;
  if (Object.keys(buildPatch(current, next)).length === 0) {
    ctx.ui.notify("Hunk configuration is unchanged.", "info");
    return;
  }
  await persistProjectChange(ctx, store, coordinator, current, next, current.bindings, true);
}
