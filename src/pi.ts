import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type KeyId } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHost } from "./host.js";

export default function piHunk(pi: ExtensionAPI): void {
  const host = createHost({
    bridge: fileURLToPath(new URL("./pi-hunk-review.js", import.meta.url)),
    configPath: join(getAgentDir(), "pi-hunk.json"),
    matchesKey: (data, key) => matchesKey(data, key as KeyId),
    isKeyRelease,
    sendUserMessage: (message, options) => pi.sendUserMessage(message, options),
  });
  pi.registerCommand("hunk", host.command);
  pi.on("session_start", (_event, ctx) => host.start(ctx));
  pi.on("session_tree", (_event, ctx) => host.start(ctx));
  pi.on("session_shutdown", () => host.stop());
}
