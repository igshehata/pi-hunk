#!/usr/bin/env node
/**
 * Black-box acceptance coverage for pi-hunk on real Pi and OMP hosts.
 * Requires HERDR_ENV=1. Every host gets its own staged Git fixture, global
 * config path, foreground agent process, and visible Chrome tab.
 *
 *   node scripts/e2e-herdr.mjs [pi|omp] [--no-build]
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOSTS = {
  pi: { kind: "pi", name: "hunkpi" },
  omp: { kind: "omp", name: "hunkomp" },
};
const DEFAULT_HOTKEYS = Object.freeze({
  prefix: "ctrl+space",
  diff: "h",
  show: "s",
  stash: "t",
});
const CUSTOM_HOTKEY_STAGES = Object.freeze([
  {
    field: "prefix",
    hotkeys: { prefix: "ctrl+shift+h", diff: "h", show: "s", stash: "t" },
    mode: "diff",
  },
  {
    field: "diff",
    hotkeys: { prefix: "ctrl+shift+h", diff: "d", show: "s", stash: "t" },
    mode: "diff",
  },
  {
    field: "show",
    hotkeys: { prefix: "ctrl+shift+h", diff: "d", show: "w", stash: "t" },
    mode: "show",
  },
  {
    field: "stash",
    hotkeys: { prefix: "ctrl+shift+h", diff: "d", show: "w", stash: "x" },
    mode: "stash",
  },
]);
const DEFAULT_MODES = Object.freeze({
  diff: { args: ["diff", "HEAD", "--watch"], marker: "staged-only.txt" },
  show: { args: ["show", "HEAD"], marker: "show-head.txt" },
  stash: { args: ["stash", "show"], marker: "stash-default.txt" },
});
const MODE_NAMES = Object.freeze(["diff", "show", "stash"]);
const CROSS_MODE_SWITCHES = Object.freeze([
  ["diff", "show"],
  ["diff", "stash"],
  ["show", "diff"],
  ["show", "stash"],
  ["stash", "diff"],
  ["stash", "show"],
]);
const HUNK_CHROME = /File\s+View\s+Navigate/;
const EMPTY_FILTER = /No files match the current filter/i;
const COMMENT_EDITOR = /Draft note|comment/i;
const COMMENT_SAVE_HINT = /(?:ctrl|control).?s|save/i;
const USAGE_ERROR =
  /(?:usage:.*\/hunk|unknown.*(?:command|subcommand)|invalid.*(?:argument|command|usage)|expected.*(?:argument|one of)|too many arguments)/gi;
const SCENARIO_FILTER = process.env.PI_HUNK_E2E_FILTER
  ? new RegExp(process.env.PI_HUNK_E2E_FILTER, "i")
  : undefined;
const SHELL_NAMES = new Set(["zsh", "bash", "fish", "sh"]);

class FatalProbeError extends Error {}

function fail(message) {
  throw new Error(message);
}

function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
  });
  if (result.status !== 0) {
    fail(
      `${bin} ${args.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  return result.stdout;
}

function herdr(args) {
  const stdout = run("herdr", args).trim();
  if (!stdout) return {};
  if (stdout.startsWith("{") || stdout.startsWith("[")) return JSON.parse(stdout);
  fail(`herdr ${args.join(" ")} returned non-JSON: ${stdout.slice(0, 240)}`);
}

function git(args, cwd) {
  run("git", args, { cwd });
}

function processArgv(proc) {
  if (Array.isArray(proc.argv)) return proc.argv.map(String);
  const argv0 = typeof proc.argv0 === "string" ? proc.argv0 : "";
  return argv0 ? [argv0] : [];
}

function isHunkProcess(proc) {
  if (proc.name === "hunk") return true;
  const argv0 = processArgv(proc)[0] ?? "";
  return argv0 !== "" && basename(argv0) === "hunk";
}

function isHostProcess(proc) {
  if (proc.name === "omp" || proc.name === "pi") return true;
  return processArgv(proc).some((argument) => {
    const executable = basename(argument);
    return (
      executable === "omp" ||
      executable === "pi" ||
      (executable === "cli.js" && argument.includes("/pi-coding-agent/"))
    );
  });
}

function foregroundProcesses(paneId) {
  const payload = herdr(["pane", "process-info", "--pane", paneId]);
  return payload.result?.process_info?.foreground_processes ?? [];
}

function hunkProcess(paneId) {
  return foregroundProcesses(paneId).find(isHunkProcess) ?? null;
}

function paneHasHunk(paneId) {
  return hunkProcess(paneId) !== null;
}

function paneIsShell(paneId) {
  return foregroundProcesses(paneId).some((proc) => SHELL_NAMES.has(proc.name ?? ""));
}

function paneHasHost(paneId) {
  return foregroundProcesses(paneId).some(isHostProcess);
}

function paneVisible(paneId) {
  try {
    return run("herdr", ["pane", "read", paneId, "--source", "visible", "--lines", "80"]);
  } catch (error) {
    return `(visible read failed: ${error instanceof Error ? error.message : String(error)})`;
  }
}

function paneRecent(paneId) {
  try {
    return run("herdr", ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "160"]);
  } catch (error) {
    return `(recent read failed: ${error instanceof Error ? error.message : String(error)})`;
  }
}

function hunkChromeVisible(paneId) {
  return HUNK_CHROME.test(paneVisible(paneId));
}

function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-hunk-e2e-repo-"));
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "e2e@pi-hunk.test"], dir);
  git(["config", "user.name", "pi-hunk e2e"], dir);
  git(["config", "commit.gpgsign", "false"], dir);

  writeFileSync(join(dir, "base.txt"), "base fixture\n");
  git(["add", "base.txt"], dir);
  git(["commit", "-m", "base fixture"], dir);

  writeFileSync(join(dir, "show-head.txt"), "visible in show HEAD\n");
  writeFileSync(join(dir, "stash-explicit.txt"), "tracked stash fixture\n");
  writeFileSync(join(dir, "stash-default.txt"), "tracked stash fixture\n");
  git(["add", "show-head.txt", "stash-explicit.txt", "stash-default.txt"], dir);
  git(["commit", "-m", "show fixture"], dir);

  writeFileSync(join(dir, "stash-explicit.txt"), "tracked stash fixture\nvisible in stash@{1}\n");
  git(["stash", "push", "-m", "explicit stash fixture", "--", "stash-explicit.txt"], dir);
  writeFileSync(
    join(dir, "stash-default.txt"),
    "tracked stash fixture\nvisible in default stash\n",
  );
  git(["stash", "push", "-m", "default stash fixture", "--", "stash-default.txt"], dir);

  writeFileSync(join(dir, "staged-only.txt"), "visible in staged-only diff\n");
  git(["add", "staged-only.txt"], dir);
  return realpathSync(dir);
}

function writeHotkeys(configPath, hotkeys) {
  writeFileSync(configPath, `${JSON.stringify({ hotkeys }, null, 2)}\n`);
}

function createIsolatedConfig() {
  const dir = mkdtempSync(join(tmpdir(), "pi-hunk-e2e-config-"));
  const path = join(dir, "hunk.json");
  writeHotkeys(path, DEFAULT_HOTKEYS);
  return path;
}

function readConfig(configPath) {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function configMatches(configPath, hotkeys) {
  try {
    const config = readConfig(configPath);
    if (!config || typeof config !== "object" || Array.isArray(config)) return false;
    if (Object.keys(config).length !== 1 || !config.hotkeys || typeof config.hotkeys !== "object") {
      return false;
    }
    const expectedKeys = Object.keys(hotkeys).sort();
    const actualKeys = Object.keys(config.hotkeys).sort();
    return (
      actualKeys.length === expectedKeys.length &&
      actualKeys.every((key, index) => key === expectedKeys[index]) &&
      expectedKeys.every((key) => config.hotkeys[key] === hotkeys[key])
    );
  } catch {
    return false;
  }
}
function jsonlOccurrences(root, text) {
  let occurrences = 0;
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          occurrences += readFileSync(path, "utf8").split(text).length - 1;
        } catch {
          // The OMP process may be appending this JSONL while it is observed.
        }
      }
    }
  };
  visit(root);
  return occurrences;
}
function commentIdContaining(value, text) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = commentIdContaining(item, text);
      if (id) return id;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const ownsText = Object.values(value).some(
    (field) => typeof field === "string" && field.includes(text),
  );
  if (ownsText) {
    const id = value.noteId ?? value.comment_id ?? value.commentId ?? value.id ?? value.uuid;
    if (id !== undefined && id !== null) return String(id);
  }
  for (const child of Object.values(value)) {
    const id = commentIdContaining(child, text);
    if (id) return id;
  }
  return null;
}

async function waitUntil(label, timeoutMs, probe) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      if (error instanceof FatalProbeError) throw error;
      lastError = error;
    }
    await delay(200);
  }
  const suffix = lastError
    ? `; last probe error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    : "";
  fail(`${label} timed out after ${timeoutMs}ms${suffix}`);
}

function invocationArgs(proc) {
  const argv = processArgv(proc);
  return argv.length > 0 ? argv.slice(1) : [];
}

function argsEqual(actual, expected) {
  if (actual.length < expected.length || !expected.every((arg, index) => actual[index] === arg)) {
    return false;
  }
  const trailing = actual.slice(expected.length);
  return (
    trailing.length === 0 ||
    (trailing.length === 2 && trailing[0] === "--extension" && trailing[1].length > 0)
  );
}

async function runHost(host) {
  const spec = HOSTS[host];
  if (!spec) fail(`unknown host ${host}; expected pi or omp`);
  if (process.env.HERDR_ENV !== "1") fail("HERDR_ENV=1 is required (run inside a Herdr pane)");
  const workspace = process.env.HERDR_WORKSPACE_ID;
  if (!workspace) fail("HERDR_WORKSPACE_ID is missing");


  const fixture = createFixture();
  const configPath = createIsolatedConfig();
  const sessionDir =
    host === "omp" ? mkdtempSync(join(tmpdir(), "pi-hunk-e2e-omp-sessions-")) : null;
  const ompHome = host === "omp" ? mkdtempSync(join(tmpdir(), "pi-hunk-e2e-omp-home-")) : null;
  const ompAgentDir = ompHome ? join(ompHome, ".omp", "agent") : null;
  const paneEnvironment = {
    PI_HUNK_CONFIG: configPath,
    ...(ompHome && ompAgentDir
      ? {
          HOME: ompHome,
          PI_CODING_AGENT_DIR: ompAgentDir,
          OPENAI_API_KEY: "pi-hunk-e2e-no-requests",
          PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        }
      : {}),
  };
  if (ompAgentDir) {
    mkdirSync(ompAgentDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(ompAgentDir, "config.yml"),
      "setupVersion: 2\nmodelRoles:\n  default: openai/gpt-5.2\n",
      { encoding: "utf8", mode: 0o600 },
    );
    writeFileSync(
      join(ompHome, ".zshenv"),
      "export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin\n",
      { encoding: "utf8", mode: 0o600 },
    );
  }
  if (ompHome) {
    run("omp", ["plugin", "link", ROOT], {
      cwd: fixture,
      env: { ...process.env, ...paneEnvironment },
    });
    const linkedPackage = join(ompHome, ".omp", "plugins", "node_modules", "pi-hunk");
    if (!existsSync(linkedPackage) || realpathSync(linkedPackage) !== ROOT) {
      fail(`isolated OMP plugin did not link this checkout at ${linkedPackage}`);
    }
  }
  const reloadMarkerPath = join(dirname(configPath), "reload-complete");
  const shutdownMarkerPath = join(dirname(configPath), "shutdown-complete");
  const controlExtensionPath = join(dirname(configPath), "reload-control.mjs");
  writeFileSync(
    controlExtensionPath,
    `import { writeFileSync } from "node:fs";

export default function reloadControl(pi) {
  let timer;
  pi.registerCommand("hunk-e2e-reload", {
    description: "Arm a delayed host reload for lifecycle acceptance coverage",
    handler: (_input, ctx) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        writeFileSync(${JSON.stringify(reloadMarkerPath)}, "invoked");
        void ctx.reload();
      }, 2000);
    },
  });
  pi.on("session_shutdown", (event) => {
    clearTimeout(timer);
    writeFileSync(${JSON.stringify(shutdownMarkerPath)}, event.reason);
  });
}
`,
    { encoding: "utf8", mode: 0o600 },
  );
  let tabId;
  let paneId;
  const failures = [];

  const sendKey = async (key) => {
    run("herdr", ["pane", "send-keys", paneId, key]);
    await delay(100);
  };

  const sendText = async (text) => {
    run("herdr", ["pane", "send-text", paneId, text]);
    await delay(100);
  };

  const typeCommand = async (text) => {
    await sendText(text);
    await sendKey("enter");
  };

  const waitForHost = async (label = "host TUI") =>
    waitUntil(label, 60_000, () => {
      if (paneHasHunk(paneId) || paneIsShell(paneId) || !paneHasHost(paneId)) return null;
      const view = paneVisible(paneId);
      return /\d+(?:\.\d+)?%[^\n]*\d+k/i.test(view) ? true : null;
    });

  let hostGeneration = 0;
  const startHost = async () => {
    hostGeneration += 1;
    let started = false;
    let startError = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = spawnSync(
        "herdr",
        [
          "agent",
          "start",
          `${spec.name}-${hostGeneration}`,
          "--kind",
          spec.kind,
          "--pane",
          paneId,
          "--timeout",
          "60000",
          "--",
          ...(host === "omp"
            ? ["--model", process.env.PI_HUNK_E2E_MODEL ?? "openai/gpt-5.2"]
            : ["--no-extensions", "-e", join(ROOT, "dist", "index.js")]),
          ...(sessionDir ? ["--session-dir", sessionDir] : ["--no-session"]),
          "-e",
          controlExtensionPath,
        ],
        { encoding: "utf8" },
      );
      if (result.status === 0) {
        started = true;
        break;
      }
      startError = (result.stderr || result.stdout || "").trim();
      if (!/agent_pane_busy/.test(startError)) fail(`herdr agent start failed: ${startError}`);
      await delay(1_000);
    }
    if (!started) fail(`herdr agent start failed: ${startError}`);
    await waitForHost("real host ready");
    await delay(1_000);
  };


  const chooserVisible = () => {
    const view = paneVisible(paneId);
    const actionsVisible = MODE_NAMES.every((mode) => new RegExp(`\\b${mode}\\b`, "i").test(view));
    return actionsVisible && /esc(?:ape)?(?:\s+to)?\s+cancel/i.test(view) ? view : null;
  };

  const openChooser = async (prefix) => {
    await sendKey(prefix);
    return waitUntil(`chooser after ${prefix}`, 5_000, chooserVisible);
  };

  const waitForMode = async (mode, expectation = DEFAULT_MODES[mode]) => {
    if (!expectation) fail(`missing mode expectation for ${mode}`);
    return waitUntil(`${mode} takeover`, 20_000, () => {
      const proc = hunkProcess(paneId);
      if (!proc) return null;
      const view = paneVisible(paneId);
      if (EMPTY_FILTER.test(view)) {
        throw new FatalProbeError(
          `${mode} rendered empty-filter chrome for ${expectation.args.join(" ")}`,
        );
      }
      const actualArgs = invocationArgs(proc);
      if (!argsEqual(actualArgs, expectation.args)) return null;
      if (!HUNK_CHROME.test(view)) return null;
      if (!view.includes(expectation.marker)) return null;
      return { proc, view };
    });
  };

  const quitHunk = async () => {
    if (!paneHasHunk(paneId)) fail("no foreground hunk executable to quit");
    await sendKey("q");
    let answeredSavePrompt = false;
    await waitUntil("q exits Hunk", 15_000, async () => {
      if (!paneHasHunk(paneId)) return true;
      if (!answeredSavePrompt && /save|preference/i.test(paneVisible(paneId))) {
        answeredSavePrompt = true;
        await sendKey("n");
      }
      return null;
    });
    await waitForHost("host resumes after q");
    if (hunkChromeVisible(paneId)) fail("Hunk chrome remains visible after its process exited");
  };

  const openFromHost = async (
    mode,
    hotkeys = DEFAULT_HOTKEYS,
    expectation = DEFAULT_MODES[mode],
  ) => {
    await waitForHost();
    if (paneHasHunk(paneId)) fail("host chord attempted while Hunk was already foreground");
    await openChooser(hotkeys.prefix);
    await sendKey(hotkeys[mode]);
    return waitForMode(mode, expectation);
  };

  const chooseWhileHunkOwnsStdin = async (
    targetMode,
    hotkeys = DEFAULT_HOTKEYS,
    expectation = DEFAULT_MODES[targetMode],
  ) => {
    if (!paneHasHunk(paneId)) fail("in-Hunk chord attempted without foreground Hunk ownership");
    await sendKey(hotkeys.prefix);
    await sendKey(hotkeys[targetMode]);
    return waitForMode(targetMode, expectation);
  };

  const sameModeExit = async (mode, hotkeys = DEFAULT_HOTKEYS) => {
    await openFromHost(mode, hotkeys);
    await sendKey(hotkeys.prefix);
    await sendKey(hotkeys[mode]);
    await waitUntil(`${mode} same-mode chord exits`, 15_000, () =>
      paneHasHunk(paneId) ? null : true,
    );
    await waitForHost(`${mode} same-mode chord returns host`);
  };

  const openDirect = async (command, mode, expectation = DEFAULT_MODES[mode]) => {
    await waitForHost();
    await typeCommand(command);
    return waitForMode(mode, expectation);
  };

  const reloadHost = async () => {
    const command = host === "omp" ? "/reload-plugins" : "/reload";
    await waitForHost();
    await typeCommand(command);
    await delay(2_000);
    await waitForHost(`host after ${command}`);
  };

  const reloadDuring = async (label, open) => {
    rmSync(reloadMarkerPath, { force: true });
    rmSync(shutdownMarkerPath, { force: true });
    await waitForHost();
    await typeCommand("/hunk-e2e-reload");
    await waitForHost(`${label} reload armed`);
    await open();
    await waitUntil(`${label} interrupted by host reload`, 10_000, () => {
      if (!existsSync(reloadMarkerPath) || paneHasHunk(paneId) || !paneHasHost(paneId)) return null;
      const view = paneVisible(paneId);
      if (!/Reloaded session/i.test(view)) return null;
      if (!existsSync(shutdownMarkerPath)) {
        throw new FatalProbeError(`${label} host reloaded without session_shutdown`);
      }
      if (chooserVisible() || (/Restore defaults/i.test(view) && /\bDone\b/.test(view)))
        return null;
      return true;
    });
    await waitForHost(`${label} host after reload`);
    await openChooser(DEFAULT_HOTKEYS.prefix);
    await sendKey("escape");
    await waitUntil(`${label} fresh runtime chooser closes`, 5_000, () =>
      !chooserVisible() && !paneHasHunk(paneId) ? true : null,
    );
  };

  const assertInvalidCommand = async (command) => {
    await waitForHost();
    const beforeCount = paneRecent(paneId).match(USAGE_ERROR)?.length ?? 0;
    await typeCommand(command);
    await waitUntil(`${command} fresh usage error`, 5_000, () => {
      if (paneHasHunk(paneId)) {
        throw new FatalProbeError(`${command} unexpectedly launched Hunk`);
      }
      const recent = paneRecent(paneId);
      const count = recent.match(USAGE_ERROR)?.length ?? 0;
      return count > beforeCount ? recent : null;
    });
    await waitForHost(`host remains active after ${command}`);
  };

  const openCommentEditor = async () => {
    await sendKey("c");
    return waitUntil("comment editor", 5_000, () => {
      const view = paneVisible(paneId);
      return COMMENT_EDITOR.test(view) && COMMENT_SAVE_HINT.test(view) ? view : null;
    });
  };

  const typeEveryKey = async (text) => {
    run("herdr", ["pane", "send-keys", paneId, ...text]);
    await delay(200);
  };

  const saveComment = async (text) => {
    await typeEveryKey(text);
    await sendKey("ctrl+s");
    await waitUntil(`saved comment ${text}`, 10_000, () => {
      const view = paneVisible(paneId);
      return view.includes(text) ? view : null;
    });
  };
  const listUserComments = () => {
    const stdout = run("hunk", [
      "session",
      "comment",
      "list",
      "--repo",
      fixture,
      "--type",
      "user",
      "--json",
    ]);
    return JSON.parse(stdout);
  };

  const assertHostReceived = async (text) => {
    await waitForHost("host receives Hunk comments");
    if (sessionDir) {
      // OMP does not expose programmatic extension turns through Herdr's screen
      // status. Its session entry is the first reliable signal that Esc can
      // interrupt the delivered turn without racing ahead of it.
      const occurrences = await waitUntil(`OMP session user message ${text}`, 60_000, () => {
        const count = jsonlOccurrences(sessionDir, text);
        return count > 0 ? count : null;
      });
      await sendKey("esc");
      await delay(500);
      return { view: paneVisible(paneId), occurrences };
    }
    const view = await waitUntil(`host-visible comment ${text}`, 20_000, () => {
      if (paneHasHunk(paneId)) return null;
      const visible = paneVisible(paneId);
      return visible.includes(text) ? visible : null;
    });
    return { view, occurrences: view.split(text).length - 1 };
  };

  const recoverToHost = async () => {
    if (!paneId || !paneHasHunk(paneId)) return;
    try {
      await sendKey("esc");
      await sendKey("q");
      if (/save|preference/i.test(paneVisible(paneId))) await sendKey("n");
      await waitUntil("scenario recovery", 5_000, () => (paneHasHunk(paneId) ? null : true));
    } catch {
      // Preserve the original scenario failure; tab cleanup is authoritative.
    }
  };

  const evidence = () => {
    let processes = "(process info unavailable)";
    try {
      processes = JSON.stringify(foregroundProcesses(paneId), null, 2);
    } catch (error) {
      processes = error instanceof Error ? error.message : String(error);
    }
    return [
      `foreground processes:\n${processes}`,
      `visible pane:\n${paneVisible(paneId)}`,
      `recent pane:\n${paneRecent(paneId)}`,
    ].join("\n");
  };

  const scenario = async (name, body) => {
    process.stdout.write(`  ${name} ... `);
    try {
      await body();
      process.stdout.write("ok\n");
    } catch (error) {
      process.stdout.write("FAIL\n");
      const detail = error instanceof Error ? error.message : String(error);
      const report = `${name}: ${detail}\n${evidence()}`;
      failures.push(report);
      console.error(`    ${report.replaceAll("\n", "\n    ")}`);
      await recoverToHost();
    }
  };

  const scenarios = [
    {
      name: "startup stays in the host without automatic Hunk review",
      run: async () => {
        await waitForHost();
        await delay(1_000);
        if (paneHasHunk(paneId)) fail("Hunk automatically took over at host startup");
      },
    },
    {
      name: "default prefix opens the host chooser and Esc cancels",
      run: async () => {
        await waitForHost();
        await openChooser(DEFAULT_HOTKEYS.prefix);
        await sendKey("esc");
        await waitUntil("chooser cancellation", 5_000, () =>
          !chooserVisible() && !paneHasHunk(paneId) ? true : null,
        );
        await waitForHost();
      },
    },
  ];

  for (const mode of MODE_NAMES) {
    scenarios.push({
      name: `default ${mode} chord opens a visible fullscreen ${mode} takeover`,
      run: async () => {
        await openFromHost(mode);
        await quitHunk();
      },
    });
  }

  for (const mode of MODE_NAMES) {
    scenarios.push({
      name: `in-Hunk default ${mode} same-mode chord exits`,
      run: async () => sameModeExit(mode),
    });
  }

  for (const [source, target] of CROSS_MODE_SWITCHES) {
    scenarios.push({
      name: `in-Hunk default chord switches ${source} -> ${target}`,
      run: async () => {
        await openFromHost(source);
        await chooseWhileHunkOwnsStdin(target);
        await quitHunk();
      },
    });
  }

  for (const mode of MODE_NAMES) {
    scenarios.push({
      name: `q exits ${mode} and the same default mode reopens`,
      run: async () => {
        await openFromHost(mode);
        await quitHunk();
        await openFromHost(mode);
        await quitHunk();
      },
    });
  }

  scenarios.push(
    {
      name: "direct /hunk opens default diff",
      run: async () => {
        await openDirect("/hunk", "diff");
        await quitHunk();
      },
    },
    {
      name: "direct /hunk diff uses default HEAD target",
      run: async () => {
        await openDirect("/hunk diff", "diff");
        await quitHunk();
      },
    },
    {
      name: "direct /hunk diff HEAD~1 accepts an explicit target",
      run: async () => {
        await openDirect("/hunk diff HEAD~1", "diff", {
          args: ["diff", "HEAD~1", "--watch"],
          marker: "show-head.txt",
        });
        await quitHunk();
      },
    },
    {
      name: "direct /hunk show uses default HEAD target",
      run: async () => {
        await openDirect("/hunk show", "show");
        await quitHunk();
      },
    },
    {
      name: "direct /hunk show HEAD~1 accepts an explicit target",
      run: async () => {
        await openDirect("/hunk show HEAD~1", "show", {
          args: ["show", "HEAD~1"],
          marker: "base.txt",
        });
        await quitHunk();
      },
    },
    {
      name: "direct /hunk stash uses the default stash",
      run: async () => {
        await openDirect("/hunk stash", "stash");
        await quitHunk();
      },
    },
    {
      name: "direct /hunk stash stash@{1} accepts an explicit ref",
      run: async () => {
        await openDirect("/hunk stash stash@{1}", "stash", {
          args: ["stash", "show", "stash@{1}"],
          marker: "stash-explicit.txt",
        });
        await quitHunk();
      },
    },
    {
      name: "direct /hunk config reports the isolated global config",
      run: async () => {
        await waitForHost();
        await typeCommand("/hunk config");
        await waitUntil("config command output", 5_000, () => {
          if (paneHasHunk(paneId)) {
            throw new FatalProbeError("/hunk config unexpectedly launched Hunk");
          }
          const view = paneVisible(paneId);
          return view.includes(basename(configPath)) || /\bhotkeys\b|ctrl\+space/i.test(view)
            ? view
            : null;
        });
        if (!configMatches(configPath, DEFAULT_HOTKEYS)) {
          fail(
            `/hunk config changed or expanded the global config: ${readFileSync(configPath, "utf8")}`,
          );
        }
        await sendKey("esc");
        await waitForHost("host after closing config editor");
        await openChooser(DEFAULT_HOTKEYS.prefix);
        await sendKey("esc");
        await waitUntil("host chooser closes after config editor", 5_000, () =>
          !chooserVisible() && !paneHasHunk(paneId) ? true : null,
        );
        await waitForHost("normal host after config editor");
      },
    },
  );

  scenarios.push(
    {
      name: "host reload interrupts an open chooser and terminates its dispatcher",
      run: async () =>
        reloadDuring("chooser", async () => {
          await openChooser(DEFAULT_HOTKEYS.prefix);
        }),
    },
    {
      name: "host reload interrupts interactive config and terminates its dispatcher",
      run: async () =>
        reloadDuring("config editor", async () => {
          await typeCommand("/hunk config");
          await waitUntil("config editor before reload", 5_000, () => {
            const view = paneVisible(paneId);
            return /Restore defaults/i.test(view) && /\bDone\b/.test(view) ? view : null;
          });
        }),
    },
  );

  for (const command of ["/hunk status", "/hunk close", "/hunk overlay", "/hunk review"]) {
    scenarios.push({
      name: `removed command ${command} is rejected with usage evidence`,
      run: async () => assertInvalidCommand(command),
    });
  }

  for (const command of [
    "/hunk diff HEAD extra",
    "/hunk show HEAD extra",
    "/hunk stash stash@{0} extra",
    "/hunk config restore extra",
  ]) {
    scenarios.push({
      name: `invalid arity ${command} is rejected with usage evidence`,
      run: async () => assertInvalidCommand(command),
    });
  }

  scenarios.push({
    name: "interactive config editor changes every binding, then reload activates host and in-Hunk chords",
    run: async () => {
      await waitForHost();
      await typeCommand("/hunk config");
      const waitForConfigList = (label) =>
        waitUntil(label, 5_000, () => {
          const view = paneVisible(paneId);
          return /Restore defaults/i.test(view) && /\bDone\b/.test(view) ? view : null;
        });
      await waitForConfigList("interactive config list");

      for (let index = 0; index < CUSTOM_HOTKEY_STAGES.length; index += 1) {
        const stage = CUSTOM_HOTKEY_STAGES[index];
        for (let step = 0; step < index; step += 1) await sendKey("down");
        await sendKey("enter");
        await waitUntil(`interactive ${stage.field} capture`, 5_000, () => {
          const view = paneVisible(paneId);
          return new RegExp(`Set Pi-hunk ${stage.field} hotkey`, "i").test(view) ? view : null;
        });
        if (stage.field === "prefix") {
          const configBeforeConflict = readFileSync(configPath, "utf8");
          await sendKey("ctrl+g");
          await waitUntil("host-reserved prefix conflict warning", 5_000, () => {
            const view = paneVisible(paneId);
            const warning =
              /conflict|reserved|already.*(?:bound|used)|host.*(?:shortcut|binding|hotkey)/i;
            return warning.test(view) && /Set Pi-hunk prefix hotkey/i.test(view) ? view : null;
          });
          const configAfterConflict = readFileSync(configPath, "utf8");
          if (configAfterConflict !== configBeforeConflict) {
            fail("host-conflicting ctrl+g mutated the isolated config");
          }
        }
        await sendKey(stage.hotkeys[stage.field]);
        await waitUntil(`interactive ${stage.field} save`, 5_000, () =>
          configMatches(configPath, stage.hotkeys) ? true : null,
        );
        await waitForConfigList(`config list after saving ${stage.field}`);
      }

      await sendKey("esc");
      await waitForHost("host after interactive config editor");
      await reloadHost();
      const customHotkeys = CUSTOM_HOTKEY_STAGES[CUSTOM_HOTKEY_STAGES.length - 1].hotkeys;
      for (const mode of MODE_NAMES) await sameModeExit(mode, customHotkeys);
    },
  });

  for (const stage of CUSTOM_HOTKEY_STAGES) {
    scenarios.push({
      name: `config reload activates custom ${stage.field} in host and in-Hunk chords`,
      run: async () => {
        writeHotkeys(configPath, stage.hotkeys);
        await reloadHost();
        if (!configMatches(configPath, stage.hotkeys)) {
          fail(`custom ${stage.field} config was not retained`);
        }
        await sameModeExit(stage.mode, stage.hotkeys);
      },
    });
  }

  scenarios.push({
    name: "/hunk config restore removes overrides and reactivates every default chord",
    run: async () => {
      await waitForHost();
      await typeCommand("/hunk config restore");
      await waitUntil("removed restored global config", 5_000, () =>
        existsSync(configPath) ? null : true,
      );
      await reloadHost();
      for (const mode of MODE_NAMES) await sameModeExit(mode, DEFAULT_HOTKEYS);
    },
  });

  const savedComment = `pihunksaved${host}abcdefghijklmnopqrstuvwxyz0123456789hshst`;
  const editOriginal = `pihunkoriginal${host}abcdefghijklmnopqrstuvwxyz0123456789hshst`;
  const editedComment = `pihunkedited${host}zyxwvutsrqponmlkjihgfedcba9876543210thshs`;
  const switchedComment = `pihunkswitched${host}abcdefghijklm0123456789hshstnopqrstuvwxyz`;
  const rapidComment = `hshsttHST${host}a1Z9hTsS0tHh2sT3abcdefghijklmnopqrstuvwxyz9876543210HSThshst`;
  const removedComment = `pihunkremoved${host}hshst0123456789abcdefghijklmnopqrstuvwxyz`;

  scenarios.push(
    {
      name: "rapid mixed printable comment input preserves every character before save, after save, and at host delivery",
      run: async () => {
        await openFromHost("diff");
        await openCommentEditor();
        await typeEveryKey(rapidComment);
        const beforeSave = await waitUntil("exact rapid comment before save", 10_000, () => {
          const view = paneVisible(paneId);
          return view.split(rapidComment).length - 1 === 1 ? view : null;
        });
        if (!beforeSave.includes(rapidComment)) fail("rapid comment differed before save");
        await sendKey("ctrl+s");
        const afterSave = await waitUntil("exact rapid comment after save", 10_000, () => {
          const view = paneVisible(paneId);
          return view.split(rapidComment).length - 1 === 1 ? view : null;
        });
        if (!afterSave.includes(rapidComment)) fail("rapid comment differed after save");
        await quitHunk();
        const delivered = await assertHostReceived(rapidComment);
        if (delivered.occurrences !== 1) {
          fail("host did not receive the identical rapid comment exactly once");
        }
        await sendKey("esc");
      },
    },
    {
      name: "saved comment is delivered to the host agent after Hunk exits",
      run: async () => {
        await openFromHost("diff");
        await openCommentEditor();
        await saveComment(savedComment);
        await quitHunk();
        await assertHostReceived(savedComment);
        await sendKey("esc");
      },
    },
    {
      name: "editing a draft before first save delivers only its final value",
      run: async () => {
        await openFromHost("diff");
        await openCommentEditor();
        await typeEveryKey(editOriginal);
        await waitUntil("original draft note text", 10_000, () => {
          const view = paneVisible(paneId);
          return view.includes(editOriginal) ? view : null;
        });
        run("herdr", [
          "pane",
          "send-keys",
          paneId,
          ...Array.from({ length: editOriginal.length }, () => "backspace"),
        ]);
        await delay(200);
        await waitUntil("cleared original draft note text", 10_000, () => {
          const view = paneVisible(paneId);
          return COMMENT_EDITOR.test(view) &&
            COMMENT_SAVE_HINT.test(view) &&
            !view.includes(editOriginal)
            ? view
            : null;
        });
        await typeEveryKey(editedComment);
        await waitUntil("edited draft note text", 10_000, () => {
          const view = paneVisible(paneId);
          return view.includes(editedComment) && !view.includes(editOriginal) ? view : null;
        });
        await sendKey("ctrl+s");
        await waitUntil("saved edited draft note", 10_000, () => {
          const view = paneVisible(paneId);
          return view.includes(editedComment) && !view.includes(editOriginal) ? view : null;
        });
        await quitHunk();
        const delivery = await assertHostReceived(editedComment);
        if (delivery.occurrences !== 1) fail("edited draft was not delivered exactly once");
        if (delivery.view.includes(editOriginal)) {
          fail("original draft text reached the visible host history");
        }
        if (sessionDir && jsonlOccurrences(sessionDir, editOriginal) !== 0) {
          fail("original draft text reached the OMP host session");
        }
        await sendKey("esc");
      },
    },
    {
      name: "removing a saved note while Hunk is open hides it and prevents host delivery",
      run: async () => {
        await openFromHost("diff");
        await openCommentEditor();
        await saveComment(removedComment);
        const commentId = await waitUntil("saved user note id", 10_000, () => {
          const id = commentIdContaining(listUserComments(), removedComment);
          return id || null;
        });
        run("hunk", ["session", "comment", "rm", "--repo", fixture, "--json", commentId]);
        await waitUntil("saved note removal", 10_000, () => {
          const listed = JSON.stringify(listUserComments());
          const view = paneVisible(paneId);
          return !listed.includes(removedComment) && !view.includes(removedComment) ? true : null;
        });
        await quitHunk();
        await waitForHost("host after removed note exit");
        await delay(500);
        if (sessionDir) {
          if (jsonlOccurrences(sessionDir, removedComment) !== 0) {
            fail("removed note reached the OMP host session");
          }
        } else if (paneVisible(paneId).includes(removedComment)) {
          fail("removed note reached the Pi host");
        }
      },
    },
    {
      name: "saved comment survives an in-Hunk cross-switch and delivers exactly once on final exit",
      run: async () => {
        await openFromHost("diff");
        await openCommentEditor();
        await saveComment(switchedComment);
        await chooseWhileHunkOwnsStdin("show");
        if (!paneHasHunk(paneId)) fail("host agent interrupted the diff -> show takeover");
        await quitHunk();
        const delivery = await assertHostReceived(switchedComment);
        const deliveries = delivery.occurrences;
        if (deliveries !== 1) {
          fail(`expected one host delivery after final exit, observed ${deliveries}`);
        }
      },
    },
  );

  const cleanup = () => {
    if (paneId) {
      try {
        run("herdr", ["pane", "send-keys", paneId, "esc"]);
        run("herdr", ["pane", "send-keys", paneId, "q"]);
        run("herdr", ["pane", "send-keys", paneId, "ctrl+c"]);
      } catch {
        // The foreground process or pane may already be gone.
      }
    }
    if (tabId) {
      try {
        herdr(["tab", "close", tabId]);
      } catch {
        // The tab may already have been closed by the host.
      }
    }
    rmSync(dirname(configPath), { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
    if (sessionDir) rmSync(sessionDir, { recursive: true, force: true });
    if (ompHome) rmSync(ompHome, { recursive: true, force: true });
  };

  try {
    const created = herdr([
      "tab",
      "create",
      "--workspace",
      workspace,
      "--cwd",
      fixture,
      "--label",
      `hunk-e2e-${host}`,
      ...Object.entries(paneEnvironment).flatMap(([name, value]) => [
        "--env",
        `${name}=${value}`,
      ]),
    ]);
    tabId = created.result?.tab?.tab_id;
    paneId = created.result?.root_pane?.pane_id;
    if (!tabId || !paneId) fail(`tab create missing ids: ${JSON.stringify(created)}`);

    await waitUntil("shell prompt", 20_000, () => (paneIsShell(paneId) ? true : null));
    await startHost();

    const selectedScenarios = SCENARIO_FILTER
      ? scenarios.filter((entry) => SCENARIO_FILTER.test(entry.name))
      : scenarios;
    if (selectedScenarios.length === 0) fail("scenario filter matched nothing");
    console.log(`  scenario inventory: ${selectedScenarios.length}/${scenarios.length}`);
    for (const entry of selectedScenarios) await scenario(entry.name, entry.run);
  } finally {
    cleanup();
  }

  if (failures.length) {
    const selectedCount = SCENARIO_FILTER
      ? scenarios.filter((entry) => SCENARIO_FILTER.test(entry.name)).length
      : scenarios.length;
    fail(
      `${host} e2e failed in ${failures.length}/${selectedCount} scenarios:\n- ${failures.join("\n- ")}`,
    );
  }
}

const argv = process.argv.slice(2);
const skipBuild = argv.includes("--no-build");
const positional = argv.filter((arg) => arg !== "--no-build");
const unknownFlag = positional.find((arg) => arg.startsWith("--"));
if (unknownFlag)
  fail(`unknown option ${unknownFlag}; usage: node scripts/e2e-herdr.mjs [pi|omp] [--no-build]`);
if (positional.length > 1) {
  fail("usage: node scripts/e2e-herdr.mjs [pi|omp] [--no-build]");
}
const hosts = positional.length === 1 ? positional : ["pi", "omp"];
for (const host of hosts) {
  if (!(host in HOSTS)) fail(`unknown host ${host}; expected pi or omp`);
}

if (!skipBuild) {
  mkdirSync(join(ROOT, "dist"), { recursive: true });
  run("npm", ["run", "build"]);
}

let failed = false;
for (const host of hosts) {
  console.log(`pi-hunk e2e (${host})`);
  try {
    await runHost(host);
    console.log(`  ${host} passed\n`);
  } catch (error) {
    failed = true;
    console.error(`  ${host} failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
process.exit(failed ? 1 : 0);
