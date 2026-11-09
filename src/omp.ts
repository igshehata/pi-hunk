import { getAgentDir, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { isKeyRelease, matchesKey, type KeyId } from "@oh-my-pi/pi-tui";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHost } from "./host.js";

export default function ompHunk(omp: ExtensionAPI): void {
  const host = createHost({
    bridge: fileURLToPath(new URL("./pi-hunk-review.js", import.meta.url)),
    configPath: join(getAgentDir(), "pi-hunk.json"),
    matchesKey: (data, key) => matchesKey(data, key as KeyId),
    isKeyRelease,
    sendUserMessage: (message, options) => omp.sendUserMessage(message, options),
  });
  omp.registerCommand("hunk", host.command);
  omp.on("session_start", (_event, ctx) => host.start(ctx));
  omp.on("session_switch", (_event, ctx) => host.start(ctx));
  omp.on("session_branch", (_event, ctx) => host.start(ctx));
  omp.on("session_tree", (_event, ctx) => host.start(ctx));
  // OMP emits this only when the session is disposed, i.e. the process is quitting. It restores
  // the terminal only after this handler settles, and exits through the native primitive without
  // an `exit` event, so the recovery notice is written once teardown is done.
  omp.on("session_shutdown", async () => {
    await host.stop(true);
    host.announceAbandoned();
  });
}
