import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function invalidPath(message: string): Error {
  return new Error(`Invalid Hunk review target: ${message}`);
}

/** Resolve an untrusted path value lexically without ever passing it through a shell. */
export function normalizeCandidatePath(value: string, baseCwd: string): string {
  if (typeof value !== "string") throw invalidPath("expected a string path.");
  const trimmed = value.trim();
  if (!trimmed) throw invalidPath("the path must not be empty.");
  if (trimmed.includes("\0")) throw invalidPath("NUL bytes are not allowed.");
  return resolve(baseCwd, trimmed);
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" ||
      (error as { code?: unknown }).code === "ENOTDIR")
  );
}

async function pathKind(path: string): Promise<"directory" | "other" | "missing"> {
  try {
    return (await stat(path)).isDirectory() ? "directory" : "other";
  } catch (error) {
    if (isMissingPathError(error)) return "missing";
    throw error;
  }
}

/**
 * Turn a file-or-directory candidate into an existing, canonical child-process
 * cwd. Missing/deleted targets walk upward; this deliberately does not detect a
 * repository root because Hunk owns VCS discovery.
 */
export async function resolveLaunchDirectory(value: string, baseCwd?: string): Promise<string> {
  const target = baseCwd === undefined ? resolve(value) : normalizeCandidatePath(value, baseCwd);
  const kind = await pathKind(target);
  let candidate = kind === "directory" ? target : dirname(target);

  while ((await pathKind(candidate)) !== "directory") {
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw invalidPath(`no existing parent directory was found for ${JSON.stringify(target)}.`);
    }
    candidate = parent;
  }

  try {
    return await realpath(candidate);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    // A concurrent deletion can race the stat above. Retry from the parent
    // rather than returning a child cwd that no longer exists.
    const parent = dirname(candidate);
    if (parent === candidate) throw error;
    return resolveLaunchDirectory(parent);
  }
}

/**
 * Canonicalize as much of a possibly missing path as the filesystem permits.
 * The unresolved suffix is then reapplied lexically through the nearest real
 * ancestor, which keeps deleted targets and symlinked workspaces comparable.
 */
export async function canonicalizePotentialPath(value: string): Promise<string> {
  const target = resolve(value);
  let ancestor = target;

  for (;;) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      const suffix = relative(ancestor, target);
      return suffix ? resolve(canonicalAncestor, suffix) : canonicalAncestor;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) return target;
      ancestor = parent;
    }
  }
}

/** Boundary-aware containment for already-normalized absolute paths. */
export function pathIsInside(target: string, root: string): boolean {
  const child = relative(resolve(root), resolve(target));
  return child === "" || (!isParentRelative(child) && !isAbsolute(child));
}

/** Canonical, symlink-aware containment that also supports missing targets. */
export async function canonicalPathIsInside(target: string, root: string): Promise<boolean> {
  const [canonicalTarget, canonicalRoot] = await Promise.all([
    canonicalizePotentialPath(target),
    canonicalizePotentialPath(root),
  ]);
  return pathIsInside(canonicalTarget, canonicalRoot);
}

function isParentRelative(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`);
}
