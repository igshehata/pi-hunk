import { execFile } from "node:child_process";
import type { Config, View } from "./contract.js";

/** Git's empty tree: the old side of a review that compares nothing to the whole codebase. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The Hunk arguments one view launches and reloads with. `branch` is given the merge-base SHA
 * its old side compares from; every caller resolves it before asking for that view.
 */
export function hunkArgs(view: View, base?: string): string[] {
  switch (view) {
    case "diff":
      return ["diff"];
    case "show":
      return ["show"];
    case "log":
      return ["log"];
    case "branch":
      if (base === undefined) throw new Error("The branch view needs a base commit");
      return ["diff", base];
    case "codebase":
      return ["diff", EMPTY_TREE];
  }
}

/** How resolving the base branch ended: a full merge-base SHA, or what to tell the user. */
export type BaseResolution =
  | { readonly _tag: "Found"; readonly base: string }
  | { readonly _tag: "Missing"; readonly message: string };

/** What a launch needs to know about the base branch: the SHA, or why the view cannot open. */
export type LaunchBase =
  | { readonly _tag: "Base"; readonly base?: string }
  | { readonly _tag: "Refused"; readonly message: string };

/** One git query in the reviewed repository; null when git cannot answer it. */
function gitQuery(cwd: string, args: readonly string[]): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  execFile(
    "git",
    args,
    { cwd, encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 },
    (error, stdout) => {
      if (error) return resolve(null);
      const output = stdout.trim();
      resolve(output.length > 0 ? output : null);
    },
  );
  return promise;
}

/** The commit a ref names, or null when the repository does not have that ref. */
async function commitOf(cwd: string, ref: string): Promise<string | null> {
  return await gitQuery(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
}

/**
 * The commit where this branch left its base branch, as a full SHA.
 *
 * The base is the configured branch when there is one, otherwise the remote's default branch and
 * then the two names every repository uses (`main`, `master`). Being on the base branch is not an
 * error: the merge-base is `HEAD`, and the branch view then shows the uncommitted work alone.
 *
 * Resolution is asynchronous because it runs on the launch path, once per review.
 */
export async function resolveBase(cwd: string, configured?: string): Promise<BaseResolution> {
  const tried: string[] = [];
  if (configured !== undefined) {
    tried.push(configured);
  } else {
    const remote = await gitQuery(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (remote !== null) tried.push(remote);
    tried.push("main", "master");
  }
  for (const ref of tried) {
    if ((await commitOf(cwd, ref)) === null) continue;
    const mergeBase = await gitQuery(cwd, ["merge-base", ref, "HEAD"]);
    if (mergeBase === null)
      return { _tag: "Missing", message: `${ref} shares no history with HEAD` };
    return { _tag: "Found", base: mergeBase };
  }
  return {
    _tag: "Missing",
    message: `no base branch: set "base" in /hunk config file (tried ${tried.join(", ")})`,
  };
}

/**
 * The base a launch carries. Every view gets one when it can be resolved, because the bridge
 * needs it to switch to the branch view inside Hunk; only the branch view refuses to open
 * without it.
 */
export async function launchBase(cwd: string, config: Config, view: View): Promise<LaunchBase> {
  const resolved = await resolveBase(cwd, config.base);
  if (resolved._tag === "Found") return { _tag: "Base", base: resolved.base };
  return view === "branch" ? { _tag: "Refused", message: resolved.message } : { _tag: "Base" };
}
