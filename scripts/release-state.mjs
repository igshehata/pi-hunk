import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const name = packageJson.name;
const version = packageJson.version;
const encodedName = encodeURIComponent(name).replace(/^%40/, "@");
const registryBase = `https://registry.npmjs.org/${encodedName}`;

function appendOutput(values) {
  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `${body}\n`, { flag: "a" });
  }
  console.log(JSON.stringify(values));
}

async function status(url) {
  const response = await fetch(url, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  if (response.status !== 200 && response.status !== 404) {
    throw new Error(`npm registry returned HTTP ${response.status} for ${url}`);
  }
  return response.status;
}

if (name !== "pi-hunk") throw new Error("release-state only supports pi-hunk");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`invalid package version: ${version}`);
}

const pendingChangesets = readdirSync(join(root, ".changeset")).filter(
  (file) => file.endsWith(".md") && file !== "README.md",
);
const packageStatus = await status(registryBase);
const versionStatus = packageStatus === 200 ? await status(`${registryBase}/${version}`) : 404;

let reason;
if (packageStatus === 404) reason = "bootstrap-required";
else if (pendingChangesets.length > 0) reason = "pending-changesets";
else if (versionStatus === 200) reason = "already-published";
else reason = "unpublished-version";

appendOutput({
  should_stage: reason === "unpublished-version" ? "true" : "false",
  reason,
  package: name,
  version,
});
