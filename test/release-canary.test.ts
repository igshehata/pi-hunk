import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Independent rerun: npx vitest run test/release-canary.test.ts
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repositoryRoot, "scripts/release-canary.mjs");
const STAGE_ID = "1de6f3db-2ed9-4d72-b3dd-8f0e2b474a2f";
const DECOY_STAGE_ID = "f8e7a45b-7a5f-4f31-8e6d-9dd1c6ef38c0";
const RUN_ID = "1001";
const VERSION = "0.0.0-canary.42.1";
const REPO = "igshehata/pi-hunk";

const GH_DOUBLE = `#!/usr/bin/env node
const { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const argv = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.RELEASE_CANARY_DOUBLE_STATE, "utf8"));
appendFileSync(process.env.RELEASE_CANARY_DOUBLE_LOG, JSON.stringify(["gh", ...argv]) + "\\n");
const repoIndex = argv.lastIndexOf("--repo");
if (repoIndex === -1 || argv[repoIndex + 1] !== state.repo) {
  console.error("gh --repo " + state.repo + " is required");
  process.exit(1);
}
const args = argv.filter((_, index) => index !== repoIndex && index !== repoIndex + 1);
function flag(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
if (args[0] === "workflow" && args[1] === "run") {
  if (args[2] !== "release.yml" || args[3] !== "--ref" || args[4] !== "main") {
    console.error("unexpected dispatch " + args.join(" "));
    process.exit(1);
  }
  state.dispatched = true;
  writeFileSync(process.env.RELEASE_CANARY_DOUBLE_STATE, JSON.stringify(state));
  process.stdout.write(state.dispatchStdout ?? "");
  process.stderr.write(state.dispatchStderr ?? "");
  process.exit(state.dispatchExit ?? 0);
}
if (args[0] === "run" && args[1] === "view") {
  const run = state.runs?.[args[2]];
  if (!run) {
    console.error("unknown run " + args[2]);
    process.exit(1);
  }
  if (Array.isArray(run.views)) {
    const index = Math.min(run.viewIndex ?? 0, run.views.length - 1);
    run.viewIndex = (run.viewIndex ?? 0) + 1;
    writeFileSync(process.env.RELEASE_CANARY_DOUBLE_STATE, JSON.stringify(state));
    process.stdout.write(JSON.stringify(run.views[index]) + "\\n");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify(run) + "\\n");
  process.exit(0);
}
if (args[0] === "run" && args[1] === "download") {
  const name = flag("--name");
  const dir = flag("--dir");
  const artifact = state.artifacts?.[args[2]]?.[name];
  if (!dir || !artifact) {
    console.error("missing artifact");
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  copyFileSync(artifact, join(dir, basename(artifact)));
  process.exit(0);
}
console.error("unexpected gh " + args.join(" "));
process.exit(1);
`;

const NPM_DOUBLE = `#!/usr/bin/env node
const { appendFileSync, copyFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.RELEASE_CANARY_DOUBLE_STATE, "utf8"));
appendFileSync(process.env.RELEASE_CANARY_DOUBLE_LOG, JSON.stringify(["npm", ...argv]) + "\\n");
if (argv[0] !== "stage") {
  console.error("unexpected npm " + argv.join(" "));
  process.exit(1);
}
if (argv[1] === "approve" || argv[1] === "reject" || argv[1] === "publish") {
  console.error("npm stage " + argv[1] + " is not allowed");
  process.exit(99);
}
if (argv[1] === "list") {
  process.stdout.write(JSON.stringify(state.stages ?? [], null, 2) + "\\n");
  process.exit(0);
}
if (argv[1] === "view") {
  const item = (state.stages ?? []).find((stage) => stage.id === argv[2]);
  if (!item) {
    console.error("unknown stage");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(item, null, 2) + "\\n");
  process.exit(0);
}
if (argv[1] === "download") {
  const item = (state.stages ?? []).find((stage) => stage.id === argv[2]);
  const tarball = state.stageTarballs?.[argv[2]];
  if (!item || !tarball) {
    console.error("unknown stage tarball");
    process.exit(1);
  }
  copyFileSync(tarball, join(process.cwd(), "pi-hunk-" + item.version + "-" + argv[2] + ".tgz"));
  process.exit(0);
}
console.error("unexpected npm " + argv.join(" "));
process.exit(1);
`;

