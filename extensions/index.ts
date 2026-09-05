import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Effect, Either } from "effect";
import { loadConfig } from "./config.ts";
import { makeHunkMachine, type HunkMachine } from "./machine.ts";
import { cloneConfig, DEFAULT_CONFIG, type HunkConfig, type HunkMode } from "./model.ts";

type HunkCommand =
  | { readonly _tag: "Toggle"; readonly mode: HunkMode; readonly target?: string }
  | { readonly _tag: "Configure"; readonly operation: "edit" | "restore" };

function parseCommand(input: string): HunkCommand | undefined {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { _tag: "Toggle", mode: "diff" };

  const [command, ...rest] = parts;
  if (command === "config") {
    if (rest.length === 0) return { _tag: "Configure", operation: "edit" };
    if (rest.length === 1 && rest[0] === "restore") {
      return { _tag: "Configure", operation: "restore" };
    }
    return undefined;
  }
  if (command === "diff" || command === "show") {
    if (rest.length > 1) return undefined;
    return {
      _tag: "Toggle",
      mode: command,
      ...(rest[0] ? { target: rest[0] } : {}),
    };
  }
  if (command === "stash") {
    const target = rest[0] === "show" ? rest.slice(1) : rest;
    if (target.length > 1) return undefined;
    return {
      _tag: "Toggle",
      mode: "stash",
      ...(target[0] ? { target: target[0] } : {}),
    };
  }
  return undefined;
}

function commandUsage(ctx: ExtensionContext): void {
  ctx.ui.notify(
    "Usage: /hunk [diff [target] | show [target] | stash [ref] | config [restore]]",
    "warning",
  );
}

function reportFailure(ctx: ExtensionContext, cause: unknown): void {
  ctx.ui.notify(cause instanceof Error ? cause.message : String(cause), "error");
}

async function handleCommand(
  input: string,
  ctx: ExtensionCommandContext,
  machine: HunkMachine,
): Promise<void> {
  const command = parseCommand(input);
  if (!command) {
    commandUsage(ctx);
    return;
  }
  try {
    if (command._tag === "Configure") {
      await machine.configure(ctx, command.operation);
    } else {
      await machine.toggle(ctx, command.mode, command.target);
    }
  } catch (cause) {
    reportFailure(ctx, cause);
  }
}

const hunkExtension: ExtensionFactory = async (pi: ExtensionAPI): Promise<void> => {
  const loaded = await Effect.runPromise(Effect.either(loadConfig));
  const config: HunkConfig = Either.isRight(loaded) ? loaded.right : cloneConfig(DEFAULT_CONFIG);
  const warning = Either.isLeft(loaded) ? loaded.left.message : undefined;
  const machine = await Effect.runPromise(makeHunkMachine(pi, config));

  pi.registerShortcut(config.hotkeys.prefix, {
    description:
      `Pi-hunk prefix (then ${config.hotkeys.diff} diff, ${config.hotkeys.show} show, ` +
      `${config.hotkeys.stash} stash)`,
    handler: async (ctx) => {
      try {
        await machine.choose(ctx);
      } catch (cause) {
        reportFailure(ctx, cause);
      }
    },
  });

  pi.registerCommand("hunk", {
    description: "Full-screen Hunk takeover: diff, show, stash, or hotkey configuration",
    handler: (input, ctx) => handleCommand(input, ctx, machine),
  });

  pi.on("session_start", (_event, ctx) => {
    if (warning) ctx.ui.notify(`${warning} Using default Pi-hunk hotkeys.`, "warning");
  });
  pi.on("session_shutdown", () => machine.shutdown());
};

export default hunkExtension;
