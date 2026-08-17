import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const releaseStateScript = fileURLToPath(new URL("../scripts/release-state.mjs", import.meta.url));
const canaryVersionScript = fileURLToPath(
  new URL("../scripts/prepare-canary-version.mjs", import.meta.url),
);
const releaseMetadataScript = fileURLToPath(
  new URL("../scripts/release-metadata.mjs", import.meta.url),
);

async function runReleaseStateFixture(options: {
  version: string;
  pendingChangeset: boolean;
  publishedVersions: string[];
}) {
  const root = await mkdtemp(join(tmpdir(), "pi-hunk-release-state-"));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name: "pi-hunk",
        versions: Object.fromEntries(
          options.publishedVersions.map((version) => [version, { name: "pi-hunk", version }]),
        ),
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test registry did not bind TCP.");

  try {
    await mkdir(join(root, ".changeset"));
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ name: "pi-hunk", version: options.version })}\n`,
    );
    await writeFile(join(root, ".changeset", "README.md"), "# Changesets\n");
    if (options.pendingChangeset) {
      await writeFile(join(root, ".changeset", "pending.md"), "pending\n");
    }

    const registry = `http://127.0.0.1:${address.port}`;
    const { stdout } = await execFileAsync(process.execPath, [releaseStateScript], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_OUTPUT: "",
        NPM_CONFIG_REGISTRY: registry,
      },
    });
    return { state: JSON.parse(stdout.trim()) as Record<string, string>, requests };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(root, { recursive: true, force: true });
  }
}