interface Checkout {
  scratch: string;
  origin: string;
  local: string;
  bin: string;
  sha: string;
}

const fixtures: string[] = [];

afterEach(() => {
  for (const scratch of fixtures) rmSync(scratch, { recursive: true, force: true });
  fixtures.length = 0;
});

function hostCommand(name: string) {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${name}`], {
    encoding: "utf8",
    timeout: 5_000,
  });
  const resolved = result.stdout.trim();
  if (result.status !== 0 || !resolved) throw new Error(`missing ${name}`);
  return resolved;
}

const hostGit = hostCommand("git");
const hostTar = hostCommand("tar");

function git(cwd: string, args: string[]) {
  const result = spawnSync(hostGit, ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function writePackedTarball(dir: string, version: string, source = "export default 'verified';\n") {
  const packageDir = join(dir, "package");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "index.js"), source);
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify({ name: "pi-hunk", version }, null, 2)}\n`,
  );
  const tarball = join(dir, `pi-hunk-${version}.tgz`);
  const packed = spawnSync(hostTar, ["-czf", tarball, "-C", dir, "package"], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout);
  return {
    tarball,
    shasum: createHash("sha1").update(readFileSync(tarball)).digest("hex"),
  };
}

function createCheckout(): Checkout {
  const scratch = mkdtempSync(join(tmpdir(), "pi-hunk-canary-test-"));
  fixtures.push(scratch);
  const origin = join(scratch, "origin.git");
  const local = join(scratch, "local");
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  const gitInit = spawnSync(hostGit, ["init", "--bare", "-b", "main", origin], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (gitInit.status !== 0) throw new Error(gitInit.stderr || gitInit.stdout);
  const cloned = spawnSync(hostGit, ["clone", origin, local], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (cloned.status !== 0) throw new Error(cloned.stderr || cloned.stdout);
  git(local, ["config", "user.name", "test"]);
  git(local, ["config", "user.email", "test@example.com"]);
  git(local, ["config", "commit.gpgsign", "false"]);
  writeFileSync(
    join(local, "package.json"),
    `${JSON.stringify({ name: "pi-hunk", version: "1.0.0" })}\n`,
  );
  git(local, ["add", "package.json"]);
  git(local, ["commit", "-m", "init"]);
  git(local, ["push", "-u", "origin", "main"]);
  git(local, ["remote", "set-url", "origin", `git@github.com:${REPO}.git`]);
  git(local, ["config", `url.${origin}.insteadOf`, `git@github.com:${REPO}.git`]);
  writeFileSync(join(bin, "gh"), GH_DOUBLE);
  writeFileSync(join(bin, "npm"), NPM_DOUBLE);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "npm"), 0o755);
  symlinkSync(hostGit, join(bin, "git"));
  symlinkSync(hostTar, join(bin, "tar"));
  return {
    scratch,
    origin,
    local,
    bin,
    sha: git(local, ["rev-parse", "HEAD"]),
  };
}

function loggedCommands(logPath: string) {
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function isolatedEnv(checkout: Checkout, extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("HERDR_") ||
      key.startsWith("GH_") ||
      key.startsWith("npm_config_") ||
      key.startsWith("NPM_CONFIG_") ||
      key === "GITHUB_TOKEN"
    ) {
      delete env[key];
    }
  }
  return {
    ...env,
    PATH: `${checkout.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    COPYFILE_DISABLE: "1",
    RELEASE_CANARY_TIMEOUT_MS: "200",
    RELEASE_CANARY_POLL_MS: "20",
    ...extra,
  };
}

function runCanary(checkout: Checkout, state: Record<string, unknown>, args: string[] = []) {
  const statePath = join(checkout.scratch, "state.json");
  const logPath = join(checkout.scratch, "cli.log");
  writeFileSync(statePath, JSON.stringify({ repo: REPO, ...state }));
  writeFileSync(logPath, "");
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: checkout.local,
    encoding: "utf8",
    timeout: 12_000,
    env: isolatedEnv(checkout, {
      RELEASE_CANARY_DOUBLE_STATE: statePath,
      RELEASE_CANARY_DOUBLE_LOG: logPath,
    }),
  });
  const lastLine = (result.stdout ?? "").trim().split("\n").at(-1);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    log: loggedCommands(logPath),
    json: lastLine ? JSON.parse(lastLine) : null,
  };
}

function successfulRun(head: string) {
  return {
    attempt: 2,
    conclusion: "success",
    event: "workflow_dispatch",
    headBranch: "main",
    headSha: head,
    number: 42,
    status: "completed",
    url: `https://github.com/${REPO}/actions/runs/${RUN_ID}`,
    workflowName: "Release",
    jobs: [
      { name: "Version PR or release preflight", conclusion: "success", status: "completed" },
      { name: `Verify pi-hunk@${VERSION}`, conclusion: "success", status: "completed" },
      { name: `Stage pi-hunk@${VERSION}`, conclusion: "success", status: "completed" },
    ],
  };
}

