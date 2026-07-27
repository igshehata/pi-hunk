import { describe, expect, it } from "vitest";
import { ChangeDetector, isMutation, isWorkspaceMutation } from "../extensions/change-detector.ts";

describe("isMutation", () => {
  it("recognizes file mutation tools", () => {
    expect(isMutation("edit", { path: "a.ts" })).toBe(true);
    expect(isMutation("functions.write", { path: "a.ts" })).toBe(true);
    expect(isMutation("apply_patch", {})).toBe(true);
    expect(isMutation("Write", { path: "a.ts" })).toBe(true);
    expect(isMutation("tools.edit_file", {})).toBe(true);
    expect(isMutation("multi_edit", {})).toBe(true);
  });

  it("recognizes mutating shell commands without flagging normal commands", () => {
    expect(isMutation("bash", { command: "sed -i '' s/a/b/ file.ts" })).toBe(true);
    expect(isMutation("bash", { command: "echo changed > file.ts" })).toBe(true);
    expect(isMutation("bash", { command: 'echo "changed" > file.ts' })).toBe(true);
    expect(isMutation("bash", { command: "touch file.ts" })).toBe(true);
    expect(isMutation("bash", { command: "printf x >> file.ts" })).toBe(true);
    expect(isMutation("bash", { command: "mv a.ts b.ts" })).toBe(true);
    expect(isMutation("bash", { command: "rm -rf build" })).toBe(true);
    expect(isMutation("bash", { command: "npm install lodash" })).toBe(true);
    expect(isMutation("bash", { command: "git apply patch.diff" })).toBe(true);
    expect(isMutation("bash", { command: "jj restore src/a.ts" })).toBe(true);
    expect(isMutation("bash", { command: "jj squash" })).toBe(true);
    expect(isMutation("bash", { command: "sl revert src/a.ts" })).toBe(true);
    expect(isMutation("bash", { command: "cd src && rm generated.ts" })).toBe(true);
    expect(isMutation("bash", { command: "cd src\ntouch generated.ts" })).toBe(true);
    expect(isMutation("bash", { command: "grep 'mv ' src/commands.ts" })).toBe(false);
    expect(isMutation("bash", { command: 'echo "please rm the file"' })).toBe(false);
    expect(isMutation("bash", { command: 'echo "example; touch file.ts"' })).toBe(false);
    expect(isMutation("bash", { command: "printf 'touch file.ts\\n'" })).toBe(false);
    expect(isMutation("bash", { command: "npm test" })).toBe(false);
    expect(isMutation("bash", { command: "git status" })).toBe(false);
    expect(isMutation("bash", { command: "jj status" })).toBe(false);
    expect(isMutation("bash", { command: "sl log" })).toBe(false);
    expect(isMutation("bash", { command: "cat file.ts" })).toBe(false);
    expect(isMutation("read", { path: "a.ts" })).toBe(false);
    expect(isMutation("grep", { pattern: "x" })).toBe(false);
  });

  it("detects mutations inside nested shell -c wrappers without flagging quoted prose", () => {
    expect(isMutation("bash", { command: "bash -lc 'touch generated.ts'" })).toBe(true);
    expect(isMutation("bash", { command: `sh -c "sed -i 's/a/b/' src/a.ts"` })).toBe(true);
    expect(isMutation("bash", { command: "zsh -c 'npm install lodash'" })).toBe(true);
    expect(isMutation("bash", { command: "dash -c 'rm -rf build'" })).toBe(true);
    expect(isMutation("bash", { command: "env FOO=1 bash -lc 'touch generated.ts'" })).toBe(true);
    expect(isMutation("bash", { command: "env -i PATH=/usr/bin bash -c 'mkdir out'" })).toBe(true);
    expect(isMutation("bash", { command: "env -iu FOO bash -c 'touch generated.ts'" })).toBe(true);
    expect(isMutation("bash", { command: "FOO=1 bash -c 'touch generated.ts'" })).toBe(true);
    expect(isMutation("bash", { command: "env FOO=1 touch generated.ts" })).toBe(true);
    expect(isMutation("bash", { command: "FOO=1 touch generated.ts" })).toBe(true);
    expect(isMutation("bash", { command: "bash -o errexit -c 'touch generated.ts'" })).toBe(true);
    expect(isMutation("bash", { command: "bash --rcfile /dev/null -c 'touch generated.ts'" })).toBe(
      true,
    );
    expect(isMutation("bash", { command: "/bin/bash -cl 'mv a.ts b.ts'" })).toBe(true);
    expect(isMutation("bash", { command: "cd src && bash -lc 'touch generated.ts'" })).toBe(true);
    expect(isMutation("bash", { command: "bash -c 'echo ok' && touch generated.ts" })).toBe(true);
    // Nested wrappers whose -c payload is itself a nested shell.
    expect(isMutation("bash", { command: "bash -c \"sh -c 'touch generated.ts'\"" })).toBe(true);
    // Missing/unclosed -c payload is ambiguous → treat as mutation (unresolved evidence).
    expect(isMutation("bash", { command: "bash -lc" })).toBe(true);
    expect(isMutation("bash", { command: "bash -c 'touch generated.ts" })).toBe(true);
    // Quoted non-command prose remains non-mutating even when nested.
    expect(isMutation("bash", { command: 'echo "please rm the file"' })).toBe(false);
    expect(isMutation("bash", { command: `bash -c 'echo "please rm the file"'` })).toBe(false);
    expect(isMutation("bash", { command: "bash -lc 'npm test'" })).toBe(false);
    expect(isMutation("bash", { command: "env FOO=1 bash -c 'git status'" })).toBe(false);
    expect(isMutation("bash", { command: "FOO=1 npm test" })).toBe(false);
    expect(isMutation("bash", { command: "env FOO=1 printf '>'" })).toBe(false);
  });

  it("records nested and ambiguous pathless shell mutations as unresolved evidence", () => {
    const detector = new ChangeDetector();

    expect(
      detector.recordSuccessfulMutation(
        "bash",
        { command: "bash -lc 'touch generated.ts'" },
        "/repo",
      ),
    ).toMatchObject({ mutation: true, targets: [], unresolved: true, revision: 1 });
    expect(
      detector.recordSuccessfulMutation("bash", { command: "bash -lc" }, "/repo"),
    ).toMatchObject({ mutation: true, targets: [], unresolved: true, revision: 2 });
    expect(
      detector.recordSuccessfulMutation("bash", { command: "bash -lc 'npm test'" }, "/repo"),
    ).toMatchObject({ mutation: true, targets: [], unresolved: true, revision: 2 });
  });

  it("is conservative with incomplete bash args", () => {
    expect(isMutation("bash", null)).toBe(false);
    expect(isMutation("bash", {})).toBe(false);
    expect(isMutation("bash", { command: 123 })).toBe(false);
    expect(isMutation("shell", { command: "touch x" })).toBe(false);
  });
});

describe("isWorkspaceMutation", () => {
  const cwd = "/repo/project";

  it("accepts path-bearing mutation tools inside and outside Pi's workspace", () => {
    expect(isWorkspaceMutation("write", { path: "/tmp/outside.ts" }, cwd)).toBe(true);
    expect(isWorkspaceMutation("write", { path: "../sibling.ts" }, cwd)).toBe(true);
    expect(isWorkspaceMutation("write", { path: "..config/generated.ts" }, cwd)).toBe(true);
    expect(isWorkspaceMutation("write", { path: "src/inside.ts" }, cwd)).toBe(true);
    expect(
      isWorkspaceMutation(
        "multi_edit",
        { edits: [{ path: "/tmp/outside.ts" }, { path: "src/inside.ts" }] },
        cwd,
      ),
    ).toBe(true);
  });

  it("keeps pathless mutating tools conservative", () => {
    expect(isWorkspaceMutation("apply_patch", {}, cwd)).toBe(true);
    expect(isWorkspaceMutation("bash", { command: "touch generated.ts" }, cwd)).toBe(true);
  });
});
