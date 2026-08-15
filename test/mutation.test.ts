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
    // GNU env: a mere "-" implies -i and must not stop option peeling.
    expect(isMutation("bash", { command: "env - bash -c 'touch generated.ts'" })).toBe(true);
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

  it("recognizes common command wrappers and shell control grammar conservatively", () => {
    expect(isMutation("bash", { command: "command -- touch generated.ts" })).toBe(true);
    expect(isMutation("bash", { command: "exec rm generated.ts" })).toBe(true);
    expect(isMutation("bash", { command: "nohup cp a.ts b.ts" })).toBe(true);
    expect(isMutation("bash", { command: "sudo -n -- mv a.ts b.ts" })).toBe(true);
    expect(isMutation("bash", { command: "sudo --user root rm generated.ts" })).toBe(true);
    expect(isMutation("bash", { command: "doas -n install source.ts target.ts" })).toBe(true);
    expect(isMutation("bash", { command: "nice -n 5 truncate -s 0 generated.ts" })).toBe(true);
    expect(isMutation("bash", { command: "timeout -s TERM 2 sh -c 'mkdir out'" })).toBe(true);
    expect(isMutation("bash", { command: "printf '%s\\n' a.ts | xargs -n 1 rm" })).toBe(true);
    expect(isMutation("bash", { command: "find build -type f -exec rm {} +" })).toBe(true);
    expect(isMutation("bash", { command: "find build -type f -delete" })).toBe(true);
    expect(isMutation("bash", { command: "git restore src/a.ts" })).toBe(true);
    expect(isMutation("bash", { command: "git checkout -- src/a.ts" })).toBe(true);
    expect(isMutation("bash", { command: "git mv old.ts new.ts" })).toBe(true);
    expect(isMutation("bash", { command: "dd if=source.bin of=target.bin" })).toBe(true);
    expect(isMutation("bash", { command: "if test -f old.ts; then rm old.ts; fi" })).toBe(true);
    expect(isMutation("bash", { command: 'for file in a b; do touch "$file"; done' })).toBe(true);
    expect(isMutation("bash", { command: "(mkdir out)" })).toBe(true);
    expect(isMutation("bash", { command: "{ chmod 600 secret; }" })).toBe(true);
    expect(isMutation("bash", { command: "! ln -s source target" })).toBe(true);

    expect(isMutation("bash", { command: "sudo -n git status" })).toBe(false);
    expect(isMutation("bash", { command: "command printf 'please rm the file\\n'" })).toBe(false);
    expect(isMutation("bash", { command: "find src -type f -print" })).toBe(false);
    expect(isMutation("bash", { command: "printf 'please rm the file\\n' | xargs echo" })).toBe(
      false,
    );
    expect(isMutation("bash", { command: 'echo "sudo rm prose.ts"' })).toBe(false);
  });

  it("treats executable shell indirection and output redirection as mutation evidence", () => {
    expect(isMutation("bash", { command: "git status > status.txt" })).toBe(true);
    expect(isMutation("bash", { command: "echo ok 2>> errors.log" })).toBe(true);
    expect(isMutation("bash", { command: 'echo "$(touch generated.ts)"' })).toBe(true);
    expect(isMutation("bash", { command: "cat <(mkdir generated)" })).toBe(true);
    expect(isMutation("bash", { command: 'bash -c "$COMMAND"' })).toBe(true);
    expect(isMutation("bash", { command: 'eval "$COMMAND"' })).toBe(true);
    expect(isMutation("bash", { command: "source ./generated-script.sh" })).toBe(true);

    expect(isMutation("bash", { command: 'echo "git status > status.txt"' })).toBe(false);
    expect(isMutation("bash", { command: `echo "$(printf 'please rm the file')"` })).toBe(false);
    expect(isMutation("bash", { command: `bash -c 'echo "$HOME"'` })).toBe(false);
    expect(isMutation("bash", { command: "printf '2> errors.log\\n'" })).toBe(false);
  });

  it("distinguishes shell comparisons and arithmetic from file redirection", () => {
    expect(isMutation("bash", { command: '[[ "$left" > "$right" ]]' })).toBe(false);
    expect(
      isMutation("bash", {
        command: 'if [[ "$left" > "$right" ]]; then printf "ordered\\n"; fi',
      }),
    ).toBe(false);
    expect(isMutation("bash", { command: "(( value > limit ))" })).toBe(false);
    expect(isMutation("bash", { command: "for ((i = 0; i > limit; i++)); do :; done" })).toBe(
      false,
    );
    expect(isMutation("bash", { command: "echo $(( value > limit ))" })).toBe(false);
    expect(isMutation("bash", { command: 'echo "$(( value > limit ))"' })).toBe(false);

    // Single-bracket `>` is a shell redirect unless quoted or escaped.
    expect(isMutation("bash", { command: '[ "$left" > "$right" ]' })).toBe(true);
    expect(isMutation("bash", { command: '[[ "$left" > "$right" ]] > comparison.txt' })).toBe(true);
    expect(isMutation("bash", { command: "(( value > limit )) > arithmetic.txt" })).toBe(true);
    expect(
      isMutation("bash", {
        command: '[[ -n "$(printf changed > nested.txt)" ]]',
      }),
    ).toBe(true);
    expect(
      isMutation("bash", {
        command: "echo $(( $(printf changed > nested.txt) + 1 ))",
      }),
    ).toBe(true);
  });

  it("parses GNU env split-string argv conservatively", () => {
    // Exact review example plus every supported spelling.
    expect(isMutation("bash", { command: `env -S 'bash -c "touch generated.ts"'` })).toBe(true);
    expect(isMutation("bash", { command: `env -S'bash -c "touch generated.ts"'` })).toBe(true);
    expect(
      isMutation("bash", { command: `env --split-string 'bash -c "touch generated.ts"'` }),
    ).toBe(true);
    expect(
      isMutation("bash", { command: `env --split-string='bash -c "touch generated.ts"'` }),
    ).toBe(true);
    expect(
      isMutation("bash", {
        command: `env --split-string='-i -u OLD FOO=1 bash -c "mkdir out"'`,
      }),
    ).toBe(true);
    expect(isMutation("bash", { command: `env -S 'FOO=1 bash -c' 'touch generated.ts'` })).toBe(
      true,
    );
    expect(isMutation("bash", { command: `env -S 'touch generated.ts'` })).toBe(true);
    expect(isMutation("bash", { command: `env -S 'env touch generated.ts'` })).toBe(true);
    expect(isMutation("bash", { command: `env -S 'git apply patch.diff'` })).toBe(true);

    expect(isMutation("bash", { command: `env -S 'bash -c "git status"'` })).toBe(false);
    expect(
      isMutation("bash", { command: `env -S 'bash -c "echo \\"please rm the file\\""'` }),
    ).toBe(false);
    expect(
      isMutation("bash", { command: `env --split-string='printf "touch generated.ts"'` }),
    ).toBe(false);
    expect(isMutation("bash", { command: `env -S 'echo "example; touch file.ts"'` })).toBe(false);
    expect(isMutation("bash", { command: `env -u touch -C rm bash -c 'git status'` })).toBe(false);
    expect(isMutation("bash", { command: `env -uSOMETHING bash -c 'git status'` })).toBe(false);
    expect(
      isMutation("bash", {
        command: `env --unset=touch --chdir=rm --argv0 mkdir bash -c 'git status'`,
      }),
    ).toBe(false);

    // Malformed and runtime-dependent values remain mutation evidence.
    expect(isMutation("bash", { command: `env -S 'bash -c "git status'` })).toBe(true);
    expect(isMutation("bash", { command: "env --split-string" })).toBe(true);
    expect(isMutation("bash", { command: `env -S '$COMMAND --version'` })).toBe(true);
    expect(isMutation("bash", { command: `env -S 'bash -c "\${COMMAND}"'` })).toBe(true);

    let nestedMutation = `bash -c "touch generated.ts"`;
    for (let depth = 0; depth < 2; depth += 1) {
      nestedMutation = `-S ${JSON.stringify(nestedMutation)}`;
    }
    expect(isMutation("bash", { command: `env -S '${nestedMutation}'` })).toBe(true);

    let deeplyNested = `bash -c "git status"`;
    for (let depth = 0; depth < 3; depth += 1) {
      deeplyNested = `-S ${JSON.stringify(deeplyNested)}`;
    }
    expect(isMutation("bash", { command: `env -S '${deeplyNested}'` })).toBe(false);
    deeplyNested = `-S ${JSON.stringify(deeplyNested)}`;
    expect(isMutation("bash", { command: `env -S '${deeplyNested}'` })).toBe(true);
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
