import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "pi-hunk-package-"));
// Use the host runtime, not a transitive npm Bun installer's uninitialized stub.
const hostEnvironment = {
  ...process.env,
  PATH: (process.env.PATH ?? "")
    .split(delimiter)
    .filter((path) => !path.endsWith("node_modules/.bin"))
    .join(delimiter),
};
const hostEntries = {
  pi: {
    file: "pi.js",
    runtime: process.execPath,
    sdks: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"],
  },
  omp: {
    file: "omp.js",
    runtime: "bun",
    sdks: ["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-tui"],
  },
  hunk: { file: "pi-hunk-review.js", runtime: process.execPath, sdks: ["hunkdiff"] },
};
const optionalPeers = {
  "@earendil-works/pi-coding-agent": true,
  "@earendil-works/pi-tui": true,
  "@oh-my-pi/pi-coding-agent": true,
  "@oh-my-pi/pi-tui": true,
  hunkdiff: true,
};

try {
  // Verify the existing build: packing must not silently rebuild different bytes.
  const pack = JSON.parse(
    execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], {
      cwd: root,
      encoding: "utf8",
    }),
  )[0];
  const paths = new Set(pack.files.map((file) => file.path));
  for (const required of [
    "dist/pi.js",
    "dist/omp.js",
    "dist/pi-hunk-review.js",
    "package.json",
    "README.md",
    "assets/hero.svg",
    "LICENSE",
  ]) {
    assert(paths.has(required), `Packed artifact is missing ${required}`);
  }
  const allowedDocuments = {
    "package.json": true,
    "README.md": true,
    "assets/hero.svg": true,
    "CHANGELOG.md": true,
    LICENSE: true,
  };
  for (const path of paths) {
    assert(
      allowedDocuments[path] || /^dist\/(?:chunks\/)?[^/]+\.js$/.test(path),
      `Unexpected packed file: ${path}`,
    );
  }

  const consumer = join(scratch, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(scratch, pack.filename)],
    { cwd: consumer, stdio: "pipe" },
  );

  const modules = join(consumer, "node_modules");
  assert.deepEqual(
    readdirSync(modules).filter((name) => name !== ".package-lock.json"),
    ["pi-hunk"],
    "A clean consumer must install pi-hunk alone, without runtime dependencies or automatic peers",
  );
  const installed = join(modules, "pi-hunk");
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(manifest.name, "pi-hunk");
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.type, "module");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(manifest.repository?.url, "git+https://github.com/igshehata/pi-hunk.git");
  assert.deepEqual(manifest.pi?.extensions, ["./dist/pi.js"]);
  assert.deepEqual(manifest.omp?.extensions, ["./dist/omp.js"]);
  assert.equal(manifest.main, undefined, "Hosts must use their independent manifest entrypoints");
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "bundledDependencies",
    "bundleDependencies",
  ]) {
    assert.equal(Object.keys(manifest[field] ?? {}).length, 0, `Unexpected ${field}`);
  }
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    assert(optionalPeers[name], `Unexpected peer: ${name}`);
    assert.equal(
      manifest.peerDependenciesMeta?.[name]?.optional,
      true,
      `Peer ${name} must be host-provided`,
    );
  }

  // Prove each packed entry loads with only its own real host SDK packages available.
  // Symlinks provide the development SDK, not mocks or consumer dependencies.
  const imports = [];
  for (const [host, { file, runtime, sdks }] of Object.entries(hostEntries)) {
    const sdkLinks = sdks.map((sdk) => {
      const link = join(modules, sdk);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(resolve(root, "node_modules", sdk), link, "dir");
      return link;
    });
    try {
      const url = pathToFileURL(join(installed, "dist", file)).href;
      execFileSync(
        runtime,
        [
          "--input-type=module",
          "-e",
          `
        const extension = await import(${JSON.stringify(url)});
        if (typeof extension.default !== "function") throw new Error("Missing extension factory");
      `,
        ],
        { cwd: consumer, env: hostEnvironment, stdio: "pipe", timeout: 30_000 },
      );
      imports.push(host);
    } finally {
      for (const link of sdkLinks) rmSync(link);
    }
  }

  const bundledBytes = pack.files
    .filter((file) => file.path.startsWith("dist/"))
    .reduce((total, file) => total + statSync(join(installed, file.path)).size, 0);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        packedBytes: pack.size,
        unpackedBytes: pack.unpackedSize,
        bundledBytes,
        packedFiles: pack.entryCount,
        separatelyInstalledRuntimeDependencies: 0,
        hostImports: imports,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
