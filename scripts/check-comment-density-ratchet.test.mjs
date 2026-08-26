// Fail-path proof for the #861 comment-density enforcement trio.
//
// Drives the ratchet, the block bound, and the comment-only prover against
// synthetic trees through their injectable roots. Uses `mkdtempSync` rather
// than `@centraid/test-kit`'s `tempDir()`: that module registers a vitest
// `afterAll` at import time and throws under `node --test`, which is the runner
// this lane uses. Same pattern as scripts/lint-css-classes.test.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
// oxlint-disable-next-line no-restricted-imports -- (#781) node --test lane: the kit's tempDir() registers a vitest afterAll at import time and throws here; removal is registered at creation via t.after below.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  measureTree,
  reconcileRatchet,
  verifyRatchet,
} from "./check-comment-density-ratchet.mjs";
import { commentOnlyDiff } from "./comment-only-diff.mjs";
import { lintCommentBlocks } from "./lint-comment-blocks.mjs";

/** Build a throwaway root containing `files` (relative path → contents). */
function fixture(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), "centraid-comment-density-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return root;
}

const codeLine = (i) => `const value${i} = ${i};`;
const commentLine = "// Obligation stated for the next editor, in this file.";

/** 45 non-blank lines, roughly half of them comment — far over the 15% cap. */
function commentHeavy() {
  const lines = [];
  for (let i = 0; i < 30; i += 1) {
    lines.push(codeLine(i));
    if (i % 2 === 0) lines.push(commentLine);
  }
  return `${lines.join("\n")}\n`;
}

/** 61 non-blank lines with one comment — comfortably under the cap. */
function commentLight() {
  const lines = [commentLine];
  for (let i = 0; i < 60; i += 1) lines.push(codeLine(i));
  return `${lines.join("\n")}\n`;
}

const measured = (root, files) => measureTree({ root, files }).measured;

test("RED: a pinned file whose comment share rises fails verification", (t) => {
  const root = fixture(t, { "src/a.ts": commentHeavy() });
  const baseline = { allowlist: {}, files: { "src/a.ts": [1, 100] } };
  const failures = verifyRatchet(baseline, measured(root, ["src/a.ts"]));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^src\/a\.ts — comment share rose 1\.00% -> \d/u);
  assert.match(failures[0], /hand-raise the pin/u);
});

test("a lowered share passes, and --write lowers the pin to it", (t) => {
  const root = fixture(t, { "src/a.ts": commentLight() });
  const baseline = { allowlist: {}, files: { "src/a.ts": [90, 100] } };
  const now = measured(root, ["src/a.ts"]);
  assert.deepEqual(verifyRatchet(baseline, now), []);

  const { next, refused } = reconcileRatchet(baseline, now);
  assert.deepEqual(refused, []);
  const pin = next.files["src/a.ts"];
  assert.ok(pin[0] * 100 < 15 * pin[1], "re-pinned below the cap");
  assert.ok(pin[0] * 100 < 90 * pin[1], "re-pinned below the old 90% pin");
});

test("--write never raises a pin, and says what it refused", (t) => {
  const root = fixture(t, { "src/a.ts": commentHeavy() });
  const baseline = { allowlist: {}, files: { "src/a.ts": [1, 100] } };
  const { next, refused } = reconcileRatchet(
    baseline,
    measured(root, ["src/a.ts"])
  );
  assert.deepEqual(next.files["src/a.ts"], [1, 100]);
  assert.equal(refused.length, 1);
  assert.match(refused[0], /^src\/a\.ts — pinned at 1\.00%/u);
});

test("--write prunes a pinned file that no longer exists on disk", (t) => {
  const root = fixture(t, { "src/a.ts": commentLight() });
  const baseline = { allowlist: {}, files: { "src/gone.ts": [1, 100] } };
  const now = measured(root, ["src/a.ts"]);
  assert.deepEqual(verifyRatchet(baseline, now), []);
  assert.deepEqual(Object.keys(reconcileRatchet(baseline, now).next.files), [
    "src/a.ts",
  ]);
});

