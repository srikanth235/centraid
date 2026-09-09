// The generated file is pinned here, and the tree is asserted to match it: a
// law path added to a pack with no owner is a law path the host does not
// protect, which is exactly the gap generation closes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { CODEOWNERS_PATH, OWNER, lawPaths, main, render, status } from "./codeowners.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

test("generation is one line per law glob, sorted, with a header saying it is generated", () => {
  const text = render(["b/**", "a.md", "b/**"]);
  const lines = text.split("\n");
  assert.match(lines[0], /^# GENERATED/u);
  assert.ok(text.includes("codeowners.mjs --write"), "the header names how to regenerate it");
  assert.ok(text.includes(".governance/law/packs/*.json"), "and what it is generated from");
  assert.deepEqual(
    lines.filter((line) => line !== "" && !line.startsWith("#")),
    [`a.md ${OWNER}`, `b/** ${OWNER}`],
    "duplicates collapse and the order is bytewise"
  );
  assert.ok(text.endsWith("\n"));
});

test("the checked-in CODEOWNERS is what the packs' law estate generates", () => {
  assert.equal(readFileSync(path.join(ROOT, CODEOWNERS_PATH), "utf8"), render());
  const state = status();
  assert.equal(state.inSync, true);
  assert.equal(state.paths, lawPaths().length);
});

test("every law path the packs declare owns itself, CODEOWNERS included", () => {
  const globs = lawPaths();
  for (const glob of [".governance/**", "CONSTITUTION.md", CODEOWNERS_PATH]) {
    assert.ok(globs.includes(glob), `${glob} left the law estate`);
  }
});

test("--check is silent about a tree in sync and exits 1 on drift", (t) => {
  const written = [];
  t.mock.method(process.stdout, "write", (chunk) => {
    written.push(chunk);
    return true;
  });
  assert.equal(main(["--check"]), 0);
  assert.match(written.join(""), /in sync \(\d+ law paths\)/u);
});
