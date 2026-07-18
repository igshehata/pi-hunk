export {
  PREFIX_KEY,
  TOGGLE_KEY,
  SHOW_KEY,
  DEFAULT_OVERLAY_CONFIG,
  DEFAULT_BINDINGS_CONFIG,
  DEFAULT_CONFIG,
  isReviewPolicy,
  isOverlayLayout,
  resolveOverlayLayout,
  isPrefixBinding,
  isHotkeyBinding,
  applyConfig,
  cloneConfig,
} from "./config-schema.ts";
export type {
  ReviewPolicy,
  HunkCommandConfig,
  OverlayLayout,
  OverlaySize,
  OverlayConfig,
  ResolvedOverlayLayout,
  BindingsConfig,
  HunkConfig,
} from "./config-schema.ts";

export { globalConfigPath, projectConfigPath, loadConfig, ConfigStore } from "./config-store.ts";
export type { ConfigWarning, ConfigScope } from "./config-store.ts";

export {
  shouldEarlyOpenOnMutation,
  settledAutoOpenAction,
  explainSettledDecision,
} from "./config-policy.ts";
export type {
  AutoOpenSuppressionReason,
  SettledDecision,
  SettledOpenReason,
  SettledSkipReason,
} from "./config-policy.ts";

export {
  splitArgs,
  HUNK_VERBS,
  RESERVED_SUBCOMMANDS,
  hunkArgumentCompletions,
  resolveHunkArgs,
} from "./config-completions.ts";
export type { HunkCompletion } from "./config-completions.ts";