test("an unpinned file over the cap fails only once it is long enough", (t) => {
  const root = fixture(t, {
    "src/long.ts": commentHeavy(),
    "src/short.ts": `${commentLine}\n${codeLine(0)}\n`,
    "src/light.ts": commentLight(),
  });
  const baseline = { allowlist: {}, files: {} };
  const now = measured(root, ["src/light.ts", "src/long.ts", "src/short.ts"]);
  const failures = verifyRatchet(baseline, now);
  assert.equal(failures.length, 1);
  assert.match(
    failures[0],
    /^src\/long\.ts — unpinned file at .* exceeds the 15% cap/u
  );
});

test("an allowlisted file over the cap passes", (t) => {
  const root = fixture(t, { "src/registry.ts": commentHeavy() });
  const baseline = {
    allowlist: {
      "src/registry.ts": "prose registry — the prose IS the payload",
    },
    files: {},
  };
  assert.deepEqual(
    verifyRatchet(baseline, measured(root, ["src/registry.ts"])),
    []
  );
});

test("block lint flags an 11-line block and tolerates a 14-line file header", (t) => {
  const header = Array.from(
    { length: 14 },
    (_, i) => `// Orientation line ${i}.`
  ).join("\n");
  const wall = Array.from({ length: 11 }, (_, i) => `// Wall line ${i}.`).join(
    "\n"
  );
  const root = fixture(t, {
    "src/header.ts": `${header}\nexport const a = 1;\n`,
    "src/wall.ts": `export const a = 1;\n${wall}\nexport const b = 2;\n`,
  });
  assert.deepEqual(
    lintCommentBlocks({ root, files: ["src/header.ts", "src/wall.ts"] }),
    ["src/wall.ts:2  11-line block (limit 10)"]
  );
});

test("block lint skips a file the ratchet allowlist names", (t) => {
  const wall = Array.from({ length: 11 }, (_, i) => `// Wall ${i}.`).join("\n");
  const root = fixture(t, {
    "src/wall.ts": `export const a = 1;\n${wall}\nexport const b = 2;\n`,
  });
  assert.deepEqual(
    lintCommentBlocks({
      root,
      files: ["src/wall.ts"],
      allowlist: { "src/wall.ts": "prose is the payload" },
    }),
    []
  );
});

const SOURCE =
  "export const value = 1;\n// Old narration.\nexport function run() {\n  return value;\n}\n";

function gitFixture(t, contents) {
  const root = fixture(t, { "src/a.ts": contents });
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.email=gate@centraid.test",
        "-c",
        "user.name=gate",
        "-c",
        "core.hooksPath=",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { stdio: "pipe" }
    );
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return root;
}

test("comment-only-diff separates a comment edit from a code edit", (t) => {
  const commentEdit = gitFixture(t, SOURCE);
  writeFileSync(
    path.join(commentEdit, "src/a.ts"),
    SOURCE.replace("// Old narration.", "// Value is the seed (#861).")
  );
  assert.deepEqual(commentOnlyDiff({ root: commentEdit, ref: "HEAD" }), [
    { file: "src/a.ts", commentOnly: true, reason: "" },
  ]);

  const codeEdit = gitFixture(t, SOURCE);
  writeFileSync(
    path.join(codeEdit, "src/a.ts"),
    SOURCE.replace("value = 1", "value = 2")
  );
  assert.deepEqual(commentOnlyDiff({ root: codeEdit, ref: "HEAD" }), [
    { file: "src/a.ts", commentOnly: false, reason: "code tokens differ" },
  ]);
});

test("comment-only-diff calls an added file a code change", (t) => {
  const root = gitFixture(t, SOURCE);
  writeFileSync(path.join(root, "src/b.ts"), "export const b = 2;\n");
  execFileSync("git", ["-C", root, "add", "-A"], { stdio: "pipe" });
  assert.deepEqual(commentOnlyDiff({ root, ref: "HEAD" }), [
    { file: "src/b.ts", commentOnly: false, reason: "added/deleted" },
  ]);
});
