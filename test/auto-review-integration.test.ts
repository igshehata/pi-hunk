import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { cloneConfig, ConfigStore, DEFAULT_CONFIG } from "../extensions/config.ts";
import type { ChangeDetector } from "../extensions/change-detector.ts";
import { ReviewCoordinator } from "../extensions/coordinator.ts";
import hunkExtension from "../extensions/index.ts";
import type { EmbeddedOptions } from "../extensions/overlay/embedded.ts";
import { OverlaySurface, type OverlayComponent } from "../extensions/overlay/surface.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.PI_HUNK_CONFIG;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

class LiveDetector {
  changed = false;
  private readonly toolArgs = new Map<string, unknown>();
  reset(): void {
    this.changed = false;
    this.toolArgs.clear();
  }
  markChanged(): void {
    this.changed = true;
  }
  rememberToolArgs(toolCallId: string, args: unknown): void {
    this.toolArgs.set(toolCallId, args);
  }
  takeToolArgs(toolCallId: string): unknown {
    const args = this.toolArgs.get(toolCallId);
    this.toolArgs.delete(toolCallId);
    return args;
  }
  consumeSettled() {
    const mutation = this.changed;
    this.changed = false;
    return { mutation };
  }
}

function harness(
  cwd: string,
  options: { failFirstMount?: boolean; mode?: "tui" | "rpc" | "print" } = {},
) {
  const events = new Map<string, (event: any, ctx: ExtensionCommandContext) => any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, (input: string, ctx: ExtensionCommandContext) => any>();
  const mounts: Array<{
    options: EmbeddedOptions;
    component: OverlayComponent & { visible: boolean };
  }> = [];
  let mountAttempts = 0;
  const overlay = new OverlaySurface((embeddedOptions) => {
    mountAttempts += 1;
    if (options.failFirstMount && mountAttempts === 1)
      throw new Error("simulated early mount failure");
    const component: OverlayComponent & { visible: boolean } = {
      visible: true,
      render: () => ["hunk"],
      invalidate: () => undefined,
      setVisible(visible: boolean) {
        this.visible = visible;
      },
      dispose: vi.fn(),
    };
    mounts.push({ options: embeddedOptions, component });
    return component;
  });
  const coordinator = new ReviewCoordinator({ overlay });
  const pi = {
    on: (
      name: string,
      handler: (event: any, ctx: ExtensionCommandContext) => Promise<void> | void,
    ) => {
      events.set(name, handler);
    },
    registerShortcut: vi.fn(),
    registerCommand: (name: string, spec: any) => commands.set(name, spec.handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
  } as unknown as ExtensionAPI;
  const tui = {
    terminal: { columns: 100, rows: 40, write: vi.fn() },
    render: vi.fn((width: number) => [`pi:${width}`]),
    invalidate: vi.fn(),
    requestRender: vi.fn(),
  } as unknown as TUI;
  const handle: OverlayHandle & { hidden: boolean } = {
    hidden: false,
    hide: vi.fn(),
    setHidden: vi.fn((hidden: boolean) => {
      handle.hidden = hidden;
    }),
    isHidden: vi.fn(() => handle.hidden),
    focus: vi.fn(),
    unfocus: vi.fn(),
    isFocused: vi.fn(() => !handle.hidden),
  };
  const ctx = {
    cwd,
    mode: options.mode ?? "tui",
    isProjectTrusted: () => false,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: { fg: (_color: string, text: string) => text },
      custom<T>(
        factory: (tui: TUI, theme: unknown, keys: unknown, done: (result: T) => void) => Component,
        options?: { onHandle?: (handle: OverlayHandle) => void },
      ): Promise<T> {
        factory(tui, {}, {}, () => undefined);
        options?.onHandle?.(handle);
        return new Promise<T>(() => undefined);
      },
    },
  } as unknown as ExtensionCommandContext;
  return { events, tools, commands, mounts, coordinator, pi, ctx, handle };
}

