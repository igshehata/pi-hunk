import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const packagePath = resolve(root, "package.json");
const args = process.argv.slice(2);
const writePackage = args.includes("--write");
const runNumber = process.env.GITHUB_RUN_NUMBER ?? process.env.CANARY_RUN_NUMBER;
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

if (args.some((argument) => argument !== "--write")) {
  fail("usage: prepare-canary-version.mjs [--write]");
}
if (!/^[1-9]\d*$/.test(runNumber ?? "")) fail("run number must be a positive integer");
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

const version = `0.0.0-canary.${runNumber}.${runAttempt}`;
if (writePackage) {
  packageJson.version = version;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

appendOutput({
  should_stage: "true",
  reason: "canary",
  package: packageJson.name,
  version,
  stream: "canary",
  tag: "canary",
});
