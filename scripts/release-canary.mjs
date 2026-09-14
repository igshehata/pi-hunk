import { spawnSync } from "node:child_process";
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
const VERIFY_JOB = /^Verify pi-hunk@(0\.0\.0-canary\.[1-9]\d*\.[1-9]\d*)$/;
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

function requireCleanMatchingMain() {
  if (requireCommand("git", ["status", "--porcelain=v1"]) !== "") {
    fail("working tree is dirty; refusing to dispatch a different or unpublished revision");
  }
  const remotes = git(["remote"])
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!remotes.includes("origin")) fail("no origin remote");
  const head = git(["rev-parse", "HEAD"]);
  if (!SHA1.test(head)) fail(`HEAD is not a full SHA: ${head}`);
  const remoteLines = git(["ls-remote", "origin", "refs/heads/main"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (remoteLines.length !== 1) {
    fail(`expected exactly one origin refs/heads/main line, got ${remoteLines.length}`);
  }
  const [remoteSha, remoteRef] = remoteLines[0].split("\t");
  if (remoteRef !== "refs/heads/main" || !SHA1.test(remoteSha)) {
    fail(`origin/main is not a full SHA on refs/heads/main: ${remoteLines[0]}`);
  }
  if (head !== remoteSha) fail(`local HEAD ${head} does not match origin/main ${remoteSha}`);
  const originUrl = git(["config", "--get", "remote.origin.url"]);
  return { head, repo: githubRepoFromOrigin(originUrl) };
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
    if (run.status === "waiting" || run.status === "pending" || run.status === "action_required") {
      console.error(
        `GitHub environment protection is pending for npm-release on run ${runId}. Approve it in the GitHub UI. This command does not bypass protection.`,
      );
      if (run.url) console.error(run.url);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  fail(`timed out waiting for run ${runId} (status ${run?.status ?? "unknown"})`);
}

function requireSuccessfulCanaryRun(run, head, runId) {
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
  if (run.headBranch !== "main") fail(`run ${runId} branch is ${run.headBranch}, not main`);
  if (run.headSha !== head) fail(`run ${runId} headSha ${run.headSha} does not match ${head}`);
  if (run.workflowName !== "Release")
    fail(`run ${runId} workflow is ${run.workflowName}, not Release`);
  if (!Array.isArray(run.jobs)) fail(`run ${runId} jobs is not an array`);
}

function retainedCanaryVersion(run) {
  const verify = new Set();
  const stage = new Set();
  for (const job of run.jobs) {
    const verifyMatch = VERIFY_JOB.exec(job?.name ?? "");
    const stageMatch = STAGE_JOB.exec(job?.name ?? "");
    if (verifyMatch) verify.add(verifyMatch[1]);
    if (stageMatch) stage.add(stageMatch[1]);
  }
  if (verify.size !== 1 || stage.size !== 1) {
    fail(
      `could not read a unique retained canary version from Verify/Stage job names (verify=${[...verify].join(",") || "none"} stage=${[...stage].join(",") || "none"})`,
    );
  }
  const version = [...verify][0];
  if (version !== [...stage][0])
    fail(`Verify/Stage job versions disagree: ${version} vs ${[...stage][0]}`);
  const match = CANARY_VERSION.exec(version);
  if (String(run.number) !== match[1]) {
    fail(
      `retained version ${version} belongs to run ${match[1]}, not workflow run number ${run.number}`,
    );
  }
  if (Number(match[2]) > Number(run.attempt)) {
    fail(`retained version ${version} attempt is ahead of workflow attempt ${run.attempt}`);
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
  if (item.status != null && item.status !== "staged")
    fail(`${label} status is ${item.status}, not staged`);
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

async function main() {
  const args = process.argv.slice(2);
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
    else fail("usage: release-canary.mjs [--dry-run]");
  }
  const timeoutMs = integerEnv("RELEASE_CANARY_TIMEOUT_MS", 45 * 60 * 1000);
  const pollMs = integerEnv("RELEASE_CANARY_POLL_MS", 5000);
  const packageJson = parseJson(readFileSync(join(root, "package.json"), "utf8"), "package.json");
  if (packageJson.name !== "pi-hunk") fail("package name is not pi-hunk");
  const { head, repo } = requireCleanMatchingMain();

  if (dryRun) {
    console.error(`Canary release dry-run for ${repo} at ${head}`);
    console.error("would dispatch: gh workflow run release.yml --ref main --repo " + repo);
    console.error("would require the dispatch output's exact run id");
    console.error("would not approve, publish, tag, merge, or bypass npm-release");
    console.log(
      JSON.stringify({
        status: "dry-run",
        package: "pi-hunk",
        repo,
        commit: head,
        wouldDispatch: ["gh", "workflow", "run", "release.yml", "--ref", "main", "--repo", repo],
        remainingGates: [
          "GitHub environment npm-release",
          "npm stage approve <stage-id> (npm 2FA)",
        ],
      }),
    );
    return;
  }

  const dispatch = run("gh", ["workflow", "run", "release.yml", "--ref", "main", "--repo", repo]);
  if (dispatch.status !== 0) {
    const detail = `${dispatch.stderr || dispatch.stdout || ""}`.trim();
    fail(`workflow dispatch failed (${dispatch.status})${detail ? `: ${detail}` : ""}`);
  }
  const runId = parseDispatchRunId(dispatch.stdout, dispatch.stderr);
  console.error(`Dispatched Release workflow_dispatch run ${runId} on ${repo}`);
  const workflowRun = await waitForRun(repo, runId, head, timeoutMs, pollMs);
  requireSuccessfulCanaryRun(workflowRun, head, runId);
  const version = retainedCanaryVersion(workflowRun);
  const stage = selectStage(version);
  const shasum = inspectStage(repo, runId, stage, version);

  console.error(`pi-hunk@${version} is staged on npm tag canary from ${head}, not public.`);
  console.error(`Stage id: ${stage.id}`);
  if (workflowRun.url) console.error(`Run: ${workflowRun.url}`);
  console.error("Remaining approval gate (npm 2FA; this command does not run it):");
  console.error(`  npm stage approve ${stage.id}`);
  console.error("Canary releases do not get Git tags or GitHub Releases.");
  console.log(
    JSON.stringify({
      status: "staged",
      package: "pi-hunk",
      version,
      tag: "canary",
      stream: "canary",
      repo,
      commit: head,
      runId,
      runNumber: workflowRun.number,
      runAttempt: workflowRun.attempt,
      stageId: stage.id,
      shasum,
      runUrl: workflowRun.url ?? null,
      remainingGates: [`npm stage approve ${stage.id}`],
    }),
  );
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
