import { ConfigStore } from "../../extensions/config.ts";

const [configPath, key, rawValue] = process.argv.slice(2);
if (!configPath || !key || rawValue === undefined) {
  throw new Error("usage: config-persist-worker <config-path> <key> <json-value>");
}

process.env.PI_HUNK_CONFIG = configPath;
const context = {
  cwd: process.cwd(),
  isProjectTrusted: () => false,
};
await new ConfigStore().persist(context, "global", { [key]: JSON.parse(rawValue) });