async function runCanaryFixture(options: {
  version: string;
  runNumber: string;
  runAttempt: string;
  selectedVersion?: string;
  writePackage: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "pi-hunk-canary-"));
  const outputPath = join(root, "github-output.txt");
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "pi-hunk", version: options.version }, null, 2)}\n`,
  );

  try {
    const args = [canaryVersionScript];
    if (options.writePackage) args.push("--write");
    if (options.selectedVersion !== undefined) args.push("--version", options.selectedVersion);
    const { stdout } = await execFileAsync(process.execPath, args, {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        GITHUB_RUN_NUMBER: options.runNumber,
        GITHUB_RUN_ATTEMPT: options.runAttempt,
      },
    });
    return {
      state: JSON.parse(stdout.trim()) as Record<string, string>,
      packageJson: JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
        name: string;
        version: string;
      },
      githubOutput: await readFile(outputPath, "utf8"),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("release pipeline invariants", () => {
  it("computes release state before Changesets mutates the version-job workspace", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    const stateStep = workflow.indexOf("- id: stable");
    const changesetsAction = workflow.indexOf("uses: changesets/action@");

    expect(stateStep).toBeGreaterThanOrEqual(0);
    expect(changesetsAction).toBeGreaterThanOrEqual(0);
    expect(stateStep).toBeLessThan(changesetsAction);
  });

  it("does not stage an unversioned commit with pending Changesets", async () => {
    const { state, requests } = await runReleaseStateFixture({
      version: "0.1.0",
      pendingChangeset: true,
      publishedVersions: ["0.1.0"],
    });

    expect(state).toEqual({
      should_stage: "false",
      reason: "pending-changesets",
      package: "pi-hunk",
      version: "0.1.0",
      stream: "stable",
      tag: "latest",
    });
    expect(requests).toEqual([]);
  });

  it("stages a versioned commit by checking one package packument", async () => {
    const { state, requests } = await runReleaseStateFixture({
      version: "0.2.0",
      pendingChangeset: false,
      publishedVersions: ["0.1.0"],
    });

    expect(state).toEqual({
      should_stage: "true",
      reason: "unpublished-version",
      package: "pi-hunk",
      version: "0.2.0",
      stream: "stable",
      tag: "latest",
    });
    expect(requests).toEqual(["/pi-hunk"]);
  });

  it("formats the generated changelog before refreshing the lockfile", async () => {
    const mise = await readFile(new URL("../mise.toml", import.meta.url), "utf8");
    const changesetVersion = mise.indexOf('"npm exec changeset version"');
    const changelogFormat = mise.indexOf('"npm exec oxfmt CHANGELOG.md"');
    const lockfileRefresh = mise.indexOf('"npm install --package-lock-only --ignore-scripts"');

    expect(changesetVersion).toBeGreaterThanOrEqual(0);
    expect(changelogFormat).toBeGreaterThan(changesetVersion);
    expect(lockfileRefresh).toBeGreaterThan(changelogFormat);
  });

  it("writes a unique rolling canary independent of the stable series", async () => {
    const result = await runCanaryFixture({
      version: "0.2.0",
      runNumber: "417",
      runAttempt: "2",
      writePackage: true,
    });

    expect(result.state).toEqual({
      should_stage: "true",
      reason: "canary",
      package: "pi-hunk",
      version: "0.0.0-canary.417.2",
      stream: "canary",
      tag: "canary",
    });
    expect(result.packageJson).toEqual({ name: "pi-hunk", version: "0.0.0-canary.417.2" });
    expect(result.githubOutput).toContain("version=0.0.0-canary.417.2\n");
    expect(result.githubOutput).toContain("tag=canary\n");
  });
  it("retains the version-job canary identity when failed jobs rerun", async () => {
    const result = await runCanaryFixture({
      version: "0.2.0",
      runNumber: "417",
      runAttempt: "2",
      selectedVersion: "0.0.0-canary.417.1",
      writePackage: true,
    });

    expect(result.state.version).toBe("0.0.0-canary.417.1");
    expect(result.packageJson.version).toBe("0.0.0-canary.417.1");
    expect(result.githubOutput).toContain("version=0.0.0-canary.417.1\n");
  });

  it("strictly validates a selected canary identity", async () => {
    await expect(
      runCanaryFixture({
        version: "0.2.0",
        runNumber: "418",
        runAttempt: "2",
        selectedVersion: "0.0.0-canary.419.1",
        writePackage: true,
      }),
    ).rejects.toThrow(/belongs to run 419, not current run 418/);

    await expect(
      runCanaryFixture({
        version: "0.2.0",
        runNumber: "418",
        runAttempt: "2",
        selectedVersion: "0.3.0-canary.418.1",
        writePackage: true,
      }),
    ).rejects.toThrow(/must match 0\.0\.0-canary/);
  });

  it("keeps a rolling canary preview read-only", async () => {
    const result = await runCanaryFixture({
      version: "0.3.0",
      runNumber: "418",
      runAttempt: "1",
      writePackage: false,
    });

    expect(result.state.version).toBe("0.0.0-canary.418.1");
    expect(result.packageJson.version).toBe("0.3.0");
  });

  it("refuses to route prereleases through stable staging or finalization", async () => {
    await expect(
      runReleaseStateFixture({
        version: "0.3.0-canary.1.1",
        pendingChangeset: false,
        publishedVersions: [],
      }),
    ).rejects.toThrow(/invalid stable package version/);

    const root = await mkdtemp(join(tmpdir(), "pi-hunk-stable-finalize-"));
    try {
      await writeFile(
        join(root, "package.json"),
        `${JSON.stringify({ name: "pi-hunk", version: "0.3.0" })}\n`,
      );
      await expect(
        execFileAsync(process.execPath, [releaseMetadataScript, "0.3.0-canary.1.1"], {
          cwd: root,
        }),
      ).rejects.toThrow(/expected a stable x\.y\.z version/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps stable and canary staging in the trusted publisher workflow", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    const plannerUses = workflow.match(/prepare-canary-version\.mjs/g) ?? [];

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain('test "$GITHUB_REF" = refs/heads/main');
    expect(plannerUses).toHaveLength(2);
    expect(workflow).not.toContain("CANARY_PLAN");
    expect(workflow).toContain("CANARY_VERSION: ${{ needs.version.outputs.version }}");
    expect(workflow).toContain('--write --version "$CANARY_VERSION"');
    expect(workflow).toContain('--tag "$RELEASE_TAG"');
    expect(workflow).toContain("stable:latest|canary:canary");
  });
});
