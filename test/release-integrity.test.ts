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

describe("release pipeline invariants", () => {
  it("computes release state before Changesets mutates the version-job workspace", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    const stateStep = workflow.indexOf("- id: state");
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
});
