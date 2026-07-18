import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface HunkExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Injectable command runner. The binary is argv[0]. */
export type HunkRunner = (argv: string[]) => Promise<HunkExecResult>;

export interface HunkExecOptions {
  cwd?: string;
  hunkBinary?: string;
  run?: HunkRunner;
}

export interface LiveHunkSession {
  sessionId: string;
  pid: number;
  cwd: string;
  repoRoot?: string;
  launchedAt: string;
}

export interface HunkSessionSelectionOptions {
  cwd: string;
  /** Pin selection to one Hunk session id. */
  sessionId?: string;
  /** OS pid of Pi's managed PTY leader, when available. */
  managedPid?: number;
}

export type HunkSessionLookupOptions = HunkSessionSelectionOptions & HunkExecOptions;

/**
 * Execute a bounded Hunk CLI operation without a shell. Session inspection is
 * used by the review handoff; navigation is used by follow-edits.
 */
export async function runHunk(argv: string[], options: HunkExecOptions = {}): Promise<string> {
  const binary = options.hunkBinary ?? "hunk";
  const description =
    argv
      .filter((arg) => !arg.startsWith("-"))
      .slice(0, 2)
      .join(" ") || binary;

  if (options.run) {
    const result = await options.run([binary, ...argv]);
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          result.stdout.trim() ||
          `hunk ${description} failed (${result.code})`,
      );
    }
    return result.stdout;
  }

  try {
    const { stdout } = await execFileAsync(binary, argv, {
      cwd: options.cwd,
      encoding: "utf8",
      timeout: 8_000,
      maxBuffer: 256 * 1024,
    });
    return stdout;
  } catch (error) {
    if (error && typeof error === "object" && "stderr" in error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
      const stdout = String((error as { stdout?: unknown }).stdout ?? "").trim();
      throw new Error(stderr || stdout || (error instanceof Error ? error.message : String(error)));
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export function parseLiveHunkSessions(value: unknown): LiveHunkSession[] {
  const sessions =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).sessions
      : undefined;
  if (!Array.isArray(sessions))
    throw new Error("Hunk session JSON drift: expected a sessions array.");
  const sessionIds = new Set<string>();
  return sessions.map((entry, index) => {
    if (!entry || typeof entry !== "object")
      throw new Error(`Hunk session JSON drift: sessions[${index}] must be an object.`);
    const { sessionId, pid, cwd, repoRoot, launchedAt } = entry as Record<string, unknown>;
    if (typeof sessionId !== "string" || sessionId.length === 0)
      throw new Error(`Hunk session JSON drift: sessions[${index}] requires non-empty sessionId.`);
    if (sessionIds.has(sessionId)) {
      throw new Error(
        `Hunk session JSON drift: sessions[${index}].sessionId duplicates ${JSON.stringify(sessionId)}.`,
      );
    }
    sessionIds.add(sessionId);
    if (!Number.isInteger(pid) || (pid as number) <= 0)
      throw new Error(
        `Hunk session JSON drift: sessions[${index}].pid must be a positive integer.`,
      );
    if (typeof cwd !== "string" || cwd.length === 0)
      throw new Error(`Hunk session JSON drift: sessions[${index}] requires non-empty cwd.`);
    if (repoRoot !== undefined && (typeof repoRoot !== "string" || repoRoot.length === 0))
      throw new Error(
        `Hunk session JSON drift: sessions[${index}].repoRoot must be a non-empty string when present.`,
      );
    if (
      typeof launchedAt !== "string" ||
      launchedAt.length === 0 ||
      !Number.isFinite(Date.parse(launchedAt))
    )
      throw new Error(
        `Hunk session JSON drift: sessions[${index}].launchedAt must be a valid timestamp string.`,
      );
    const parsed: LiveHunkSession = {
      sessionId,
      pid: pid as number,
      cwd,
      launchedAt,
    };
    if (repoRoot !== undefined) parsed.repoRoot = repoRoot as string;
    return parsed;
  });
}

export function selectLiveHunkSession(
  sessions: readonly LiveHunkSession[],
  options: HunkSessionSelectionOptions,
): LiveHunkSession | undefined {
  if (options.sessionId) return sessions.find((entry) => entry.sessionId === options.sessionId);

  const managedPid = normalizeManagedPid(options.managedPid);
  if (managedPid !== undefined) {
    const pidMatches = sessions.filter((entry) => entry.pid === managedPid);
    if (pidMatches.length > 1)
      throw new Error(
        `Hunk session JSON drift: multiple live sessions advertise pid ${managedPid}.`,
      );
    if (pidMatches.length === 1) return pidMatches[0];
  }

  const repoMatches = sessions.filter(
    (entry) => entry.repoRoot !== undefined && pathIsInside(options.cwd, entry.repoRoot),
  );
  if (repoMatches.length === 0) return undefined;
  if (repoMatches.length === 1) return repoMatches[0];

  throw new Error(
    `Ambiguous live Hunk sessions for repository ${options.cwd}${
      managedPid !== undefined ? `; no session has managed pid ${managedPid}` : ""
    }. Matching sessions: ${repoMatches.map(describeSession).join(", ")}.`,
  );
}

export async function listLiveHunkSessions(
  options: HunkExecOptions = {},
): Promise<LiveHunkSession[]> {
  return parseLiveHunkSessions(JSON.parse(await runHunk(["session", "list", "--json"], options)));
}

export async function findLiveHunkSession(
  options: HunkSessionLookupOptions,
): Promise<LiveHunkSession | undefined> {
  return selectLiveHunkSession(await listLiveHunkSessions(options), options);
}

function normalizeManagedPid(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

function pathIsInside(cwd: string, repoRoot: string): boolean {
  const child = relative(resolve(repoRoot), resolve(cwd));
  return child === "" || (!isParentRelative(child) && !isAbsolute(child));
}

function isParentRelative(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`);
}

function describeSession(session: LiveHunkSession): string {
  return `${session.sessionId} pid=${session.pid}${
    session.repoRoot ? ` repoRoot=${session.repoRoot}` : ` cwd=${session.cwd}`
  }`;
}

function noSessionMessage(options: HunkSessionSelectionOptions): string {
  if (options.sessionId) return `No live Hunk session found with id ${options.sessionId}.`;
  const managedPid = normalizeManagedPid(options.managedPid);
  return `No live Hunk session found for repository ${options.cwd}${
    managedPid !== undefined ? ` with managed pid ${managedPid}` : ""
  }.`;
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function toHunkRepoRelativePath(
  filePath: string,
  piCwd: string,
  session: LiveHunkSession,
): Promise<string> {
  const lexicalCwd = resolve(piCwd);
  const lexicalTarget = resolve(lexicalCwd, filePath);
  const repositoryRoot = await canonicalPath(resolve(session.repoRoot ?? session.cwd));
  const canonicalCwd = await canonicalPath(lexicalCwd);

  // The edited path may have been deleted, so realpath(target) can fail. When
  // it is lexically under Pi's cwd, map the same suffix through canonical cwd;
  // this preserves symlinked workspaces without requiring the target to exist.
  const cwdRelative = relative(lexicalCwd, lexicalTarget);
  const canonicalTarget = await canonicalPath(lexicalTarget);
  const target =
    canonicalTarget === lexicalTarget && !isParentRelative(cwdRelative) && !isAbsolute(cwdRelative)
      ? resolve(canonicalCwd, cwdRelative)
      : canonicalTarget;
  const repoRelative = relative(repositoryRoot, target);
  if (isParentRelative(repoRelative) || isAbsolute(repoRelative)) {
    throw new Error(
      `Cannot navigate Hunk session ${session.sessionId}: target ${target} is outside selected repository ${repositoryRoot}.`,
    );
  }
  return repoRelative || ".";
}

/** Steer the live review to a file. The hunk index is clamped to one or more. */
export async function navigateHunkSession(
  options: {
    filePath: string;
    hunk?: number;
  } & HunkSessionLookupOptions,
): Promise<void> {
  const session = await findLiveHunkSession(options);
  if (!session) throw new Error(noSessionMessage(options));

  const hunk = Math.max(1, options.hunk ?? 1);
  await runHunk(
    [
      "session",
      "navigate",
      session.sessionId,
      "--file",
      await toHunkRepoRelativePath(options.filePath, options.cwd, session),
      "--hunk",
      String(hunk),
    ],
    options,
  );
}