function stagedItem(shasum: string, extra: Record<string, unknown> = {}) {
  return {
    id: STAGE_ID,
    packageName: "pi-hunk",
    version: VERSION,
    tag: "canary",
    createdAt: "2026-03-16T09:00:00.000Z",
    actor: "github-actions",
    actorType: "trusted automation",
    access: "public",
    shasum,
    status: "staged",
    ...extra,
  };
}

describe("release:canary", () => {
  it("refuses a dirty worktree without dispatching", () => {
    const checkout = createCheckout();
    writeFileSync(join(checkout.local, "dirty.txt"), "no\n");
    const result = runCanary(checkout, { dispatchStdout: "should-not-run\n" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("working tree is dirty");
    expect(result.log).toEqual([]);
  });

  it("refuses a local/remote SHA mismatch without dispatching", () => {
    const checkout = createCheckout();
    writeFileSync(join(checkout.local, "ahead.txt"), "no\n");
    git(checkout.local, ["add", "ahead.txt"]);
    git(checkout.local, ["commit", "-m", "ahead"]);
    const result = runCanary(checkout, { dispatchStdout: "should-not-run\n" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match origin/main");
    expect(result.log).toEqual([]);
  });

  it("dry-run checks git identity and does not dispatch", () => {
    const checkout = createCheckout();
    const result = runCanary(checkout, { dispatchStdout: "should-not-run\n" }, ["--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.json.status).toBe("dry-run");
    expect(result.json.commit).toBe(checkout.sha);
    expect(result.json.repo).toBe(REPO);
    expect(result.json.wouldDispatch).toEqual([
      "gh",
      "workflow",
      "run",
      "release.yml",
      "--ref",
      "main",
      "--repo",
      REPO,
    ]);
    expect(result.log).toEqual([]);
  });

  it("stages the retained canary identity and stops before npm approve", () => {
    const checkout = createCheckout();
    const packed = writePackedTarball(checkout.scratch, VERSION);
    const decoy = writePackedTarball(join(checkout.scratch, "decoy"), "0.0.0-canary.42.2");
    const result = runCanary(checkout, {
      dispatchStdout: `https://github.com/${REPO}/actions/runs/${RUN_ID}\n`,
      runs: { [RUN_ID]: successfulRun(checkout.sha) },
      stages: [
        stagedItem(packed.shasum),
        {
          id: DECOY_STAGE_ID,
          packageName: "pi-hunk",
          version: "0.0.0-canary.42.2",
          tag: "canary",
          shasum: decoy.shasum,
          status: "staged",
        },
      ],
      stageTarballs: { [STAGE_ID]: packed.tarball },
      artifacts: { [RUN_ID]: { [`npm-package-${VERSION}`]: packed.tarball } },
    });
    expect(result.status).toBe(0);
    expect(result.json).toMatchObject({
      status: "staged",
      version: VERSION,
      tag: "canary",
      commit: checkout.sha,
      runId: RUN_ID,
      runNumber: 42,
      runAttempt: 2,
      stageId: STAGE_ID,
      shasum: packed.shasum,
      remainingGates: [`npm stage approve ${STAGE_ID}`],
    });
    expect(result.stderr).toContain(`npm stage approve ${STAGE_ID}`);
    expect(result.log.some((argv) => argv[0] === "gh" && argv[1] === "workflow")).toBe(true);
    expect(result.log.some((argv) => argv.includes("--repo") && argv.includes(REPO))).toBe(true);
    expect(
      result.log.some((argv) => argv[0] === "gh" && argv[1] === "run" && argv[2] === "list"),
    ).toBe(false);
    expect(
      result.log.some((argv) => argv[0] === "npm" && argv[1] === "stage" && argv[2] === "approve"),
    ).toBe(false);
  });

  it("refuses when dispatch output has no run id", () => {
    const checkout = createCheckout();
    const result = runCanary(checkout, { dispatchStdout: "Created workflow_dispatch event\n" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not return a run id");
    expect(result.log.some((argv) => argv[1] === "run" && argv[2] === "view")).toBe(false);
  });

  it("refuses a successful-looking run on the wrong SHA", () => {
    const checkout = createCheckout();
    const packed = writePackedTarball(checkout.scratch, VERSION);
    const result = runCanary(checkout, {
      dispatchStdout: `https://github.com/${REPO}/actions/runs/${RUN_ID}\n`,
      runs: { [RUN_ID]: successfulRun("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") },
      stages: [stagedItem(packed.shasum)],
      stageTarballs: { [STAGE_ID]: packed.tarball },
      artifacts: { [RUN_ID]: { [`npm-package-${VERSION}`]: packed.tarball } },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("headSha");
    expect(result.log.some((argv) => argv[0] === "npm")).toBe(false);
  });

  it("refuses a failed workflow conclusion", () => {
    const checkout = createCheckout();
    const result = runCanary(checkout, {
      dispatchStdout: `https://github.com/${REPO}/actions/runs/${RUN_ID}\n`,
      runs: {
        [RUN_ID]: {
          ...successfulRun(checkout.sha),
          conclusion: "failure",
        },
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("conclusion is failure");
    expect(result.log.some((argv) => argv[0] === "npm")).toBe(false);
  });

  it("refuses a missing canary stage", () => {
    const checkout = createCheckout();
    const result = runCanary(checkout, {
      dispatchStdout: `https://github.com/${REPO}/actions/runs/${RUN_ID}\n`,
      runs: { [RUN_ID]: successfulRun(checkout.sha) },
      stages: [],
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`no npm stage for pi-hunk@${VERSION}`);
  });

  it("refuses a stage on the wrong tag", () => {
    const checkout = createCheckout();
    const packed = writePackedTarball(checkout.scratch, VERSION);
    const result = runCanary(checkout, {
      dispatchStdout: `https://github.com/${REPO}/actions/runs/${RUN_ID}\n`,
      runs: { [RUN_ID]: successfulRun(checkout.sha) },
      stages: [stagedItem(packed.shasum, { tag: "latest" })],
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no npm stage");
  });

  it("refuses ambiguous stages for the retained version", () => {
    const checkout = createCheckout();
    const packed = writePackedTarball(checkout.scratch, VERSION);
    const result = runCanary(checkout, {
      dispatchStdout: `https://github.com/${REPO}/actions/runs/${RUN_ID}\n`,
      runs: { [RUN_ID]: successfulRun(checkout.sha) },
      stages: [stagedItem(packed.shasum), stagedItem(packed.shasum, { id: DECOY_STAGE_ID })],
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ambiguous npm stages");
  });

  it("refuses a stage checksum that does not match the workflow artifact", () => {
    const checkout = createCheckout();
    const staged = writePackedTarball(checkout.scratch, VERSION);
    const artifact = writePackedTarball(
      join(checkout.scratch, "artifact"),
      VERSION,
      "export default 'different artifact';\n",
    );
    const result = runCanary(checkout, {
      dispatchStdout: `https://github.com/${REPO}/actions/runs/${RUN_ID}\n`,
      runs: { [RUN_ID]: successfulRun(checkout.sha) },
      stages: [stagedItem(staged.shasum)],
      stageTarballs: { [STAGE_ID]: staged.tarball },
      artifacts: { [RUN_ID]: { [`npm-package-${VERSION}`]: artifact.tarball } },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match staged tarball sha1");
  });

  it("surfaces the npm-release environment gate while waiting, then times out", () => {
    const checkout = createCheckout();
    const waiting = {
      attempt: 1,
      event: "workflow_dispatch",
      headBranch: "main",
      headSha: checkout.sha,
      number: 42,
      status: "waiting",
      url: `https://github.com/${REPO}/actions/runs/${RUN_ID}`,
      workflowName: "Release",
    };
    const result = runCanary(checkout, {
      dispatchStdout: `https://github.com/${REPO}/actions/runs/${RUN_ID}\n`,
      runs: { [RUN_ID]: { views: [waiting, waiting, waiting] } },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("npm-release");
    expect(result.stderr).toContain("does not bypass protection");
    expect(result.stderr).toContain("timed out");
  });
});
