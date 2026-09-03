import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  auditUnsafeEdges,
  codePortion,
  discoverCrates,
  hasSafetyNote,
  scanRustSource,
} from "./unsafe-edge-audit.mjs";

const FIXTURE_ROOT = path.join(tmpdir(), "centraid-unsafe-edge-fixtures");
const CARGO = '[package]\nname = "fixture"\n';

function fixture(name, files) {
  const root = path.join(FIXTURE_ROOT, name);
  rmSync(root, { recursive: true, force: true });
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

test.after(() => rmSync(FIXTURE_ROOT, { recursive: true, force: true }));

test("scanRustSource finds every shape unsafe takes", () => {
  const sites = scanRustSource(
    [
      "unsafe fn raw() {}",
      "unsafe impl Send for T {}",
      'unsafe extern "C" { fn c(); }',
      "fn f() { unsafe { *p } }",
    ].join("\n"),
    "a.rs"
  );
  assert.equal(sites.length, 4);
  assert.deepEqual(
    sites.map((s) => s.line),
    [1, 2, 3, 4]
  );
});

test("scanRustSource ignores the word inside an identifier or a comment", () => {
  const sites = scanRustSource(
    [
      "// this module avoids unsafe entirely",
      "fn unsafely_named() {}",
      "let unsafe_count = 0;",
    ].join("\n"),
    "a.rs"
  );
  assert.deepEqual(sites, []);
});

test("codePortion drops the trailing line comment", () => {
  assert.equal(codePortion("let x = 1; // unsafe in prose"), "let x = 1; ");
  assert.equal(codePortion("let x = 1;"), "let x = 1;");
});

test("hasSafetyNote accepts a note inside the lookback window and rejects one outside", () => {
  const lines = [
    "// SAFETY: the pointer is non-null by construction.",
    "",
    "",
    "",
    "",
    "unsafe { *p }",
    "unsafe { *q }",
  ];
  assert.equal(hasSafetyNote(lines, 5), true);
  assert.equal(hasSafetyNote(lines, 6), false);
});

test("hasSafetyNote accepts doc-comment spellings", () => {
  assert.equal(hasSafetyNote(["/// SAFETY: ok", "unsafe {}"], 1), true);
  assert.equal(hasSafetyNote(["//! SAFETY: ok", "unsafe {}"], 1), true);
});

test("discoverCrates finds crate roots and ignores build output", () => {
  const root = fixture("discover", {
    "crates/one/Cargo.toml": CARGO,
    "crates/one/src/lib.rs": "",
    "crates/one/target/debug/Cargo.toml": CARGO,
  });
  assert.deepEqual(discoverCrates(root), ["crates/one"]);
});

test("a clean tree whose ledger matches passes", () => {
  const root = fixture("clean", {
    "crates/one/Cargo.toml": CARGO,
    "crates/one/src/lib.rs": "pub fn safe() {}\n",
  });
  const result = auditUnsafeEdges({ root, ledger: { "crates/one": 0 } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, { "crates/one": 0 });
});

test("an unsafe block with no SAFETY justification fails", () => {
  const root = fixture("unjustified", {
    "crates/one/Cargo.toml": CARGO,
    "crates/one/src/lib.rs": "pub fn f(p: *const u8) -> u8 { unsafe { *p } }\n",
  });
  const result = auditUnsafeEdges({ root, ledger: { "crates/one": 1 } });
  assert.equal(result.ok, false);
  assert.match(result.findings.join("\n"), /no `\/\/ SAFETY:`/u);
});

test("a justified unsafe block within the ledger passes", () => {
  const root = fixture("justified", {
    "crates/one/Cargo.toml": CARGO,
    "crates/one/src/lib.rs":
      "// SAFETY: caller guarantees p is a live, aligned u8.\npub fn f(p: *const u8) -> u8 { unsafe { *p } }\n",
  });
  assert.equal(
    auditUnsafeEdges({ root, ledger: { "crates/one": 1 } }).ok,
    true
  );
});

test("a count above the ledger fails — new unsafe needs a reviewed bump", () => {
  const root = fixture("above", {
    "crates/one/Cargo.toml": CARGO,
    "crates/one/src/lib.rs":
      "// SAFETY: ok\npub fn f(p: *const u8) -> u8 { unsafe { *p } }\n",
  });
  const result = auditUnsafeEdges({ root, ledger: { "crates/one": 0 } });
  assert.equal(result.ok, false);
  assert.match(result.findings.join("\n"), /reviewed ledger bump/u);
});

test("a count below the ledger fails — the ratchet must be tightened", () => {
  const root = fixture("below", {
    "crates/one/Cargo.toml": CARGO,
    "crates/one/src/lib.rs": "pub fn safe() {}\n",
  });
  const result = auditUnsafeEdges({ root, ledger: { "crates/one": 2 } });
  assert.equal(result.ok, false);
  assert.match(result.findings.join("\n"), /Lower the ledger/u);
});

test("a crate with no ledger entry at all fails", () => {
  const root = fixture("unledgered", {
    "crates/new/Cargo.toml": CARGO,
    "crates/new/src/lib.rs": "pub fn safe() {}\n",
  });
  const result = auditUnsafeEdges({ root, ledger: {} });
  assert.equal(result.ok, false);
  assert.match(result.findings.join("\n"), /has no entry/u);
});

test("a ledger entry naming a crate that no longer exists fails", () => {
  const root = fixture("stale", { "crates/one/Cargo.toml": CARGO });
  const result = auditUnsafeEdges({
    root,
    ledger: { "crates/one": 0, "crates/gone": 3 },
  });
  assert.equal(result.ok, false);
  assert.match(result.findings.join("\n"), /stale entry/u);
});

test("the real repository is clean and fully ledgered", () => {
  const result = auditUnsafeEdges();
  assert.deepEqual(result.findings, []);
  assert.deepEqual(Object.keys(result.counts).toSorted(), [
    "apps/web/iroh-wasm",
    "packages/tunnel/data-plane",
    "packages/tunnel/native",
  ]);
});
