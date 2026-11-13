import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const CANARY_VERSION = /^0\.0\.0-canary\.([1-9]\d*)\.([1-9]\d*)$/;
const RUN_ID_PATTERNS = [
  /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/(\d+)/g,
  /\bgh run view (\d+)\b/g,
];
const SHA1 = /^[0-9a-f]{40}$/;
const STAGE_JOB = /^Stage pi-hunk@(0\.0\.0-canary\.[1-9]\d*\.[1-9]\d*)$/;
const RUN_FIELDS =
  "attempt,conclusion,event,headBranch,headSha,jobs,number,status,url,workflowName";

function fail(message) {
  throw new Error(`canary release refused: ${message}`);
}

function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("HERDR_")) delete env[key];
  }
  return env;
}

function run(command, args, extra = {}) {
  return spawnSync(command, args, {
    cwd: extra.cwd ?? root,
    encoding: "utf8",
    env: childEnv(),
    ...extra,
  });
}

function requireCommand(command, args, extra = {}) {
  const result = run(command, args, extra);
  if (result.status !== 0) {
    const detail = `${result.stderr || result.stdout || ""}`.trim();
    fail(`${command} ${args.join(" ")} failed (${result.status})${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout ?? "";
}

function git(args) {
  return requireCommand("git", args).trim();
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${label} was not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function integerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (!/^[1-9]\d*$/.test(raw)) fail(`${name} must be a positive integer`);
  return Number(raw);
}

function githubRepoFromOrigin(url) {
  const raw = url.trim();
  const ssh = raw.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  let parsed;
  try {
    parsed = new URL(raw.replace(/^ssh:\/\/git@github\.com\//, "https://github.com/"));
  } catch {
    fail(`origin URL is not a GitHub repository: ${raw}`);
  }
  if (parsed.hostname !== "github.com") fail(`origin host is ${parsed.hostname}, not github.com`);
  const parts = parsed.pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "")
    .split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) fail(`origin URL is not owner/repo: ${raw}`);
  return `${parts[0]}/${parts[1]}`;
}

/** Canaries build `main` only: a clean `main` checkout whose HEAD is exactly what origin has. */
function requireCleanPushedMain() {
  if (requireCommand("git", ["status", "--porcelain=v1"]) !== "") {
    fail("working tree is dirty; refusing to dispatch a different or unpublished revision");
  }
  const remotes = git(["remote"])
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!remotes.includes("origin")) fail("no origin remote");
  const branchResult = run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = (branchResult.stdout ?? "").trim();
  if (branchResult.status !== 0 || branch === "") fail("HEAD is detached; check out main");
  if (branch !== "main") fail(`canaries build main only; check out main (HEAD is on ${branch})`);
  const head = git(["rev-parse", "HEAD"]);
  if (!SHA1.test(head)) fail(`HEAD is not a full SHA: ${head}`);
  const ref = `refs/heads/${branch}`;
  const remoteLines = git(["ls-remote", "origin", ref])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (remoteLines.length !== 1) {
    fail(`expected exactly one origin ${ref} line, got ${remoteLines.length}; push ${branch}`);
  }
  const [remoteSha, remoteRef] = remoteLines[0].split("\t");
  if (remoteRef !== ref || !SHA1.test(remoteSha)) {
    fail(`origin/${branch} is not a full SHA on ${ref}: ${remoteLines[0]}`);
  }
  if (head !== remoteSha) {
    fail(`local HEAD ${head} does not match origin/${branch} ${remoteSha}; push it first`);
  }
  const originUrl = git(["config", "--get", "remote.origin.url"]);
  return { branch, head, repo: githubRepoFromOrigin(originUrl) };
}

function parseDispatchRunId(stdout, stderr) {
  const text = `${stdout}\n${stderr}`;
  const ids = new Set();
  for (const pattern of RUN_ID_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) ids.add(match[1]);
  }
  if (ids.size > 1) fail(`workflow dispatch named multiple runs: ${[...ids].join(", ")}`);
  if (ids.size === 0) {
    fail("workflow dispatch did not return a run id; refusing to guess among concurrent runs");
  }
  return [...ids][0];
}

function gh(repo, args, extra = {}) {
  return requireCommand("gh", [...args, "--repo", repo], extra);
}

function viewRun(repo, runId) {
  const run = parseJson(gh(repo, ["run", "view", runId, "--json", RUN_FIELDS]), "gh run view");
  if (!run || typeof run !== "object" || Array.isArray(run))
    fail("gh run view did not return an object");
  return run;
}

async function waitForRun(repo, runId, head, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  let run;
  while (Date.now() < deadline) {
    run = viewRun(repo, runId);
    if (run.headSha != null && run.headSha !== head) {
      fail(`run ${runId} headSha ${run.headSha} does not match ${head}`);
    }
    if (run.status === "completed") return run;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  fail(`timed out waiting for run ${runId} (status ${run?.status ?? "unknown"})`);
}

function requireSuccessfulCanaryRun(run, head, branch, runId) {
  for (const field of [
    "attempt",
    "conclusion",
    "event",
    "headBranch",
    "headSha",
    "jobs",
    "number",
    "status",
    "workflowName",
  ]) {
    if (run[field] == null || run[field] === "") fail(`run ${runId} view is missing ${field}`);
  }
  if (run.status !== "completed") fail(`run ${runId} status is ${run.status}, not completed`);
  if (run.conclusion !== "success")
    fail(`run ${runId} conclusion is ${run.conclusion}, not success`);
  if (run.event !== "workflow_dispatch")
    fail(`run ${runId} event is ${run.event}, not workflow_dispatch`);
  if (run.headBranch !== branch) fail(`run ${runId} branch is ${run.headBranch}, not ${branch}`);
  if (run.headSha !== head) fail(`run ${runId} headSha ${run.headSha} does not match ${head}`);
  if (run.workflowName !== "Canary")
    fail(`run ${runId} workflow is ${run.workflowName}, not Canary`);
  if (!Array.isArray(run.jobs)) fail(`run ${runId} jobs is not an array`);
}

/** The version the stage job staged, named by that job; it must belong to this run. */
function stagedCanaryVersion(run, runId) {
  const staged = new Set();
  for (const job of run.jobs) {
    const match = STAGE_JOB.exec(job?.name ?? "");
    if (match) staged.add(match[1]);
  }
  if (staged.size !== 1) {
    fail(
      `could not read a unique canary version from Stage job names (${[...staged].join(",") || "none"})`,
    );
  }
  const version = [...staged][0];
  const match = CANARY_VERSION.exec(version);
  if (match[1] !== String(runId)) {
    fail(`staged version ${version} belongs to run ${match[1]}, not run ${runId}`);
  }
  if (Number(match[2]) > Number(run.attempt)) {
    fail(`staged version ${version} attempt is ahead of workflow attempt ${run.attempt}`);
  }
  const stageJob = run.jobs.find((job) => job.name === `Stage pi-hunk@${version}`);
  if (stageJob?.conclusion !== "success") {
    fail(`stage job conclusion is ${stageJob?.conclusion ?? "missing"}, not success`);
  }
  return version;
}

function requireStageIdentity(item, version, label) {
  if (!item || typeof item !== "object" || Array.isArray(item)) fail(`${label} is not an object`);
  if (!item.id) fail(`${label} is missing id`);
  if (item.packageName !== "pi-hunk")
    fail(`${label} packageName is ${item.packageName}, not pi-hunk`);
  if (item.version !== version) fail(`${label} version is ${item.version}, not ${version}`);
  if (item.tag !== "canary") fail(`${label} tag is ${item.tag}, not canary`);
  if (!SHA1.test(item.shasum ?? "")) fail(`${label} shasum is missing or not a SHA-1`);
  // npm scans a staged package before it can be approved; it reads `validating` until then.
  if (item.status != null && item.status !== "staged" && item.status !== "validating")
    fail(`${label} status is ${item.status}, not staged`);
}

/** Waits out npm's scan of the stage; approval is refused until it reads `staged`. */
async function waitForScan(stage, version, deadline, pollMs) {
  let current = stage;
  let announced = false;
  while (current.status === "validating") {
    if (Date.now() >= deadline) fail(`npm is still scanning stage ${stage.id}; try again later`);
    if (!announced) {
      console.error("npm is scanning the staged package; approval opens when it finishes.");
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    current = parseJson(
      requireCommand("npm", ["stage", "view", stage.id, "--json"]),
      "npm stage view",
    );
    requireStageIdentity(current, version, `npm stage view ${stage.id}`);
    if (current.shasum !== stage.shasum) fail(`stage ${stage.id} shasum changed while scanning`);
  }
  return current;
}

function selectStage(version) {
  const items = parseJson(
    requireCommand("npm", ["stage", "list", "pi-hunk", "--json"]),
    "npm stage list",
  );
  if (!Array.isArray(items)) fail("npm stage list did not return an array");
  const matches = items.filter(
    (item) =>
      item?.packageName === "pi-hunk" && item?.version === version && item?.tag === "canary",
  );
  if (matches.length === 0) fail(`no npm stage for pi-hunk@${version} on tag canary`);
  if (matches.length !== 1) {
    fail(
      `ambiguous npm stages for pi-hunk@${version} on tag canary: ${matches.map((item) => item.id).join(", ")}`,
    );
  }
  requireStageIdentity(matches[0], version, "npm stage list item");
  const viewed = parseJson(
    requireCommand("npm", ["stage", "view", matches[0].id, "--json"]),
    "npm stage view",
  );
  requireStageIdentity(viewed, version, `npm stage view ${matches[0].id}`);
  if (viewed.id !== matches[0].id)
    fail(`stage view id ${viewed.id} does not match list id ${matches[0].id}`);
  if (viewed.shasum !== matches[0].shasum)
    fail(`stage view shasum does not match list shasum for ${viewed.id}`);
  return viewed;
}

function tarballsIn(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...tarballsIn(path));
    else if (entry.isFile() && entry.name.endsWith(".tgz")) found.push(path);
  }
  return found;
}

function requireOneTarball(dir, label) {
  const tarballs = tarballsIn(dir);
  if (tarballs.length !== 1) fail(`${label} produced ${tarballs.length} tarballs, not exactly one`);
  return tarballs[0];
}

function sha1File(path) {
  return createHash("sha1").update(readFileSync(path)).digest("hex");
}

function inspectStage(repo, runId, stage, version) {
  const scratch = mkdtempSync(join(tmpdir(), "pi-hunk-canary-stage-"));
  try {
    requireCommand("npm", ["stage", "download", stage.id], { cwd: scratch });
    const stagedTarball = requireOneTarball(scratch, "npm stage download");
    const stagedSha1 = sha1File(stagedTarball);
    if (stagedSha1 !== stage.shasum) {
      fail(
        `downloaded stage ${stage.id} sha1 ${stagedSha1} does not match stage shasum ${stage.shasum}`,
      );
    }
    const manifest = parseJson(
      requireCommand("tar", ["-xOf", stagedTarball, "package/package.json"]),
      "staged package/package.json",
    );
    if (manifest.name !== "pi-hunk")
      fail(`staged tarball package name is ${manifest.name}, not pi-hunk`);
    if (manifest.version !== version)
      fail(`staged tarball version is ${manifest.version}, not ${version}`);

    const artifacts = mkdtempSync(join(scratch, "artifact-"));
    gh(repo, ["run", "download", runId, "--name", `npm-package-${version}`, "--dir", artifacts]);
    const artifactSha1 = sha1File(requireOneTarball(artifacts, "gh run download"));
    if (artifactSha1 !== stagedSha1) {
      fail(
        `workflow artifact sha1 ${artifactSha1} does not match staged tarball sha1 ${stagedSha1}`,
      );
    }
    return stagedSha1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Asks on the terminal; anything but y/yes declines. */
async function confirm(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
    else fail("usage: release-canary.mjs [--dry-run]");
  }
  const timeoutMs = integerEnv("RELEASE_CANARY_TIMEOUT_MS", 20 * 60 * 1000);
  const pollMs = integerEnv("RELEASE_CANARY_POLL_MS", 5000);
  const packageJson = parseJson(readFileSync(join(root, "package.json"), "utf8"), "package.json");
  if (packageJson.name !== "pi-hunk") fail("package name is not pi-hunk");
  const { branch, head, repo } = requireCleanPushedMain();
  const dispatchArgs = ["workflow", "run", "canary.yml", "--ref", branch, "--repo", repo];

  if (dryRun) {
    console.error(`Canary release dry-run for ${repo} ${branch} at ${head}`);
    console.error(`would dispatch: gh ${dispatchArgs.join(" ")}`);
    console.error("would require the dispatch output's exact run id");
    console.error("would ask before running npm stage approve (npm 2FA)");
    console.log(
      JSON.stringify({
        status: "dry-run",
        package: "pi-hunk",
        repo,
        branch,
        commit: head,
        wouldDispatch: ["gh", ...dispatchArgs],
        remainingGates: ["npm stage approve <stage-id> (npm 2FA)"],
      }),
    );
    return;
  }

  const dispatch = run("gh", dispatchArgs);
  if (dispatch.status !== 0) {
    const detail = `${dispatch.stderr || dispatch.stdout || ""}`.trim();
    fail(`workflow dispatch failed (${dispatch.status})${detail ? `: ${detail}` : ""}`);
  }
  const runId = parseDispatchRunId(dispatch.stdout, dispatch.stderr);
  console.error(`Dispatched Canary run ${runId} on ${repo} ${branch}; waiting for it to stage.`);
  const workflowRun = await waitForRun(repo, runId, head, timeoutMs, pollMs);
  requireSuccessfulCanaryRun(workflowRun, head, branch, runId);
  const version = stagedCanaryVersion(workflowRun, runId);
  const stage = selectStage(version);
  const shasum = inspectStage(repo, runId, stage, version);

  console.error(`pi-hunk@${version} is staged on npm tag canary from ${branch} ${head}.`);
  console.error(`Stage id: ${stage.id}`);
  if (workflowRun.url) console.error(`Run: ${workflowRun.url}`);
  const result = {
    package: "pi-hunk",
    version,
    tag: "canary",
    repo,
    branch,
    commit: head,
    runId,
    runAttempt: workflowRun.attempt,
    stageId: stage.id,
    shasum,
    runUrl: workflowRun.url ?? null,
  };

  // Publishing is the maintainer's own npm 2FA, asked for on their terminal. Without one there is
  // nobody to ask, so the stage is left for `npm stage approve`.
  const interactive = process.stdin.isTTY && process.stderr.isTTY;
  if (interactive && (await confirm(`Publish pi-hunk@${version} to npm tag canary? [y/N] `))) {
    await waitForScan(stage, version, Date.now() + timeoutMs, pollMs);
    const approve = spawnSync("npm", ["stage", "approve", stage.id], {
      cwd: root,
      env: childEnv(),
      stdio: "inherit",
    });
    if (approve.status === 0) {
      console.error(`Published pi-hunk@${version}. Install it with:`);
      console.error(`  omp plugin install pi-hunk@${version} --force`);
      console.error(`  pi install npm:pi-hunk@${version}`);
      console.log(JSON.stringify({ status: "published", ...result }));
      return;
    }
    console.error("npm stage approve did not publish it.");
  }
  console.error("Publish it with npm 2FA when ready:");
  console.error(`  npm stage approve ${stage.id}`);
  console.log(
    JSON.stringify({
      status: "staged",
      ...result,
      remainingGates: [`npm stage approve ${stage.id}`],
    }),
  );
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
