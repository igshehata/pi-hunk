import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStore, DEFAULT_CONFIG, globalConfigPath, loadConfig } from "../extensions/config.ts";

const temporaryDirectories: string[] = [];
const originalHome = process.env.HOME;

afterEach(async () => {
  delete process.env.PI_HUNK_CONFIG;
  delete process.env.PI_HUNK_REVIEW;
  delete process.env.PI_CODING_AGENT_DIR;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
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

function runNode(args: string[]): Promise<{ pid: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    const pid = child.pid;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && pid !== undefined) resolve({ pid, stderr });
      else reject(new Error(`Node child failed (${code ?? signal}): ${stderr}`));
    });
  });
}

describe("config loading", () => {
  it("loads sparse global config and ignores trusted project config", async () => {
    const root = await temporaryDirectory("hunk-config-");
    const globalPath = join(root, "global.json");
    const projectPath = join(root, ".pi", "hunk.json");
    process.env.PI_HUNK_CONFIG = globalPath;
    await writeFile(globalPath, JSON.stringify({ review: "live", bindings: { prefix: "ctrl+x" } }));
    await mkdir(join(root, ".pi"));
    await writeFile(
      projectPath,
      JSON.stringify({
        followEdits: false,
        overlay: { layout: "right" },
      }),
    );
    const warnings: string[] = [];

    const config = await loadConfig(context(root), (warning) => warnings.push(warning));

    expect(config.review).toBe("live");
    expect(config.followEdits).toBe(true);
    expect(config.overlay).toEqual({ layout: "full" });
    expect(config.bindings.prefix).toBe("ctrl+x");
    expect(warnings).toEqual([
      expect.stringContaining(`Ignoring project-local Hunk config at ${projectPath}`),
    ]);
  });

  it("uses Pi's configured global agent directory", async () => {
    const root = await temporaryDirectory("hunk-agent-dir-");
    delete process.env.PI_HUNK_CONFIG;
    process.env.PI_CODING_AGENT_DIR = root;

    expect(globalConfigPath()).toBe(join(root, "hunk.json"));

    const store = new ConfigStore();
    await store.persist(context(root, false), "global", { review: "live" });
    expect(JSON.parse(await readFile(join(root, "hunk.json"), "utf8"))).toEqual({
      review: "live",
    });
  });

  it("warns when a custom Pi agent directory leaves config at the legacy path", async () => {
    const root = await temporaryDirectory("hunk-legacy-agent-dir-");
    const fakeHome = join(root, "home");
    const legacyPath = join(fakeHome, ".pi", "agent", "hunk.json");
    const customAgentDir = join(root, "custom-agent");
    process.env.HOME = fakeHome;
    process.env.PI_CODING_AGENT_DIR = customAgentDir;
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, JSON.stringify({ review: "live" }));
    const warnings: string[] = [];

    const config = await loadConfig(context(root, false), (warning) => warnings.push(warning));

    expect(config.review).toBe("off");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Ignoring legacy Hunk config at");
    expect(warnings[0]).toContain("Pi's global agent directory");
  });

  it.skipIf(process.platform === "win32")(
    "does not warn when a custom agent directory aliases the legacy path",
    async () => {
      const root = await temporaryDirectory("hunk-aliased-agent-dir-");
      const fakeHome = join(root, "home");
      const legacyDirectory = join(fakeHome, ".pi", "agent");
      const customAgentDir = join(root, "custom-agent");
      process.env.HOME = fakeHome;
      process.env.PI_CODING_AGENT_DIR = customAgentDir;
      await mkdir(legacyDirectory, { recursive: true });
      await symlink(legacyDirectory, customAgentDir);
      await writeFile(join(legacyDirectory, "hunk.json"), JSON.stringify({ review: "live" }));
      const warnings: string[] = [];

      const config = await loadConfig(context(root, false), (warning) => warnings.push(warning));

      expect(config.review).toBe("live");
      expect(warnings).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "warns instead of aborting when the optional legacy path is a symlink loop",
    async () => {
      const root = await temporaryDirectory("hunk-looped-legacy-path-");
      const fakeHome = join(root, "home");
      const legacyPath = join(fakeHome, ".pi", "agent", "hunk.json");
      process.env.HOME = fakeHome;
      process.env.PI_CODING_AGENT_DIR = join(root, "custom-agent");
      await mkdir(dirname(legacyPath), { recursive: true });
      await symlink(legacyPath, legacyPath);
      const warnings: string[] = [];

      const config = await loadConfig(context(root, false), (warning) => warnings.push(warning));

      expect(config).toEqual(DEFAULT_CONFIG);
      expect(warnings).toEqual([
        expect.stringContaining(`Could not inspect legacy Hunk config at ${legacyPath}`),
      ]);
    },
  );

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

    expect(config.review).toBe("off");
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

  it("warns for invalid overlay and bindings containers", async () => {
    const root = await temporaryDirectory("hunk-container-invalid-");
    const globalPath = join(root, "global.json");
    process.env.PI_HUNK_CONFIG = globalPath;
    await writeFile(globalPath, JSON.stringify({ overlay: [], bindings: "ctrl+x" }));
    const warnings: string[] = [];

    const config = await loadConfig(context(root), (warning) => warnings.push(warning));

    expect(config.overlay).toEqual(DEFAULT_CONFIG.overlay);
    expect(config.bindings).toEqual(DEFAULT_CONFIG.bindings);
    expect(warnings).toEqual([
      expect.stringContaining("invalid bindings configuration"),
      expect.stringContaining("invalid overlay configuration"),
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

    expect(config.review).toBe("off");
    expect(warnings).toEqual([expect.stringContaining("invalid Hunk config root")]);
  });

  it("warns and falls back for invalid named-layout settings", async () => {
    const root = await temporaryDirectory("hunk-overlay-invalid-");
    const globalPath = join(root, "global.json");
    process.env.PI_HUNK_CONFIG = globalPath;
    await writeFile(
      globalPath,
      JSON.stringify({
        overlay: {
          layout: "diagonal",
        },
      }),
    );
    const warnings: string[] = [];

    const config = await loadConfig(context(root), (warning) => warnings.push(warning));

    expect(config.overlay).toEqual({
      layout: "full",
    });
    expect(warnings).toEqual([expect.stringContaining("invalid overlay.layout")]);
  });

  it("ignores removed wrap/exclusive/takeover overlay keys as unknown", async () => {
    const root = await temporaryDirectory("hunk-overlay-legacy-");
    const globalPath = join(root, "global.json");
    process.env.PI_HUNK_CONFIG = globalPath;
    await writeFile(
      globalPath,
      JSON.stringify({
        overlay: {
          layout: "right",
          experimentalPiWrap: true,
          experimentalExclusiveFrame: true,
          experimentalTakeover: true,
        },
      }),
    );
    const warnings: string[] = [];

    const config = await loadConfig(context(root), (warning) => warnings.push(warning));

    expect(config.overlay).toEqual({
      layout: "right",
    });
    expect(warnings).toEqual([
      expect.stringContaining(
        "overlay.experimentalPiWrap, overlay.experimentalExclusiveFrame, overlay.experimentalTakeover",
      ),
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

  it("ignores untrusted project config without reading or warning about it", async () => {
    const root = await temporaryDirectory("hunk-untrusted-");
    const globalPath = join(root, "global.json");
    process.env.PI_HUNK_CONFIG = globalPath;
    await writeFile(globalPath, JSON.stringify({ review: "live" }));
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi", "hunk.json"), JSON.stringify({ review: "off" }));
    const warnings: string[] = [];

    const config = await loadConfig(context(root, false), (warning) => warnings.push(warning));

    expect(config.review).toBe("live");
    expect(warnings).toEqual([]);
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

  it("serializes concurrent sparse updates from separate Pi sessions", async () => {
    const root = await temporaryDirectory("hunk-concurrent-persist-");
    const globalPath = join(root, "global.json");
    process.env.PI_HUNK_CONFIG = globalPath;
    const ctx = context(root, false);

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        new ConfigStore().persist(ctx, "global", { [`session-${index}`]: index }),
      ),
    );

    const persisted = JSON.parse(await readFile(globalPath, "utf8"));
    for (let index = 0; index < 12; index++) {
      expect(persisted[`session-${index}`]).toBe(index);
    }
    await expect(access(`${globalPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes separate processes racing to recover the same stale lock", async () => {
    const root = await temporaryDirectory("hunk-multiprocess-recovery-");
    const globalPath = join(root, "global.json");
    const worker = fileURLToPath(new URL("./fixtures/config-persist-worker.mjs", import.meta.url));
    const { pid } = await runNode(["-e", "void 0"]);
    await writeFile(
      `${globalPath}.lock`,
      JSON.stringify({ pid, token: "shared-stale-owner", createdAt: Date.now() - 1_000 }),
    );
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        runNode([worker, globalPath, `process-${index}`, JSON.stringify(index)]),
      ),
    );

    const persisted = JSON.parse(await readFile(globalPath, "utf8"));
    for (let index = 0; index < 8; index++) {
      expect(persisted[`process-${index}`]).toBe(index);
    }
    await expect(access(`${globalPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).filter((name) => name.includes(".lock.recovery-"))).toEqual([]);
  }, 15_000);

  it("recovers a stale owner-token lock after its process exits", async () => {
    const root = await temporaryDirectory("hunk-dead-owner-lock-");
    const globalPath = join(root, "global.json");
    process.env.PI_HUNK_CONFIG = globalPath;
    const { pid } = await runNode(["-e", "void 0"]);
    await writeFile(
      `${globalPath}.lock`,
      JSON.stringify({ pid, token: "dead-owner-token-for-test", createdAt: Date.now() - 1_000 }),
    );

    await new ConfigStore().persist(context(root, false), "global", { review: "live" });

    expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual({ review: "live" });
    await expect(access(`${globalPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans an orphaned recovery gate before acquiring a successor lock", async () => {
    const root = await temporaryDirectory("hunk-orphaned-recovery-");
    const globalPath = join(root, "global.json");
    const lockPath = `${globalPath}.lock`;
    process.env.PI_HUNK_CONFIG = globalPath;
    const { pid } = await runNode(["-e", "void 0"]);
    await writeFile(
      `${lockPath}.recovery-abandoned`,
      JSON.stringify({ pid, token: "dead-recovery-owner", createdAt: Date.now() - 1_000 }),
    );

    await new ConfigStore().persist(context(root, false), "global", { review: "after-run" });

    expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual({ review: "after-run" });
    expect((await readdir(root)).filter((name) => name.includes(".lock.recovery-"))).toEqual([]);
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers an aged malformed lock", async () => {
    const root = await temporaryDirectory("hunk-malformed-lock-");
    const globalPath = join(root, "global.json");
    const lockPath = `${globalPath}.lock`;
    process.env.PI_HUNK_CONFIG = globalPath;
    await writeFile(lockPath, "{ incomplete lock metadata");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    await new ConfigStore().persist(context(root, false), "global", { followEdits: false });

    expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual({ followEdits: false });
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a dead PID-only lock left by an older pi-hunk version", async () => {
    const root = await temporaryDirectory("hunk-legacy-dead-lock-");
    const globalPath = join(root, "global.json");
    process.env.PI_HUNK_CONFIG = globalPath;
    const { pid } = await runNode(["-e", "void 0"]);
    await writeFile(`${globalPath}.lock`, `${pid}\n`);

    await new ConfigStore().persist(context(root, false), "global", { review: "after-run" });

    expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual({ review: "after-run" });
    await expect(access(`${globalPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs malformed global JSON and restores built-in defaults cleanly", async () => {
    const root = await temporaryDirectory("hunk-malformed-global-");
    const globalPath = join(root, "global.json");
    process.env.PI_HUNK_CONFIG = globalPath;
    await writeFile(globalPath, "{ not json");
    const warnings: string[] = [];
    const store = new ConfigStore();

    await store.reload(context(root), (warning) => warnings.push(warning));

    expect(store.get()).toEqual(DEFAULT_CONFIG);
    expect(warnings).toEqual([
      expect.stringContaining(`Ignoring malformed Hunk config at ${globalPath}`),
    ]);

    await store.persist(context(root), "global", { overlay: { layout: "float" } });
    expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual({
      overlay: { layout: "float" },
    });
    expect(store.getLoaded()).toMatchObject({
      review: "off",
      followEdits: true,
      overlay: { layout: "float" },
    });

    await store.resetGlobal(context(root));
    await expect(readFile(globalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.getLoaded()).toEqual(DEFAULT_CONFIG);
  });

  it("clears prior session state even when the next session reload fails", async () => {
    const root = await temporaryDirectory("hunk-config-session-failure-");
    const globalPath = join(root, "global.json");
    process.env.PI_HUNK_CONFIG = globalPath;
    await writeFile(globalPath, JSON.stringify({ review: "live", followEdits: false }));
    const store = new ConfigStore();

    await store.startSession(context(root));
    store.patchSession({ review: "after-run", overlay: { layout: "float" } });
    expect(store.get()).toMatchObject({
      review: "after-run",
      followEdits: false,
      overlay: { layout: "float" },
    });

    await rm(globalPath);
    await mkdir(globalPath);
    await expect(store.startSession(context(root))).rejects.toThrow("Could not read Hunk config");

    expect(store.get()).toEqual(DEFAULT_CONFIG);
    expect(store.getLoaded()).toEqual(DEFAULT_CONFIG);
  });

  it("does not classify genuine config read failures as missing or malformed", async () => {
    const root = await temporaryDirectory("hunk-config-io-");
    process.env.PI_HUNK_CONFIG = root;
    const warnings: string[] = [];

    await expect(loadConfig(context(root), (warning) => warnings.push(warning))).rejects.toThrow(
      "Could not read Hunk config",
    );
    expect(warnings).toEqual([]);
  });
});
