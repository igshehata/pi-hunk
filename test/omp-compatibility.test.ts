import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import hunkExtension from "../extensions/index.ts";
import { ReviewHandoffGate } from "../extensions/review-handoff.ts";

const temporaryDirectories: string[] = [];

type EventHandler = (event: unknown, ctx: ExtensionCommandContext) => Promise<void> | void;
type CommandHandler = (input: string, ctx: ExtensionCommandContext) => Promise<void> | void;
type ShortcutHandler = (ctx: ExtensionCommandContext) => Promise<void> | void;

function createOmpExtension() {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, CommandHandler>();
  const shortcuts = new Map<string, ShortcutHandler>();

  const api = {
    zod: {},
    on: (name: string, handler: EventHandler) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    registerCommand: (
      name: string,
      spec: {
        handler: CommandHandler;
      },
    ) => commands.set(name, spec.handler),
    registerShortcut: (
      key: string,
      spec: {
        handler: ShortcutHandler;
      },
    ) => shortcuts.set(key, spec.handler),
    sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI;

  return {
    api,
    commands,
    handlers,
    shortcuts,
    async emit(name: string, event: unknown, ctx: ExtensionCommandContext): Promise<void> {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}

function createOmpContext(cwd: string) {
  const notify = vi.fn();
  const setStatus = vi.fn();
  const ctx = {
    cwd,
    mode: "tui",
    isIdle: () => true,
    waitForIdle: async () => undefined,
    ui: {
      notify,
      setStatus,
      theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notify, setStatus };
}

afterEach(async () => {
  delete process.env.PI_HUNK_CONFIG;
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("OMP extension compatibility", () => {
  it("registers configured shortcuts before startup and settles only terminal agent_end", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-hunk-omp-bootstrap-"));
    temporaryDirectories.push(root);
    process.env.PI_HUNK_CONFIG = join(root, "hunk.json");
    await writeFile(
      process.env.PI_HUNK_CONFIG,
      JSON.stringify({ review: "after-run", bindings: { prefix: "alt+z" } }),
    );

    const extension = createOmpExtension();
    const presentAutomatic = vi
      .spyOn(ReviewHandoffGate.prototype, "presentAutomatic")
      .mockResolvedValue({ status: "no-evidence" });

    await hunkExtension(extension.api);

    expect([...extension.commands.keys()]).toEqual(["hunk"]);
    expect([...extension.shortcuts.keys()]).toEqual(["alt+z"]);
    expect(extension.handlers.get("agent_end")).toHaveLength(1);
    expect(extension.handlers.has("agent_settled")).toBe(false);

    const { ctx, notify, setStatus } = createOmpContext(root);
    await extension.emit("session_start", { type: "session_start" }, ctx);

    expect(notify).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenLastCalledWith("hunk", "hunk: after-run");

    await extension.emit("agent_start", { type: "agent_start" }, ctx);
    await extension.emit(
      "tool_execution_start",
      {
        type: "tool_execution_start",
        toolCallId: "write-1",
        toolName: "write",
        args: { path: "src/a.ts", content: "export const a = 1;" },
      },
      ctx,
    );
    await extension.emit(
      "tool_execution_end",
      {
        type: "tool_execution_end",
        toolCallId: "write-1",
        toolName: "write",
        result: { content: [] },
        isError: false,
      },
      ctx,
    );

    await extension.emit("agent_end", { type: "agent_end", messages: [], willContinue: true }, ctx);
    expect(presentAutomatic).not.toHaveBeenCalled();

    await extension.emit(
      "agent_end",
      { type: "agent_end", messages: [], willContinue: false },
      ctx,
    );
    expect(presentAutomatic).toHaveBeenCalledOnce();

    await extension.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  });
});
