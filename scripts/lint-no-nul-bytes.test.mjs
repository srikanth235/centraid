#!/usr/bin/env node
// The NUL-byte gate's own seeded-red case (#931 item 2).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import {
  ALLOWED,
  BINARY_EXTS,
  isScanned,
  nulPositions,
  scan,
} from "./lint-no-nul-bytes.mjs";

const root = path.resolve(import.meta.dirname, "..");
const NUL = String.fromCharCode(0);
const bytes = (text) => Buffer.from(text, "utf8");

test("SEEDED RED: a source file with a raw NUL fails, the same file with \\0 passes", () => {
  const withRaw = `const key = \`\${a}${NUL}\${b}\`;\n`;
  const failures = scan(["desktop/electron/src/main/ipc-core.ts"], () =>
    bytes(withRaw)
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /ipc-core\.ts: 1 raw NUL byte\(s\) at 1:18/u);
  assert.match(failures[0], /Write \\0 instead/u);

  // The fix: the two-character escape is the same byte to the program and
  // ordinary text to git.
  // Assembled rather than written inline: a literal `${` in a plain string is
  // itself a lint error, and the point is the bytes, not the syntax.
  const interp = (name) => `\${${name}}`;
  const escaped = `const key = \`${interp("a")}\\0${interp("b")}\`;\n`;
  assert.deepEqual(
    scan(["desktop/electron/src/main/ipc-core.ts"], () => bytes(escaped)),
    []
  );
});

test("every NUL is located, not just the first", () => {
  assert.deepEqual(nulPositions(bytes(`a${NUL}b\nc${NUL}`)), [
    { line: 1, column: 2 },
    { line: 2, column: 2 },
  ]);
  assert.deepEqual(nulPositions(bytes("clean")), []);
});

test("binary extensions are skipped and text ones are not", () => {
  for (const ext of BINARY_EXTS) {
    assert.equal(isScanned(`some/file${ext}`), false, ext);
  }
  for (const file of [
    "desktop/electron/src/main/ipc-core.ts",
    "scripts/lint-aria-labels.mjs",
    "docs/logs.md",
    "tests/claims.json",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(isScanned(file), true, file);
  }
  // The golden corpus binaries and the screen fixtures are the reason `.gz`
  // and `.bin` are on the list at all.
  assert.equal(isScanned("contracts/golden/issue-929/vault.db.gz"), false);
  assert.equal(isScanned("contracts/screens/home/content.bin"), false);
});

test("the allowlist is one named path, not a folder", () => {
  assert.deepEqual(ALLOWED, [
    "receipts/issue-573-toolchain-opinions-one-shot.md",
  ]);
  assert.equal(isScanned(ALLOWED[0]), false);
  // A receipt that has not merged yet is still scanned, so the exemption
  // cannot become a doorway.
  assert.equal(
    isScanned("receipts/issue-931-gates-that-enforce-nowhere.md"),
    true
  );
});

test("the gate is green on this tree", () => {
  const run = spawnSync(
    process.execPath,
    [path.join(root, "scripts/lint-no-nul-bytes.mjs")],
    {
      cwd: root,
      encoding: "utf8",
    }
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /none carrying a raw NUL/u);
});
