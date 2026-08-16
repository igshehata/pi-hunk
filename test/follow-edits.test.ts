import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { navigateHunkSession, runHunk } from "../extensions/hunk-session.ts";
import { mutationTargetPath, toWorkspaceRelative } from "../extensions/change-detector.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  });
}

describe("mutationTargetPath", () => {
  it("reads common path keys from edit/write tools", () => {
    expect(mutationTargetPath({ path: "src/a.ts" })).toBe("src/a.ts");
    expect(mutationTargetPath({ file_path: "src/b.ts" })).toBe("src/b.ts");
    expect(mutationTargetPath({ filePath: "src/c.ts" })).toBe("src/c.ts");
    expect(mutationTargetPath({ file: "src/d.ts" })).toBe("src/d.ts");
  });

  it("reads path from multi-edit payloads", () => {
    expect(
      mutationTargetPath({
        edits: [{ path: "extensions/index.ts", oldText: "a", newText: "b" }],
      }),
    ).toBe("extensions/index.ts");
  });

  it("normalizes the first target even when it is outside Pi's workspace", () => {
    expect(
      mutationTargetPath(
        { edits: [{ path: "/tmp/outside.ts" }, { path: "src/inside.ts" }] },
        "/repo",
      ),
    ).toBe("/tmp/outside.ts");
    expect(mutationTargetPath({ path: "../sibling.ts" }, "/repo/project")).toBe("/repo/sibling.ts");
    expect(mutationTargetPath({ path: "..config/generated.ts" }, "/repo/project")).toBe(
      "/repo/project/..config/generated.ts",
    );
  });

  it("returns undefined when no path is present", () => {
    expect(mutationTargetPath(null)).toBeUndefined();
    expect(mutationTargetPath({ command: "touch x" })).toBeUndefined();
    expect(mutationTargetPath({ edits: [{}] })).toBeUndefined();
  });
});

describe("toWorkspaceRelative", () => {
  it("strips the Pi workspace prefix without assuming a VCS root", () => {
    expect(toWorkspaceRelative("/workspace/src/a.ts", "/workspace")).toBe("src/a.ts");
    expect(toWorkspaceRelative("/workspace/", "/workspace")).toBe(".");
    expect(toWorkspaceRelative("src/a.ts", "/workspace")).toBe("src/a.ts");
    expect(toWorkspaceRelative("../sibling.ts", "/workspace/project")).toBe("../sibling.ts");
    expect(toWorkspaceRelative("..config/generated.ts", "/workspace/project")).toBe(
      "..config/generated.ts",
    );
  });
});

describe("runHunk", () => {
  it("prefixes the binary and returns stdout on success", async () => {
    const run = vi.fn(async (argv: string[]) => {
      expect(argv).toEqual(["hunk-dev", "session", "list", "--repo", "/repo"]);
      return { stdout: "ok\n", stderr: "", code: 0 };
    });

    const out = await runHunk(["session", "list", "--repo", "/repo"], {
      hunkBinary: "hunk-dev",
      run,
    });
    expect(out).toBe("ok\n");
  });

  it("surfaces stderr first on failure, then stdout, then a generic message", async () => {
    const fail = (stdout: string, stderr: string) =>
      runHunk(["session", "reload"], { run: async () => ({ stdout, stderr, code: 2 }) });

    await expect(fail("out", "boom")).rejects.toThrow("boom");
    await expect(fail("out", "")).rejects.toThrow("out");
    await expect(fail("", "")).rejects.toThrow("hunk session reload failed (2)");
  });
});

