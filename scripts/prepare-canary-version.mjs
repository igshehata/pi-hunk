import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const packagePath = resolve(root, "package.json");
const args = process.argv.slice(2);
// The run id is unique across every workflow of the repository, so a canary version can never
// collide with one an earlier workflow already published (npm versions are immutable).
const runId = process.env.GITHUB_RUN_ID ?? process.env.CANARY_RUN_ID;
const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? process.env.CANARY_RUN_ATTEMPT;

function fail(message) {
  throw new Error(`canary preparation refused: ${message}`);
}

function appendOutput(values) {
  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `${body}\n`, { flag: "a" });
  }
  console.log(JSON.stringify(values));
}

let writePackage = false;
if (args.length === 1 && args[0] === "--write") {
  writePackage = true;
} else if (args.length !== 0) {
  fail("usage: prepare-canary-version.mjs [--write]");
}
if (!/^[1-9]\d*$/.test(runId ?? "")) fail("run id must be a positive integer");
if (!/^[1-9]\d*$/.test(runAttempt ?? "")) fail("run attempt must be a positive integer");

let packageJson;
try {
  packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
} catch (error) {
  fail(`could not read package.json: ${error instanceof Error ? error.message : String(error)}`);
}
if (packageJson.name !== "pi-hunk") fail("package name is not pi-hunk");
if (!/^\d+\.\d+\.\d+$/.test(packageJson.version ?? "")) {
  fail(`base package version must be stable x.y.z, received ${String(packageJson.version)}`);
}

const version = `0.0.0-canary.${runId}.${runAttempt}`;
if (writePackage) {
  packageJson.version = version;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

appendOutput({ package: packageJson.name, version, tag: "canary" });
