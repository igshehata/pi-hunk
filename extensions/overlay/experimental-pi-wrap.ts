import type { TUI } from "@earendil-works/pi-tui";
import type { OverlayLayout } from "../config.ts";

/**
 * Experimental split companion for Pi 0.80.x.
 *
 * Pi renders its base component tree at the full terminal width and composites
 * overlays afterwards. There is currently no supported API for reserving
 * columns beside an overlay, so this opt-in shim narrows the root render width
 * while a left/right Hunk pane is visible. It deliberately lives behind
 * `overlay.experimentalPiWrap` because it replaces one public method on the TUI
 * instance. Reflow stays on Pi's differential renderer; forcing a full-screen
 * clear here causes visible flicker during rapid show/hide transitions.
 */
export interface ExperimentalPiWrapController {
  setVisible(visible: boolean): void;
  dispose(): void;
}

export function installExperimentalPiWrap(
  tui: TUI,
  layout: OverlayLayout,
  enabled: boolean,
): ExperimentalPiWrapController | undefined {
  if (!enabled || (layout !== "left" && layout !== "right")) return undefined;

  const originalRender = tui.render;
  let active = true;
  let disposed = false;

  const wrappedRender: TUI["render"] = function renderWithHunkSplit(width: number): string[] {
    if (!active || disposed) return originalRender.call(tui, width);

    // Pi resolves "50%" with Math.floor. Use the same reserved width so the
    // narrowed base and the Hunk overlay meet without overlap or a gap.
    const reservedWidth = Math.floor(width / 2);
    const piWidth = Math.max(1, width - reservedWidth);
    const lines = originalRender.call(tui, piWidth);
    if (layout === "right") return lines;

    const leftPadding = " ".repeat(reservedWidth);
    return lines.map((line) => `${leftPadding}${line}`);
  };

  tui.render = wrappedRender;

  const requestReflow = (): void => {
    // All visibility flags and overlay-handle changes happen synchronously before
    // Pi's scheduled render. A normal differential render therefore sees one
    // complete state transition and avoids the full-screen clear that caused
    // intermittent flicker.
    tui.invalidate();
    tui.requestRender();
  };

  try {
    requestReflow();
  } catch (error) {
    disposed = true;
    active = false;
    if (tui.render === wrappedRender) tui.render = originalRender;
    throw error;
  }

  return {
    setVisible(visible: boolean): void {
      if (disposed || active === visible) return;
      active = visible;
      requestReflow();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      active = false;
      // Do not overwrite a later extension's wrapper. If another wrapper chains
      // through ours, the disposed closure already delegates at full width.
      if (tui.render === wrappedRender) tui.render = originalRender;
      requestReflow();
    },
  };
}
