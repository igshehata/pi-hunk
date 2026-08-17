import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const name = packageJson.name;
const version = packageJson.version;
const encodedName = encodeURIComponent(name).replace(/^%40/, "@");
const registryOrigin = (
  process.env.NPM_CONFIG_REGISTRY ??
  process.env.npm_config_registry ??
  "https://registry.npmjs.org"
).replace(/\/+$/, "");
const registryBase = `${registryOrigin}/${encodedName}`;

function appendOutput(values) {
  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `${body}\n`, { flag: "a" });
  }
  console.log(JSON.stringify(values));
}

async function publishedVersions(url) {
  const response = await fetch(url, {
    // The abbreviated media type is valid for the package packument, but npm
    // returns 406 when it is sent to a version-specific endpoint.
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  if (response.status === 404) return null;
  if (response.status !== 200) {
    throw new Error(`npm registry returned HTTP ${response.status} for ${url}`);
  }

  const metadata = await response.json();
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata.name !== name ||
    !metadata.versions ||
    typeof metadata.versions !== "object" ||
    Array.isArray(metadata.versions)
  ) {
    throw new Error(`npm registry returned invalid package metadata for ${url}`);
  }
  return new Set(Object.keys(metadata.versions));
}

if (name !== "pi-hunk") throw new Error("release-state only supports pi-hunk");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`invalid stable package version: ${version}`);
}

const pendingChangesets = readdirSync(join(root, ".changeset")).filter(
  (file) => file.endsWith(".md") && file !== "README.md",
);
let reason;
if (pendingChangesets.length > 0) {
  // Version-PR creation must not depend on registry availability. The package
  // lookup matters only once a commit has consumed every Changeset.
  reason = "pending-changesets";
} else {
  const versions = await publishedVersions(registryBase);
  if (versions === null) reason = "bootstrap-required";
  else if (versions.has(version)) reason = "already-published";
  else reason = "unpublished-version";
}

appendOutput({
  should_stage: reason === "unpublished-version" ? "true" : "false",
  reason,
  package: name,
  version,
  stream: "stable",
  tag: "latest",
});
