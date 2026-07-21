import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, DEFAULT_CONFIG, loadConfig } from "../extensions/config.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.PI_HUNK_CONFIG;
  delete process.env.PI_HUNK_REVIEW;
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function context(cwd: string, trusted = true) {
  return { cwd, isProjectTrusted: () => trusted } as any;
}

describe("config loading", () => {
  it("layers sparse global and trusted-project config", async () => {
    const root = await temporaryDirectory("hunk-config-");
    const globalPath = join(root, "global.json");
    process.env.PI_HUNK_CONFIG = globalPath;
    await writeFile(globalPath, JSON.stringify({ review: "live", bindings: { prefix: "ctrl+x" } }));
    await mkdir(join(root, ".pi"));
    await writeFile(
      join(root, ".pi", "hunk.json"),
      JSON.stringify({
        followEdits: false,
        overlay: { layout: "right", experimentalPiWrap: true },
      }),
    );

    const config = await loadConfig(context(root));
    expect(config.review).toBe("live");
    expect(config.followEdits).toBe(false);
    expect(config.overlay).toEqual({ layout: "right", experimentalPiWrap: true });
    expect(config.bindings.prefix).toBe("ctrl+x");
  });

  it("warns and falls back for invalid core settings and review overrides", async () => {
    const root = await temporaryDirectory("hunk-core-invalid-");
    const globalPath = join(root, "global.json");
    process.env.PI_HUNK_CONFIG = globalPath;
    process.env.PI_HUNK_REVIEW = "sometimes";
    await writeFile(
      globalPath,
      JSON.stringify({
        review: "sometimes",
        followEdits: "yes",
        hunk: { command: "  ", args: ["diff", 42] },
      }),
    );
    const warnings: string[] = [];

    const config = await loadConfig(context(root), (warning) => warnings.push(warning));

    expect(config.review).toBe("after-run");
    expect(config.followEdits).toBe(true);
    expect(config.hunk).toEqual({ command: "hunk", args: ["diff", "--watch"] });
    expect(warnings).toEqual([
      expect.stringContaining("invalid review"),
      expect.stringContaining("invalid followEdits"),
      expect.stringContaining("invalid hunk.command"),
      expect.stringContaining("invalid hunk.args"),
      expect.stringContaining("invalid PI_HUNK_REVIEW"),
    ]);
  });

  it("warns and rejects prefix/action binding collisions", async () => {
    const root = await temporaryDirectory("hunk-binding-collision-");
    const globalPath = join(root, "global.json");
    process.env.PI_HUNK_CONFIG = globalPath;
    await writeFile(
      globalPath,
      JSON.stringify({ bindings: { prefix: "ctrl+x", toggle: "ctrl+x", show: "s" } }),
    );
    const warnings: string[] = [];

    const config = await loadConfig(context(root), (warning) => warnings.push(warning));

    expect(config.bindings).toEqual(DEFAULT_CONFIG.bindings);
    expect(warnings).toEqual([expect.stringContaining("prefix, toggle, and show")]);
  });

  it("warns when a config file has a non-object root", async () => {
    const root = await temporaryDirectory("hunk-root-invalid-");
    const globalPath = join(root, "global.json");
    process.env.PI_HUNK_CONFIG = globalPath;
    await writeFile(globalPath, JSON.stringify(["not", "an", "object"]));
    const warnings: string[] = [];

    const config = await loadConfig(context(root), (warning) => warnings.push(warning));

    expect(config.review).toBe("after-run");
    expect(warnings).toEqual([expect.stringContaining("invalid Hunk config root")]);
  });

  it("warns and falls back for invalid named-layout settings", async () => {
    const root = await temporaryDirectory("hunk-overlay-invalid-");
    const globalPath = join(root, "global.json");
    process.env.PI_HUNK_CONFIG = globalPath;
    await writeFile(
      globalPath,
      JSON.stringify({
        overlay: { layout: "diagonal", experimentalPiWrap: "yes" },
      }),
    );
    const warnings: string[] = [];

    const config = await loadConfig(context(root), (warning) => warnings.push(warning));

    expect(config.overlay).toEqual({ layout: "right", experimentalPiWrap: true });
    expect(warnings).toEqual([
      expect.stringContaining("invalid overlay.layout"),
      expect.stringContaining("invalid overlay.experimentalPiWrap"),
    ]);
  });

  it("warns about ignored unknown top-level and nested keys", async () => {
    const root = await temporaryDirectory("hunk-unknown-config-");
    const globalPath = join(root, "global.json");
    process.env.PI_HUNK_CONFIG = globalPath;
    await writeFile(
      globalPath,
      JSON.stringify({ folowEdits: false, hunk: { command: "hunk", argz: [] } }),
    );
    const warnings: string[] = [];

    const config = await loadConfig(context(root), (warning) => warnings.push(warning));

    expect(config.followEdits).toBe(true);
    expect(warnings).toEqual([expect.stringContaining("folowEdits, hunk.argz")]);
  });

  it("ignores project config when the project is untrusted", async () => {
    const root = await temporaryDirectory("hunk-untrusted-");
    const globalPath = join(root, "global.json");
    process.env.PI_HUNK_CONFIG = globalPath;
    await writeFile(globalPath, JSON.stringify({ review: "live" }));
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi", "hunk.json"), JSON.stringify({ review: "off" }));

    expect((await loadConfig(context(root, false))).review).toBe("live");
  });

  it("persists sparse patches without deleting unknown old keys", async () => {
    const root = await temporaryDirectory("hunk-persist-");
    const globalPath = join(root, "global.json");
    process.env.PI_HUNK_CONFIG = globalPath;
    await writeFile(globalPath, JSON.stringify({ display: "split", overlay: { width: "80%" } }));
    const store = new ConfigStore();
    await store.reload(context(root));
    await store.persist(context(root), "global", { review: "off" });

    expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual({
      display: "split",
      overlay: { width: "80%" },
      review: "off",
    });
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
    if (process.platform !== "win32") {
      expect((await stat(globalPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects invalid JSON", async () => {
    const root = await temporaryDirectory("hunk-invalid-");
    const globalPath = join(root, "global.json");
    process.env.PI_HUNK_CONFIG = globalPath;
    await writeFile(globalPath, "{ not json");
    await expect(loadConfig(context(root))).rejects.toThrow("Invalid Hunk config");
  });
});
