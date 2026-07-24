import { describe, expect, it } from "vitest";
import { isMutation, isWorkspaceMutation } from "../extensions/change-detector.ts";

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
