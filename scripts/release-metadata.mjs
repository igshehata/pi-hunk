import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const requestedVersion = process.argv[2];
const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const name = packageJson.name;

function fail(message) {
  throw new Error(`release finalization refused: ${message}`);
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

if (name !== "pi-hunk") fail("package name is not pi-hunk");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requestedVersion ?? "")) {
  fail(`invalid requested version: ${requestedVersion ?? "(missing)"}`);
}

const encodedName = encodeURIComponent(name).replace(/^%40/, "@");
const response = await fetch(`https://registry.npmjs.org/${encodedName}/${requestedVersion}`, {
  headers: { accept: "application/json" },
});
if (response.status === 404) fail(`${name}@${requestedVersion} is not published`);
if (!response.ok) fail(`npm registry returned HTTP ${response.status}`);

const metadata = await response.json();
if (metadata.name !== name || metadata.version !== requestedVersion) {
  fail("registry returned mismatched package metadata");
}
if (!/^[0-9a-f]{40}$/.test(metadata.gitHead ?? "")) {
  fail("published package has no valid gitHead");
}
if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(metadata.dist?.integrity ?? "")) {
  fail("published package has no valid SHA-512 integrity");
}

appendOutput({
  package: name,
  version: requestedVersion,
  commit: metadata.gitHead,
  integrity: metadata.dist.integrity,
  tag: `v${requestedVersion}`,
});
