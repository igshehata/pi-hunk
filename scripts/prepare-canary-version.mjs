import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const packagePath = resolve(root, "package.json");
const args = process.argv.slice(2);
const runNumber = process.env.GITHUB_RUN_NUMBER ?? process.env.CANARY_RUN_NUMBER;
const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? process.env.CANARY_RUN_ATTEMPT;
const CANARY_VERSION_PATTERN = /^0\.0\.0-canary\.([1-9]\d*)\.([1-9]\d*)$/;

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
let selectedVersion;
if (args.length === 1 && args[0] === "--write") {
  writePackage = true;
} else if (args.length === 3 && args[0] === "--write" && args[1] === "--version" && args[2]) {
  writePackage = true;
  selectedVersion = args[2];
} else if (args.length !== 0) {
  fail("usage: prepare-canary-version.mjs [--write [--version <canary-version>]]");
}
if (!/^[1-9]\d*$/.test(runNumber ?? "")) fail("run number must be a positive integer");

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

let version;
if (selectedVersion !== undefined) {
  const match = CANARY_VERSION_PATTERN.exec(selectedVersion);
  if (!match) {
    fail(`selected version must match 0.0.0-canary.<run>.<attempt>, received ${selectedVersion}`);
  }
  if (match[1] !== runNumber) {
    fail(`selected version belongs to run ${match[1]}, not current run ${runNumber}`);
  }
  version = selectedVersion;
} else {
  if (!/^[1-9]\d*$/.test(runAttempt ?? "")) fail("run attempt must be a positive integer");
  version = `0.0.0-canary.${runNumber}.${runAttempt}`;
}
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
