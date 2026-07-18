import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// libghostty's ABI-stable package currently carries three platform prebuilds.
// Keep bounded headroom over the measured 15.9 MB clean consumer install.
const MAX_RUNTIME_BYTES = 19_000_000;
const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "pi-hunk-package-"));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function logicalBytes(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? logicalBytes(child) : entry.isFile() ? statSync(child).size : 0;
  }
  return total;
}

function fail(message) {
  throw new Error(`Package verification failed: ${message}`);
}

try {
  if (packageJson.name !== "pi-hunk" || packageJson.private === true) {
    fail("package must be publishable as pi-hunk");
  }
  if (
    packageJson.main !== "./dist/index.js" ||
    packageJson.pi?.extensions?.[0] !== "./dist/index.js"
  ) {
    fail("package entry points must resolve to dist/index.js");
  }
  if (packageJson.publishConfig?.access !== "public") fail("npm access must be public");
  if (packageJson.repository?.url !== "git+https://github.com/igshehata/pi-hunk.git") {
    fail("repository metadata does not match the public repository");
  }

  const pack = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", scratch], {
      cwd: root,
      encoding: "utf8",
    }),
  )[0];
  const paths = new Set(pack.files.map((file) => file.path));
  for (const required of [
    "dist/index.js",
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
  ]) {
    if (!paths.has(required)) fail(`missing ${required}`);
  }
  if (
    [...paths].some(
      (path) =>
        path === "docs" ||
        path.startsWith("docs/") ||
        path === "extensions" ||
        path.startsWith("extensions/") ||
        path === "test" ||
        path.startsWith("test/"),
    )
  ) {
    fail("source extensions or tests leaked into the package");
  }

  const nativeChunks = [...paths].filter((path) => /^dist\/chunks\/.*\.js$/.test(path));
  if (nativeChunks.length === 0) fail("lazy embedded-terminal chunk is missing");
  const entrySource = readFileSync(join(root, "dist", "index.js"), "utf8");
  if (entrySource.includes("zigpty") || entrySource.includes("@coder/libghostty-vt-node")) {
    fail("native terminal dependencies leaked into the eager extension entry");
  }
  const chunkSource = nativeChunks.map((path) => readFileSync(join(root, path), "utf8")).join("\n");
  if (!chunkSource.includes("zigpty") || !chunkSource.includes("@coder/libghostty-vt-node")) {
    fail("lazy embedded-terminal chunk does not contain both native adapters");
  }

  const consumer = join(scratch, "consumer");
  mkdirSync(consumer);
  execFileSync("npm", ["init", "-y"], { cwd: consumer, stdio: "ignore" });
  execFileSync("npm", ["install", "--no-audit", "--no-fund", join(scratch, pack.filename)], {
    cwd: consumer,
    stdio: "ignore",
  });

  const modules = join(consumer, "node_modules");
  const runtimeBytes = logicalBytes(modules);
  if (runtimeBytes > MAX_RUNTIME_BYTES) {
    fail(`installed runtime is ${runtimeBytes} bytes; limit is ${MAX_RUNTIME_BYTES}`);
  }
  for (const forbidden of [
    "effect",
    "fast-check",
    "pure-rand",
    "node-pty",
    join("@standard-schema", "spec"),
    join("@earendil-works", "pi-coding-agent"),
    join("@earendil-works", "pi-tui"),
  ]) {
    if (existsSync(join(modules, forbidden))) fail(`${forbidden} was installed at runtime`);
  }
  for (const required of ["pi-hunk", "zigpty", join("@coder", "libghostty-vt-node")]) {
    if (!existsSync(join(modules, required)))
      fail(`${required} is missing from the runtime install`);
  }

  const entry = join(modules, "pi-hunk", "dist", "index.js");
  const pi = resolve(root, "node_modules", ".bin", "pi");
  const rpc = spawnSync(pi, ["--mode", "rpc", "--no-session", "--no-extensions", "-e", entry], {
    cwd: consumer,
    encoding: "utf8",
    input: `${JSON.stringify({ type: "prompt", message: "/hunk status" })}\n`,
  });
  if (rpc.status !== 0) fail(`Pi RPC load exited ${rpc.status}: ${rpc.stderr}`);
  if (!/statusKey":"hunk|Hunk status|hunk:/.test(rpc.stdout))
    fail("packed extension did not register Hunk status");

  console.log(
    JSON.stringify(
      {
        status: "passed",
        packedBytes: pack.size,
        packedFiles: pack.entryCount,
        installedRuntimeBytes: runtimeBytes,
        runtimeLimitBytes: MAX_RUNTIME_BYTES,
        effectInstalled: false,
        piPeersAutoInstalled: false,
        piRpcLoad: true,
        lazyNativeChunk: true,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