describe("navigateHunkSession", () => {
  const launchedAt = "2026-01-01T00:00:00.000Z";
  const session = (overrides: Record<string, unknown> = {}) => ({
    sessionId: "s1",
    pid: 101,
    cwd: "/repo",
    repoRoot: "/repo",
    launchedAt,
    fileCount: 1,
    files: [{ path: "src/a.ts" }],
    ...overrides,
  });

  function runner(sessions: unknown[], onNavigate: (argv: string[]) => void = () => undefined) {
    return vi.fn(async (argv: string[]) => {
      if (argv.slice(1).join(" ") === "session list --json") {
        return { stdout: JSON.stringify({ sessions }), stderr: "", code: 0 };
      }
      if (argv[1] === "session" && argv[2] === "navigate") {
        onNavigate(argv);
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: `unexpected argv: ${argv.join(" ")}`, code: 1 };
    });
  }

  it("makes a Pi cwd below the repo root Hunk-repo-relative", async () => {
    const run = runner([session()], (argv) => {
      expect(argv).toEqual([
        "hunk",
        "session",
        "navigate",
        "s1",
        "--file",
        "packages/app/src/a.ts",
        "--hunk",
        "1",
      ]);
    });

    await navigateHunkSession({
      cwd: "/repo/packages/app",
      filePath: "src/a.ts",
      managedPid: 101,
      run,
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("selects the exact PID over a newer same-repo session", async () => {
    const run = runner(
      [
        session({ sessionId: "managed", pid: 123, launchedAt }),
        session({ sessionId: "newer", pid: 456, launchedAt: "2026-01-02T00:00:00.000Z" }),
      ],
      (argv) => expect(argv[3]).toBe("managed"),
    );

    await navigateHunkSession({ cwd: "/repo", filePath: "src/a.ts", managedPid: 123, run });
    expect(run).toHaveBeenNthCalledWith(2, [
      "hunk",
      "session",
      "navigate",
      "managed",
      "--file",
      "src/a.ts",
      "--hunk",
      "1",
    ]);
  });

  it("rejects same-repo sessions with a managed PID mismatch without navigating", async () => {
    const run = runner([
      session({ sessionId: "first", pid: 111 }),
      session({ sessionId: "second", pid: 222 }),
    ]);

    await expect(
      navigateHunkSession({ cwd: "/repo", filePath: "src/a.ts", managedPid: 999, run }),
    ).rejects.toThrow(/No live Hunk session found/);
    expect(run).toHaveBeenCalledTimes(1);

    const uniqueRun = runner([session({ sessionId: "only", pid: 111 })]);
    await expect(
      navigateHunkSession({ cwd: "/repo", filePath: "src/a.ts", managedPid: 999, run: uniqueRun }),
    ).rejects.toThrow(/No live Hunk session found/);
    expect(uniqueRun).toHaveBeenCalledTimes(1);
  });

  it("honors a pinned session id and passes it positionally", async () => {
    const run = runner(
      [session({ sessionId: "pinned", pid: 111 }), session({ sessionId: "exact-pid", pid: 222 })],
      (argv) => {
        expect(argv).toEqual([
          "hunk",
          "session",
          "navigate",
          "pinned",
          "--file",
          "src/a.ts",
          "--hunk",
          "3",
        ]);
      },
    );

    await navigateHunkSession({
      cwd: "/repo",
      filePath: "src/a.ts",
      hunk: 3,
      sessionId: "pinned",
      managedPid: 111,
      run,
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects targets outside the selected repo without navigating", async () => {
    const run = runner([session()]);

    await expect(
      navigateHunkSession({
        cwd: "/repo/packages/app",
        filePath: "../../../outside.ts",
        managedPid: 101,
        run,
      }),
    ).rejects.toThrow(/outside selected repository/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("uses cwd as the safe root for repoRoot-less exact-PID sessions", async () => {
    const run = runner(
      [
        session({
          sessionId: "repo-less",
          pid: 555,
          cwd: "/repo/packages/app",
          repoRoot: undefined,
        }),
      ],
      (argv) => {
        expect(argv).toEqual([
          "hunk",
          "session",
          "navigate",
          "repo-less",
          "--file",
          "src/a.ts",
          "--hunk",
          "1",
        ]);
      },
    );

    await navigateHunkSession({
      cwd: "/repo/packages/app",
      filePath: "src/a.ts",
      managedPid: 555,
      run,
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.runIf(process.platform !== "win32")(
    "canonicalizes an absolute missing target through a symlink against the adopted root",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-hunk-follow-absolute-symlink-"));
      const realRepo = join(root, "real-repo");
      const linkedRepo = join(root, "linked-repo");
      await mkdir(join(realRepo, "packages", "app"), { recursive: true });
      await symlink(realRepo, linkedRepo);
      try {
        const run = runner([session({ pid: 708, cwd: realRepo, repoRoot: realRepo })], (argv) =>
          expect(argv[5]).toBe("packages/app/src/missing.ts"),
        );
        await navigateHunkSession({
          cwd: realRepo,
          filePath: join(linkedRepo, "packages", "app", "src", "missing.ts"),
          managedPid: 708,
          run,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "canonicalizes a symlinked Pi cwd against Hunk's real repo root",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-hunk-follow-symlink-"));
      const realRepo = join(root, "real-repo");
      const linkedRepo = join(root, "linked-repo");
      await mkdir(join(realRepo, "packages", "app"), { recursive: true });
      await symlink(realRepo, linkedRepo);
      try {
        const run = runner([session({ pid: 707, cwd: realRepo, repoRoot: realRepo })], (argv) =>
          expect(argv[5]).toBe("packages/app/src/a.ts"),
        );
        await navigateHunkSession({
          cwd: join(linkedRepo, "packages", "app"),
          filePath: "src/a.ts",
          managedPid: 707,
          run,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects sibling worktree targets instead of navigating the selected worktree session",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-hunk-follow-worktree-"));
      const mainRepo = join(root, "main");
      const featureRepo = join(root, "feature");
      try {
        await mkdir(mainRepo, { recursive: true });
        await git(mainRepo, ["init"]);
        await git(mainRepo, ["config", "user.email", "pi-hunk@example.com"]);
        await git(mainRepo, ["config", "user.name", "pi-hunk"]);
        await writeFile(join(mainRepo, "README.md"), "main\n");
        await git(mainRepo, ["add", "README.md"]);
        await git(mainRepo, ["commit", "-m", "init"]);
        await git(mainRepo, ["worktree", "add", "-b", "feature", featureRepo]);
        await mkdir(join(featureRepo, "extensions", "overlay"), { recursive: true });
        await writeFile(join(featureRepo, "extensions", "overlay", "surface.ts"), "export {};\n");

        const run = runner([session({ pid: 909, cwd: mainRepo, repoRoot: mainRepo })]);

        await expect(
          navigateHunkSession({
            cwd: featureRepo,
            filePath: join(featureRepo, "extensions", "overlay", "surface.ts"),
            managedPid: 909,
            run,
          }),
        ).rejects.toThrow(/No live Hunk session found/);
        // The sibling worktree must not be treated as the exact-PID session's
        // repository or translated into a --file argument for the main worktree.
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        await execFileAsync("git", ["-C", mainRepo, "worktree", "remove", "--force", featureRepo], {
          encoding: "utf8",
          timeout: 10_000,
        }).catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "still rejects targets outside the selected repository and git worktree family",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pi-hunk-follow-outside-"));
      const mainRepo = join(root, "main");
      const otherRepo = join(root, "other");
      try {
        for (const repo of [mainRepo, otherRepo]) {
          await mkdir(repo, { recursive: true });
          await git(repo, ["init"]);
          await git(repo, ["config", "user.email", "pi-hunk@example.com"]);
          await git(repo, ["config", "user.name", "pi-hunk"]);
          await writeFile(join(repo, "README.md"), `${repo}\n`);
          await git(repo, ["add", "README.md"]);
          await git(repo, ["commit", "-m", "init"]);
        }
        await writeFile(join(otherRepo, "secret.ts"), "export {};\n");

        const run = runner([session({ pid: 910, cwd: mainRepo, repoRoot: mainRepo })]);
        await expect(
          navigateHunkSession({
            cwd: otherRepo,
            filePath: join(otherRepo, "secret.ts"),
            managedPid: 910,
            run,
          }),
        ).rejects.toThrow(/No live Hunk session found/);
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
