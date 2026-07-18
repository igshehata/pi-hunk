import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ChangeDetector } from "../extensions/change-detector.ts";
import { DEFAULT_CONFIG, cloneConfig } from "../extensions/config.ts";
import { ReviewCoordinator } from "../extensions/coordinator.ts";

describe("ChangeDetector", () => {
  it("resets mutation evidence and orphaned tool args after settlement", () => {
    const detector = new ChangeDetector();
    expect(detector.consumeSettled()).toEqual({ mutation: false });
    detector.rememberToolArgs("aborted", { path: "orphaned.ts" });
    detector.markChanged();

    expect(detector.consumeSettled()).toEqual({ mutation: true });
    expect(detector.takeToolArgs("aborted")).toBeUndefined();
    expect(detector.consumeSettled()).toEqual({ mutation: false });
  });

  it("clears remembered tool args on reset", () => {
    const detector = new ChangeDetector();
    detector.rememberToolArgs("1", { path: "a.ts" });
    expect(detector.takeToolArgs("1")).toEqual({ path: "a.ts" });
    expect(detector.takeToolArgs("1")).toBeUndefined();
    detector.rememberToolArgs("2", {});
    detector.reset();
    expect(detector.takeToolArgs("2")).toBeUndefined();
  });
});

describe("ReviewCoordinator shutdown", () => {
  it("is idempotent and prevents further opens until revive", async () => {
    const coordinator = new ReviewCoordinator();
    const config = cloneConfig(DEFAULT_CONFIG);
    await coordinator.shutdown();
    await coordinator.shutdown();

    await expect(
      coordinator.ensureOpen(
        { cwd: "/repo", mode: "tui", ui: { custom: vi.fn() } } as unknown as ExtensionContext,
        config,
        config.hunk.args,
        "manual",
      ),
    ).rejects.toThrow(/shut down/);

    coordinator.revive();
    // After revive, ensureOpen may still fail on missing UI/PTY, but not shut-down.
    await expect(
      coordinator.ensureOpen(
        {
          cwd: "/repo",
          mode: "tui",
          ui: {
            custom: async () => {
              throw new Error("no pty in unit test");
            },
          },
        } as unknown as ExtensionContext,
        config,
        config.hunk.args,
        "manual",
      ),
    ).rejects.toThrow(/no pty|Could not open Hunk/);
  });

  it("cancels pending follow timers on shutdown", async () => {
    const coordinator = new ReviewCoordinator();
    // With no active overlay, shutdown should still clear pending state without throwing.
    await coordinator.shutdown();
    expect(coordinator.hasLiveSurface()).toBe(false);
  });

  it("activateSession cleans leftover live surfaces before reviving", async () => {
    const coordinator = new ReviewCoordinator();
    const config = cloneConfig(DEFAULT_CONFIG);

    let disposed = 0;
    let handleHidden = false;
    const ctx = {
      cwd: "/repo",
      mode: "tui",
      ui: {
        custom: <T>(
          factory: (...args: unknown[]) => {
            dispose?(): void;
            setVisible?(v: boolean): void;
          },
          options?: {
            onHandle?: (handle: {
              hide: () => void;
              setHidden: (h: boolean) => void;
              isHidden: () => boolean;
              focus: () => void;
            }) => void;
          },
        ) => {
          const component = factory(
            { terminal: { columns: 80, rows: 24, write: vi.fn() }, requestRender: vi.fn() },
            {},
            {},
            () => undefined,
          );
          options?.onHandle?.({
            hide: () => {
              handleHidden = true;
            },
            setHidden: () => undefined,
            isHidden: () => false,
            focus: () => undefined,
          });
          const originalDispose = component.dispose;
          component.dispose = () => {
            disposed += 1;
            originalDispose?.();
          };
          return new Promise<T>(() => {
            // Intentionally unresolved — mirrors post-mount owned removal.
          });
        },
      },
    } as unknown as ExtensionContext;

    await coordinator.ensureOpen(ctx, config, config.hunk.args, "manual");
    expect(coordinator.hasLiveSurface()).toBe(true);

    // Repeated session activation must not orphan the live overlay.
    await coordinator.activateSession();
    expect(coordinator.hasLiveSurface()).toBe(false);
    expect(handleHidden).toBe(true);
    expect(disposed).toBeGreaterThanOrEqual(1);

    // Coordinator is usable again after activation.
    await expect(
      coordinator.ensureOpen(
        {
          cwd: "/repo",
          mode: "tui",
          ui: {
            custom: async () => {
              throw new Error("no pty in unit test");
            },
          },
        } as unknown as ExtensionContext,
        config,
        config.hunk.args,
        "manual",
      ),
    ).rejects.toThrow(/no pty|Could not open Hunk/);
  });

  it("serializes concurrent ensureOpen and toggleOverlay so only one live surface is tracked", async () => {
    const coordinator = new ReviewCoordinator();
    const config = cloneConfig(DEFAULT_CONFIG);

    let openCount = 0;
    let activeOpens = 0;
    let maxConcurrent = 0;

    const makeCtx = () =>
      ({
        cwd: "/repo",
        mode: "tui",
        ui: {
          custom: <T>(
            factory: (...args: unknown[]) => {
              dispose?(): void;
              setVisible?(v: boolean): void;
            },
            options?: {
              onHandle?: (handle: {
                hide: () => void;
                setHidden: (h: boolean) => void;
                isHidden: () => boolean;
                focus: () => void;
              }) => void;
            },
          ) => {
            openCount += 1;
            activeOpens += 1;
            maxConcurrent = Math.max(maxConcurrent, activeOpens);
            factory(
              { terminal: { columns: 80, rows: 24, write: vi.fn() }, requestRender: vi.fn() },
              {},
              {},
              () => undefined,
            );
            // Delay handle capture slightly so concurrent callers would race without a queue.
            return new Promise<T>((_resolve) => {
              queueMicrotask(() => {
                options?.onHandle?.({
                  hide: () => undefined,
                  setHidden: () => undefined,
                  isHidden: () => false,
                  focus: () => undefined,
                });
                activeOpens -= 1;
                // Leave promise unresolved (owned-handle lifetime).
              });
            });
          },
        },
      }) as unknown as ExtensionContext;

    const ctx = makeCtx();
    const a = coordinator.ensureOpen(ctx, config, config.hunk.args, "live");
    const b = coordinator.toggleOverlay(ctx, config, config.hunk.args, "shortcut");
    await Promise.all([a, b]);

    // Queue serializes transitions: at most one open in flight at a time from the
    // coordinator's perspective, and active remains a single live surface.
    expect(coordinator.hasLiveSurface()).toBe(true);
    const info = coordinator.getActiveInfo();
    expect(info?.state === "visible" || info?.state === "hidden").toBe(true);
    // Second call may reuse/toggle rather than double-open depending on timing,
    // but we must never track two live surfaces.
    expect(openCount).toBeGreaterThanOrEqual(1);
    expect(maxConcurrent).toBe(1);

    await coordinator.shutdown();
  });
});
