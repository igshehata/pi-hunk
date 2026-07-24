import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeDetector, mutationTargetPaths } from "../extensions/change-detector.ts";
import {
  canonicalPathIsInside,
  normalizeCandidatePath,
  resolveLaunchDirectory,
} from "../extensions/path-routing.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

describe("mutation target evidence", () => {
  it("normalizes, deduplicates, and preserves every common structured target", () => {
    expect(
      mutationTargetPaths(
        {
          path: "src/a.ts",
          file_path: "src/a.ts",
          edits: [{ filePath: "../repo-b/src/b.ts" }, { file: "/tmp/c.ts" }, { path: "src/a.ts" }],
        },
        "/work/repo-a",
      ),
    ).toEqual(["/work/repo-a/src/a.ts", "/work/repo-b/src/b.ts", "/tmp/c.ts"]);
  });

  it("records successful target and pathless evidence separately", () => {
    const detector = new ChangeDetector();
    detector.recordSuccessfulMutation("write", { path: "../repo-b/a.ts" }, "/work/repo-a");
    detector.recordSuccessfulMutation(
      "bash",
      { command: "cd ../repo-c && touch b.ts" },
      "/work/repo-a",
    );
    detector.recordSuccessfulMutation(
      "multi_edit",
      {
        edits: [{ path: "../repo-b/a.ts" }, { path: "../repo-b/c.ts" }],
      },
      "/work/repo-a",
    );

    expect(detector.peekSettled()).toMatchObject({
      mutation: true,
      targets: ["/work/repo-b/a.ts", "/work/repo-b/c.ts"],
      unresolved: true,
      revision: 3,
    });
  });
});

describe("safe launch-directory routing", () => {
  it("uses directories directly, file parents, and nearest existing parents", async () => {
    const root = await temporaryRoot("pi-hunk-paths-");
    const directory = join(root, "repo", "src");
    const file = join(directory, "a.ts");
    await mkdir(directory, { recursive: true });
    await writeFile(file, "a");

    await expect(resolveLaunchDirectory(directory)).resolves.toBe(
      await resolveLaunchDirectory(root + "/repo/src"),
    );
    await expect(resolveLaunchDirectory(file)).resolves.toBe(
      await resolveLaunchDirectory(directory),
    );
    await expect(resolveLaunchDirectory(join(directory, "missing", "new.ts"))).resolves.toBe(
      await resolveLaunchDirectory(directory),
    );
  });

  it("resolves explicit relative values from Pi's startup cwd and rejects unsafe input", () => {
    expect(normalizeCandidatePath("../repo-b", "/work/repo-a")).toBe("/work/repo-b");
    expect(() => normalizeCandidatePath("", "/work/repo-a")).toThrow(/must not be empty/);
    expect(() => normalizeCandidatePath("bad\0path", "/work/repo-a")).toThrow(/NUL/);
  });

  it.runIf(process.platform !== "win32")(
    "canonicalizes symlinked targets for boundary-aware containment",
    async () => {
      const root = await temporaryRoot("pi-hunk-containment-");
      const realRepo = join(root, "repo");
      const linkedRepo = join(root, "linked");
      await mkdir(join(realRepo, "src"), { recursive: true });
      await symlink(realRepo, linkedRepo);

      await expect(
        canonicalPathIsInside(join(linkedRepo, "src", "missing.ts"), realRepo),
      ).resolves.toBe(true);
      await expect(
        canonicalPathIsInside(join(dirname(realRepo), "repo-sibling", "a.ts"), realRepo),
      ).resolves.toBe(false);
    },
  );
});
