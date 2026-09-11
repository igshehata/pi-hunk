import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const effectEntry = 'import * as Effect from "effect/Effect";\nconsole.log(Effect.succeed(1));\n';

type Layout = "local" | "hoisted";

async function createFixture(layout: Layout, piSource = effectEntry) {
  const scratch = await mkdtemp(join(tmpdir(), "pi-hunk-build-test-"));
  const packageRoot = layout === "local" ? scratch : join(scratch, "packages", "pi-hunk");
  const dependencyRoot =
    layout === "local" ? join(packageRoot, "node_modules") : join(scratch, "node_modules");
  await Promise.all([
    mkdir(join(packageRoot, "scripts"), { recursive: true }),
    mkdir(join(packageRoot, "src"), { recursive: true }),
    mkdir(dependencyRoot, { recursive: true }),
  ]);
  await Promise.all([
    copyFile(join(repositoryRoot, "scripts/build.mjs"), join(packageRoot, "scripts/build.mjs")),
    ...["pi", "omp", "hunk"].map((entry) =>
      writeFile(join(packageRoot, "src", `${entry}.ts`), piSource),
    ),
    ...["effect", "esbuild"].map((dependency) =>
      symlink(
        resolve(repositoryRoot, "node_modules", dependency),
        join(dependencyRoot, dependency),
        "dir",
      ),
    ),
    symlink(
      resolve(repositoryRoot, "node_modules/@esbuild"),
      join(dependencyRoot, "@esbuild"),
      "dir",
    ),
  ]);
  return { scratch, packageRoot, dependencyRoot };
}

function runBuild(packageRoot: string) {
  const result = spawnSync(process.execPath, [join(packageRoot, "scripts/build.mjs")], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("production build dependency policy", () => {
  it("accepts Effect installed alongside the package", async () => {
    const fixture = await createFixture("local");
    try {
      const result = runBuild(fixture.packageRoot);
      expect(result.status).toBe(0);
    } finally {
      await rm(fixture.scratch, { recursive: true, force: true });
    }
  });

  it("accepts Effect hoisted above a workspace package", async () => {
    const fixture = await createFixture("hoisted");
    try {
      const result = runBuild(fixture.packageRoot);
      expect(result.status).toBe(0);
    } finally {
      await rm(fixture.scratch, { recursive: true, force: true });
    }
  });

  it("rejects a bundled runtime library other than Effect", async () => {
    const fixture = await createFixture(
      "local",
      'import { marker } from "other-runtime";\nconsole.log(marker);\n',
    );
    try {
      const otherRuntime = join(fixture.dependencyRoot, "other-runtime");
      await mkdir(otherRuntime, { recursive: true });
      await Promise.all([
        writeFile(
          join(otherRuntime, "package.json"),
          '{"name":"other-runtime","version":"1.0.0","type":"module"}\n',
        ),
        writeFile(join(otherRuntime, "index.js"), 'export const marker = "other runtime";\n'),
      ]);
      const result = runBuild(fixture.packageRoot);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "bundles a runtime library other than Effect: node_modules/other-runtime/index.js",
      );
    } finally {
      await rm(fixture.scratch, { recursive: true, force: true });
    }
  });
});