function emptyReviewRun(cwd: string) {
  return async (argv: string[]) => {
    const command = argv.slice(1).join(" ");
    if (command === "session list --json") {
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          sessions: [
            {
              sessionId: "s1",
              pid: 101,
              cwd,
              repoRoot: cwd,
              launchedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      };
    }
    if (command === "session comment list s1 --type user --json") {
      return { code: 0, stderr: "", stdout: JSON.stringify({ comments: [] }) };
    }
    return { code: 1, stderr: `unexpected argv: ${argv.join(" ")}`, stdout: "" };
  };
}

describe("automatic review policies in action", () => {
  const scopedMutationCases = [
    ["/tmp absolute path", "write", { path: "/tmp/pi-hunk-outside.ts" }, false],
    ["../ sibling path", "write", { path: "../sibling.ts" }, false],
    ["relative inside path", "write", { path: "src/inside.ts" }, true],
    [
      "mixed multi-edit",
      "multi_edit",
      { edits: [{ path: "/tmp/outside.ts" }, { path: "src/inside.ts" }] },
      true,
    ],
    ["pathless mutating bash", "bash", { command: "touch generated.ts" }, true],
  ] as const;

  it("opens one visible Hunk session on the first mutation and reuses it when the run settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-hunk-live-"));
    temporaryDirectories.push(root);
    process.env.PI_HUNK_CONFIG = join(root, "hunk.json");
    await writeFile(process.env.PI_HUNK_CONFIG, JSON.stringify({ review: "live" }));

    const runtime = harness(root);
    const detector = new LiveDetector();
    hunkExtension(runtime.pi, {
      store: new ConfigStore(),
      detector: detector as unknown as ChangeDetector,
      coordinator: runtime.coordinator,
      reviewRun: async () => ({ stdout: '{"sessions":[]}', stderr: "", code: 0 }),
    });

    await runtime.events.get("session_start")?.({ type: "session_start" }, runtime.ctx);
    const promptPatch = await runtime.events.get("before_agent_start")?.(
      {
        type: "before_agent_start",
        systemPrompt: "base prompt",
      },
      runtime.ctx,
    );
    expect(promptPatch?.systemPrompt).toContain("MUST call hunk_review");
    expect(promptPatch?.systemPrompt).toContain("Do not call hunk_review for conversation-only");
    await runtime.events.get("agent_start")?.({ type: "agent_start" }, runtime.ctx);

    const editInput = { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] };
    await runtime.events.get("tool_execution_start")?.(
      {
        type: "tool_execution_start",
        toolCallId: "edit-1",
        toolName: "edit",
        args: editInput,
      },
      runtime.ctx,
    );
    await runtime.events.get("tool_call")?.(
      {
        type: "tool_call",
        toolCallId: "edit-1",
        toolName: "edit",
        input: editInput,
      },
      runtime.ctx,
    );
    await vi.waitFor(() => expect(runtime.coordinator.getActiveInfo()?.state).toBe("visible"));
    expect(runtime.mounts).toHaveLength(1);
    expect(runtime.mounts[0]!.component.visible).toBe(true);

    // Further mutation attempts in the same run must reuse the early session.
    const writeInput = { path: "src/b.ts", content: "changed" };
    await runtime.events.get("tool_execution_start")?.(
      {
        type: "tool_execution_start",
        toolCallId: "write-2",
        toolName: "write",
        args: writeInput,
      },
      runtime.ctx,
    );
    await runtime.events.get("tool_call")?.(
      {
        type: "tool_call",
        toolCallId: "write-2",
        toolName: "write",
        input: writeInput,
      },
      runtime.ctx,
    );
    expect(runtime.mounts).toHaveLength(1);

    // A failed first attempt must not close the early surface if a later parallel
    // mutation succeeds before settle.
    await runtime.events.get("tool_execution_end")?.(
      {
        type: "tool_execution_end",
        toolCallId: "edit-1",
        toolName: "edit",
        result: { blocked: true },
        isError: true,
      },
      runtime.ctx,
    );
    await runtime.events.get("tool_execution_end")?.(
      {
        type: "tool_execution_end",
        toolCallId: "write-2",
        toolName: "write",
        result: {},
        isError: false,
      },
      runtime.ctx,
    );

    await runtime.events.get("agent_settled")?.({ type: "agent_settled" }, runtime.ctx);
    expect(runtime.coordinator.getActiveInfo()?.state).toBe("visible");
    expect(runtime.mounts).toHaveLength(1);
    expect(runtime.mounts[0]!.component.visible).toBe(true);
  });

  it("closes only a current-run early live surface when no mutation succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-hunk-live-failed-"));
    temporaryDirectories.push(root);
    process.env.PI_HUNK_CONFIG = join(root, "hunk.json");
    await writeFile(process.env.PI_HUNK_CONFIG, JSON.stringify({ review: "live" }));

    const runtime = harness(root);
    hunkExtension(runtime.pi, {
      store: new ConfigStore(),
      detector: new LiveDetector() as unknown as ChangeDetector,
      coordinator: runtime.coordinator,
      reviewRun: async () => ({ stdout: '{"sessions":[]}', stderr: "", code: 0 }),
    });
    await runtime.events.get("session_start")?.({ type: "session_start" }, runtime.ctx);
    await runtime.events.get("agent_start")?.({ type: "agent_start" }, runtime.ctx);

    const editInput = { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] };
    await runtime.events.get("tool_execution_start")?.(
      {
        type: "tool_execution_start",
        toolCallId: "edit-blocked",
        toolName: "edit",
        args: editInput,
      },
      runtime.ctx,
    );
    await vi.waitFor(() => expect(runtime.coordinator.getActiveInfo()?.state).toBe("visible"));
    await runtime.events.get("tool_execution_end")?.(
      {
        type: "tool_execution_end",
        toolCallId: "edit-blocked",
        toolName: "edit",
        result: { blocked: true, truncated: true },
        isError: true,
      },
      runtime.ctx,
    );

    await runtime.events.get("agent_settled")?.({ type: "agent_settled" }, runtime.ctx);
    expect(runtime.coordinator.getActiveInfo()).toBeNull();
    expect(runtime.mounts).toHaveLength(1);
    expect(runtime.mounts[0]!.component.dispose).toHaveBeenCalled();
  });

  it("preserves a pre-existing live surface with different args through failed and successful mutations", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-hunk-live-preexisting-"));
    temporaryDirectories.push(root);
    process.env.PI_HUNK_CONFIG = join(root, "hunk.json");
    await writeFile(process.env.PI_HUNK_CONFIG, JSON.stringify({ review: "live" }));

    const runtime = harness(root);
    hunkExtension(runtime.pi, {
      store: new ConfigStore(),
      detector: new LiveDetector() as unknown as ChangeDetector,
      coordinator: runtime.coordinator,
      reviewRun: async () => ({ stdout: '{"sessions":[]}', stderr: "", code: 0 }),
    });
    await runtime.events.get("session_start")?.({ type: "session_start" }, runtime.ctx);

    const config = cloneConfig(DEFAULT_CONFIG);
    config.review = "live";
    await runtime.coordinator.ensureOpen(runtime.ctx, config, ["show"], "manual");
    await runtime.coordinator.toggleOverlay(runtime.ctx, config, ["show"], "shortcut");
    expect(runtime.mounts).toHaveLength(1);
    const mount = runtime.mounts[0]!;
    const info = runtime.coordinator.getActiveInfo()!;
    expect(info.state).toBe("hidden");
    expect(info.argsKey).toContain("show");
    expect(mount.options.args).toEqual(["show"]);
    expect(mount.component.visible).toBe(false);
    vi.mocked(runtime.handle.setHidden).mockClear();
    vi.mocked(runtime.handle.focus).mockClear();

    const assertPreExistingUnchanged = () => {
      expect(runtime.mounts).toHaveLength(1);
      expect(runtime.mounts[0]).toBe(mount);
      expect(runtime.coordinator.getActiveInfo()).toMatchObject({
        state: "hidden",
        argsKey: info.argsKey,
      });
      expect(runtime.mounts[0]!.options.args).toEqual(["show"]);
      expect(runtime.mounts[0]!.component).toBe(mount.component);
      expect(runtime.mounts[0]!.component.visible).toBe(false);
      expect(runtime.mounts[0]!.component.dispose).not.toHaveBeenCalled();
      expect(runtime.handle.setHidden).not.toHaveBeenCalled();
      expect(runtime.handle.focus).not.toHaveBeenCalled();
    };

    const editInput = { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] };
    await runtime.events.get("agent_start")?.({ type: "agent_start" }, runtime.ctx);
    await runtime.events.get("tool_execution_start")?.(
      {
        type: "tool_execution_start",
        toolCallId: "edit-blocked",
        toolName: "edit",
        args: editInput,
      },
      runtime.ctx,
    );
    await runtime.events.get("tool_execution_end")?.(
      {
        type: "tool_execution_end",
        toolCallId: "edit-blocked",
        toolName: "edit",
        result: { blocked: true },
        isError: true,
      },
      runtime.ctx,
    );
    await runtime.events.get("agent_settled")?.({ type: "agent_settled" }, runtime.ctx);
    assertPreExistingUnchanged();

    await runtime.events.get("agent_start")?.({ type: "agent_start" }, runtime.ctx);
    await runtime.events.get("tool_execution_start")?.(
      {
        type: "tool_execution_start",
        toolCallId: "edit-ok",
        toolName: "edit",
        args: editInput,
      },
      runtime.ctx,
    );
    await runtime.events.get("tool_execution_end")?.(
      {
        type: "tool_execution_end",
        toolCallId: "edit-ok",
        toolName: "edit",
        result: {},
        isError: false,
      },
      runtime.ctx,
    );
    await runtime.events.get("agent_settled")?.({ type: "agent_settled" }, runtime.ctx);
    assertPreExistingUnchanged();

    await runtime.commands.get("hunk")?.("status", runtime.ctx);
    expect(runtime.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("last-auto-open=skipped(already-open)"),
      "info",
    );
  });

  it("does not open for conversation or read-only tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-hunk-live-chat-"));
    temporaryDirectories.push(root);
    process.env.PI_HUNK_CONFIG = join(root, "hunk.json");
    await writeFile(process.env.PI_HUNK_CONFIG, JSON.stringify({ review: "live" }));

    const runtime = harness(root);
    const detector = new LiveDetector();
    hunkExtension(runtime.pi, {
      store: new ConfigStore(),
      detector: detector as unknown as ChangeDetector,
      coordinator: runtime.coordinator,
      reviewRun: async () => ({ stdout: '{"sessions":[]}', stderr: "", code: 0 }),
    });
    await runtime.events.get("session_start")?.({ type: "session_start" }, runtime.ctx);

    // A pure conversation turn has no mutating tool boundary.
    await runtime.events.get("agent_start")?.({ type: "agent_start" }, runtime.ctx);
    await runtime.events.get("agent_settled")?.({ type: "agent_settled" }, runtime.ctx);
    expect(runtime.mounts).toHaveLength(0);

    await runtime.events.get("agent_start")?.({ type: "agent_start" }, runtime.ctx);
    const readInput = { path: "README.md" };
    await runtime.events.get("tool_execution_start")?.(
      {
        type: "tool_execution_start",
        toolCallId: "read-1",
        toolName: "read",
        args: readInput,
      },
      runtime.ctx,
    );
    await runtime.events.get("tool_call")?.(
      {
        type: "tool_call",
        toolCallId: "read-1",
        toolName: "read",
        input: readInput,
      },
      runtime.ctx,
    );
    await runtime.events.get("agent_settled")?.({ type: "agent_settled" }, runtime.ctx);
    expect(runtime.mounts).toHaveLength(0);
    expect(runtime.coordinator.getActiveInfo()).toBeNull();
  });

  it.each(scopedMutationCases)(
    "scopes live preflight mutation evidence for %s",
    async (_label, toolName, args, shouldOpen) => {
      const root = await mkdtemp(join(tmpdir(), "pi-hunk-live-scope-"));
      temporaryDirectories.push(root);
      process.env.PI_HUNK_CONFIG = join(root, "hunk.json");
      await writeFile(process.env.PI_HUNK_CONFIG, JSON.stringify({ review: "live" }));

      const runtime = harness(root);
      hunkExtension(runtime.pi, {
        store: new ConfigStore(),
        detector: new LiveDetector() as unknown as ChangeDetector,
        coordinator: runtime.coordinator,
        reviewRun: async () => ({ stdout: '{"sessions":[]}', stderr: "", code: 0 }),
      });
      await runtime.events.get("session_start")?.({ type: "session_start" }, runtime.ctx);
      await runtime.events.get("agent_start")?.({ type: "agent_start" }, runtime.ctx);
      await runtime.events.get("tool_execution_start")?.(
        { type: "tool_execution_start", toolCallId: "scoped", toolName, args },
        runtime.ctx,
      );
      await runtime.events.get("tool_execution_end")?.(
        { type: "tool_execution_end", toolCallId: "scoped", toolName, isError: false },
        runtime.ctx,
      );
      await runtime.events.get("agent_settled")?.({ type: "agent_settled" }, runtime.ctx);

      expect(runtime.mounts).toHaveLength(shouldOpen ? 1 : 0);
      if (shouldOpen) expect(runtime.coordinator.getActiveInfo()).toEqual(expect.any(Object));
      else expect(runtime.coordinator.getActiveInfo()).toBeNull();
    },
  );

  it.each(scopedMutationCases)(
    "scopes after-run settled mutation evidence for %s",
    async (_label, toolName, args, shouldOpen) => {
      const root = await mkdtemp(join(tmpdir(), "pi-hunk-after-run-scope-"));
      temporaryDirectories.push(root);
      process.env.PI_HUNK_CONFIG = join(root, "hunk.json");
      await writeFile(process.env.PI_HUNK_CONFIG, JSON.stringify({ review: "after-run" }));

      const runtime = harness(root);
      hunkExtension(runtime.pi, {
        store: new ConfigStore(),
        detector: new LiveDetector() as unknown as ChangeDetector,
        coordinator: runtime.coordinator,
        reviewRun: async () => ({ stdout: '{"sessions":[]}', stderr: "", code: 0 }),
      });
      await runtime.events.get("session_start")?.({ type: "session_start" }, runtime.ctx);
      await runtime.events.get("agent_start")?.({ type: "agent_start" }, runtime.ctx);
      await runtime.events.get("tool_execution_start")?.(
        { type: "tool_execution_start", toolCallId: "scoped", toolName, args },
        runtime.ctx,
      );
      expect(runtime.mounts).toHaveLength(0);
      await runtime.events.get("tool_execution_end")?.(
        { type: "tool_execution_end", toolCallId: "scoped", toolName, isError: false },
        runtime.ctx,
      );
      await runtime.events.get("agent_settled")?.({ type: "agent_settled" }, runtime.ctx);

      expect(runtime.mounts).toHaveLength(shouldOpen ? 1 : 0);
      if (shouldOpen) expect(runtime.coordinator.getActiveInfo()).toEqual(expect.any(Object));
      else expect(runtime.coordinator.getActiveInfo()).toBeNull();
    },
  );

  it("keeps after-run closed for chat/read turns and opens only after a successful coding mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-hunk-after-run-"));
    temporaryDirectories.push(root);
    process.env.PI_HUNK_CONFIG = join(root, "hunk.json");
    await writeFile(process.env.PI_HUNK_CONFIG, JSON.stringify({ review: "after-run" }));

    const runtime = harness(root);
    const detector = new LiveDetector();
    hunkExtension(runtime.pi, {
      store: new ConfigStore(),
      detector: detector as unknown as ChangeDetector,
      coordinator: runtime.coordinator,
      reviewRun: async () => ({ stdout: '{"sessions":[]}', stderr: "", code: 0 }),
    });
    await runtime.events.get("session_start")?.({ type: "session_start" }, runtime.ctx);

    // Conversation-only run.
    await runtime.events.get("agent_start")?.({ type: "agent_start" }, runtime.ctx);
    await runtime.events.get("agent_settled")?.({ type: "agent_settled" }, runtime.ctx);
    expect(runtime.mounts).toHaveLength(0);

    // A read-only tool still must not open after-run.
    await runtime.events.get("agent_start")?.({ type: "agent_start" }, runtime.ctx);
    await runtime.events.get("tool_execution_start")?.(
      {
        type: "tool_execution_start",
        toolCallId: "read-1",
        toolName: "read",
        args: { path: "README.md" },
      },
      runtime.ctx,
    );
    await runtime.events.get("tool_execution_end")?.(
      {
        type: "tool_execution_end",
        toolCallId: "read-1",
        toolName: "read",
        isError: false,
      },
      runtime.ctx,
    );
    await runtime.events.get("agent_settled")?.({ type: "agent_settled" }, runtime.ctx);
    expect(runtime.mounts).toHaveLength(0);

    // A failed coding mutation must not trigger after-run.
    await runtime.events.get("agent_start")?.({ type: "agent_start" }, runtime.ctx);
    const editInput = { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] };
    await runtime.events.get("tool_execution_start")?.(
      {
        type: "tool_execution_start",
        toolCallId: "edit-failed",
        toolName: "edit",
        args: editInput,
      },
      runtime.ctx,
    );
    await runtime.events.get("tool_execution_end")?.(
      {
        type: "tool_execution_end",
        toolCallId: "edit-failed",
        toolName: "edit",
        isError: true,
      },
      runtime.ctx,
    );
    await runtime.events.get("agent_settled")?.({ type: "agent_settled" }, runtime.ctx);
    expect(runtime.mounts).toHaveLength(0);

    // A successful coding mutation stays closed during execution and opens only at settle.
    await runtime.events.get("agent_start")?.({ type: "agent_start" }, runtime.ctx);
    await runtime.events.get("tool_execution_start")?.(
      {
        type: "tool_execution_start",
        toolCallId: "edit-1",
        toolName: "edit",
        args: editInput,
      },
      runtime.ctx,
    );
    expect(runtime.mounts).toHaveLength(0);
    await runtime.events.get("tool_execution_end")?.(
      {
        type: "tool_execution_end",
        toolCallId: "edit-1",
        toolName: "edit",
        isError: false,
      },
      runtime.ctx,
    );
    expect(runtime.mounts).toHaveLength(0);
    await runtime.events.get("agent_settled")?.({ type: "agent_settled" }, runtime.ctx);
    expect(runtime.coordinator.getActiveInfo()?.state).toBe("visible");
    expect(runtime.mounts).toHaveLength(1);
  });

  it.each(["rpc", "print"] as const)(
    "does not patch prompts or open hunk_review outside TUI (%s)",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), `pi-hunk-non-tui-${mode}-`));
      temporaryDirectories.push(root);
      process.env.PI_HUNK_CONFIG = join(root, "hunk.json");
      await writeFile(process.env.PI_HUNK_CONFIG, JSON.stringify({ review: "live" }));

      const runtime = harness(root, { mode });
      hunkExtension(runtime.pi, {
        store: new ConfigStore(),
        detector: new LiveDetector() as unknown as ChangeDetector,
        coordinator: runtime.coordinator,
        reviewRun: async () => ({ stdout: '{"sessions":[]}', stderr: "", code: 0 }),
      });
      await runtime.events.get("session_start")?.({ type: "session_start" }, runtime.ctx);

      expect(
        await runtime.events.get("before_agent_start")?.(
          {
            type: "before_agent_start",
            systemPrompt: "base prompt",
          },
          runtime.ctx,
        ),
      ).toBeUndefined();

      await runtime.events.get("agent_start")?.({ type: "agent_start" }, runtime.ctx);
      const editInput = { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] };
      await runtime.events.get("tool_execution_start")?.(
        {
          type: "tool_execution_start",
          toolCallId: "edit-1",
          toolName: "edit",
          args: editInput,
        },
        runtime.ctx,
      );
      await runtime.events.get("tool_execution_end")?.(
        {
          type: "tool_execution_end",
          toolCallId: "edit-1",
          toolName: "edit",
          result: {},
          isError: false,
        },
        runtime.ctx,
      );
      await runtime.events.get("agent_settled")?.({ type: "agent_settled" }, runtime.ctx);
      expect(runtime.mounts).toHaveLength(0);
      expect(runtime.coordinator.getActiveInfo()).toBeNull();

      await expect(
        runtime.tools.get("hunk_review")?.execute("call", {}, undefined, undefined, runtime.ctx),
      ).resolves.toMatchObject({ details: { status: "unavailable", reason: "not-tui" } });
      expect(runtime.mounts).toHaveLength(0);
    },
  );

  it("does not inject the blocking review instruction when automatic review is off", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-hunk-review-off-"));
    temporaryDirectories.push(root);
    process.env.PI_HUNK_CONFIG = join(root, "hunk.json");
    await writeFile(process.env.PI_HUNK_CONFIG, JSON.stringify({ review: "off" }));

    const runtime = harness(root);
    hunkExtension(runtime.pi, {
      store: new ConfigStore(),
      detector: new LiveDetector() as unknown as ChangeDetector,
      coordinator: runtime.coordinator,
      reviewRun: async () => ({ stdout: '{"sessions":[]}', stderr: "", code: 0 }),
    });
    await runtime.events.get("session_start")?.({ type: "session_start" }, runtime.ctx);
    expect(
      await runtime.events.get("before_agent_start")?.(
        {
          type: "before_agent_start",
          systemPrompt: "base prompt",
        },
        runtime.ctx,
      ),
    ).toBeUndefined();
  });

  it("does not reopen after hunk_review returns approved from a hide", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-hunk-approved-"));
    temporaryDirectories.push(root);
    process.env.PI_HUNK_CONFIG = join(root, "hunk.json");
    await writeFile(process.env.PI_HUNK_CONFIG, JSON.stringify({ review: "after-run" }));

    const runtime = harness(root);
    hunkExtension(runtime.pi, {
      store: new ConfigStore(),
      detector: new LiveDetector() as unknown as ChangeDetector,
      coordinator: runtime.coordinator,
      reviewRun: emptyReviewRun(root),
    });
    await runtime.events.get("session_start")?.({ type: "session_start" }, runtime.ctx);
    await runtime.events.get("agent_start")?.({ type: "agent_start" }, runtime.ctx);

    const editInput = { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] };
    await runtime.events.get("tool_execution_start")?.(
      {
        type: "tool_execution_start",
        toolCallId: "edit-1",
        toolName: "edit",
        args: editInput,
      },
      runtime.ctx,
    );
    await runtime.events.get("tool_execution_end")?.(
      {
        type: "tool_execution_end",
        toolCallId: "edit-1",
        toolName: "edit",
        result: {},
        isError: false,
      },
      runtime.ctx,
    );

    const review = runtime.tools
      .get("hunk_review")
      ?.execute("call", {}, undefined, undefined, runtime.ctx);
    await vi.waitFor(() => expect(runtime.coordinator.getActiveInfo()?.state).toBe("visible"));
    runtime.mounts[0]!.options.onToggleRequest?.();
    await vi.waitFor(() => expect(runtime.coordinator.getActiveInfo()?.state).toBe("hidden"));
    await expect(review).resolves.toMatchObject({ details: { status: "approved" } });

    await runtime.events.get("agent_settled")?.({ type: "agent_settled" }, runtime.ctx);
    expect(runtime.coordinator.getActiveInfo()?.state).toBe("hidden");
    expect(runtime.mounts).toHaveLength(1);
    expect(runtime.mounts[0]!.component.visible).toBe(false);
  });

  it("does not reopen after explicit close and resets suppression on the next run", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-hunk-close-suppress-"));
    temporaryDirectories.push(root);
    process.env.PI_HUNK_CONFIG = join(root, "hunk.json");
    await writeFile(process.env.PI_HUNK_CONFIG, JSON.stringify({ review: "live" }));

    const runtime = harness(root);
    hunkExtension(runtime.pi, {
      store: new ConfigStore(),
      detector: new LiveDetector() as unknown as ChangeDetector,
      coordinator: runtime.coordinator,
      reviewRun: async () => ({ stdout: '{"sessions":[]}', stderr: "", code: 0 }),
    });
    await runtime.events.get("session_start")?.({ type: "session_start" }, runtime.ctx);
    await runtime.events.get("agent_start")?.({ type: "agent_start" }, runtime.ctx);

    const editInput = { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] };
    await runtime.events.get("tool_execution_start")?.(
      {
        type: "tool_execution_start",
        toolCallId: "edit-1",
        toolName: "edit",
        args: editInput,
      },
      runtime.ctx,
    );
    await vi.waitFor(() => expect(runtime.coordinator.getActiveInfo()?.state).toBe("visible"));
    await runtime.events.get("tool_execution_end")?.(
      {
        type: "tool_execution_end",
        toolCallId: "edit-1",
        toolName: "edit",
        result: {},
        isError: false,
      },
      runtime.ctx,
    );
    await runtime.coordinator.closeActive();

    await runtime.events.get("agent_settled")?.({ type: "agent_settled" }, runtime.ctx);
    expect(runtime.coordinator.getActiveInfo()).toBeNull();
    expect(runtime.mounts).toHaveLength(1);

    await runtime.events.get("agent_start")?.({ type: "agent_start" }, runtime.ctx);
    await runtime.events.get("tool_execution_start")?.(
      {
        type: "tool_execution_start",
        toolCallId: "edit-2",
        toolName: "edit",
        args: editInput,
      },
      runtime.ctx,
    );
    await vi.waitFor(() => expect(runtime.coordinator.getActiveInfo()?.state).toBe("visible"));
    await runtime.events.get("tool_execution_end")?.(
      {
        type: "tool_execution_end",
        toolCallId: "edit-2",
        toolName: "edit",
        result: {},
        isError: false,
      },
      runtime.ctx,
    );
    await runtime.events.get("agent_settled")?.({ type: "agent_settled" }, runtime.ctx);
    expect(runtime.mounts).toHaveLength(2);
    expect(runtime.coordinator.getActiveInfo()?.state).toBe("visible");
  });

  it("does not reopen after a clean Hunk child exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-hunk-clean-exit-"));
    temporaryDirectories.push(root);
    process.env.PI_HUNK_CONFIG = join(root, "hunk.json");
    await writeFile(process.env.PI_HUNK_CONFIG, JSON.stringify({ review: "live" }));

    const runtime = harness(root);
    hunkExtension(runtime.pi, {
      store: new ConfigStore(),
      detector: new LiveDetector() as unknown as ChangeDetector,
      coordinator: runtime.coordinator,
      reviewRun: async () => ({ stdout: '{"sessions":[]}', stderr: "", code: 0 }),
    });
    await runtime.events.get("session_start")?.({ type: "session_start" }, runtime.ctx);
    await runtime.events.get("agent_start")?.({ type: "agent_start" }, runtime.ctx);

    const editInput = { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] };
    await runtime.events.get("tool_execution_start")?.(
      {
        type: "tool_execution_start",
        toolCallId: "edit-1",
        toolName: "edit",
        args: editInput,
      },
      runtime.ctx,
    );
    await vi.waitFor(() => expect(runtime.coordinator.getActiveInfo()?.state).toBe("visible"));
    runtime.mounts[0]!.options.done({ exitCode: 0 });
    await vi.waitFor(() => expect(runtime.coordinator.getActiveInfo()).toBeNull());
    await runtime.events.get("tool_execution_end")?.(
      {
        type: "tool_execution_end",
        toolCallId: "edit-1",
        toolName: "edit",
        result: {},
        isError: false,
      },
      runtime.ctx,
    );

    await runtime.events.get("agent_settled")?.({ type: "agent_settled" }, runtime.ctx);
    expect(runtime.mounts).toHaveLength(1);
    expect(runtime.coordinator.getActiveInfo()).toBeNull();
  });

  it("recovers after a nonzero child crash and a successful mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-hunk-crash-recover-"));
    temporaryDirectories.push(root);
    process.env.PI_HUNK_CONFIG = join(root, "hunk.json");
    await writeFile(process.env.PI_HUNK_CONFIG, JSON.stringify({ review: "live" }));

    const runtime = harness(root);
    hunkExtension(runtime.pi, {
      store: new ConfigStore(),
      detector: new LiveDetector() as unknown as ChangeDetector,
      coordinator: runtime.coordinator,
      reviewRun: async () => ({ stdout: '{"sessions":[]}', stderr: "", code: 0 }),
    });
    await runtime.events.get("session_start")?.({ type: "session_start" }, runtime.ctx);
    await runtime.events.get("agent_start")?.({ type: "agent_start" }, runtime.ctx);

    const editInput = { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] };
    await runtime.events.get("tool_execution_start")?.(
      {
        type: "tool_execution_start",
        toolCallId: "edit-1",
        toolName: "edit",
        args: editInput,
      },
      runtime.ctx,
    );
    await vi.waitFor(() => expect(runtime.coordinator.getActiveInfo()?.state).toBe("visible"));
    runtime.mounts[0]!.options.done({ exitCode: 2 });
    await vi.waitFor(() => expect(runtime.coordinator.getActiveInfo()).toBeNull());
    await runtime.events.get("tool_execution_end")?.(
      {
        type: "tool_execution_end",
        toolCallId: "edit-1",
        toolName: "edit",
        result: {},
        isError: false,
      },
      runtime.ctx,
    );

    await runtime.events.get("agent_settled")?.({ type: "agent_settled" }, runtime.ctx);
    expect(runtime.mounts).toHaveLength(2);
    expect(runtime.coordinator.getActiveInfo()?.state).toBe("visible");
  });

  it("recovers visibly at settle when the early live mount fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-hunk-live-recover-"));
    temporaryDirectories.push(root);
    process.env.PI_HUNK_CONFIG = join(root, "hunk.json");
    await writeFile(process.env.PI_HUNK_CONFIG, JSON.stringify({ review: "live" }));

    const runtime = harness(root, { failFirstMount: true });
    const detector = new LiveDetector();
    hunkExtension(runtime.pi, {
      store: new ConfigStore(),
      detector: detector as unknown as ChangeDetector,
      coordinator: runtime.coordinator,
      reviewRun: async () => ({ stdout: '{"sessions":[]}', stderr: "", code: 0 }),
    });
    await runtime.events.get("session_start")?.({ type: "session_start" }, runtime.ctx);
    await runtime.events.get("agent_start")?.({ type: "agent_start" }, runtime.ctx);
    const editInput = { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] };
    await runtime.events.get("tool_execution_start")?.(
      {
        type: "tool_execution_start",
        toolCallId: "edit-1",
        toolName: "edit",
        args: editInput,
      },
      runtime.ctx,
    );
    await runtime.events.get("tool_call")?.(
      {
        type: "tool_call",
        toolCallId: "edit-1",
        toolName: "edit",
        input: editInput,
      },
      runtime.ctx,
    );
    await runtime.events.get("tool_execution_end")?.(
      {
        type: "tool_execution_end",
        toolCallId: "edit-1",
        toolName: "edit",
        result: {},
        isError: false,
      },
      runtime.ctx,
    );

    await runtime.events.get("agent_settled")?.({ type: "agent_settled" }, runtime.ctx);

    expect(runtime.coordinator.getActiveInfo()?.state).toBe("visible");
    expect(runtime.mounts).toHaveLength(1);
    expect(runtime.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Early Hunk open failed"),
      "warning",
    );
  });
});
