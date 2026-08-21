/**
 * Tests for the Rust unsafe-edge audit (issue #842 W7.2).
 *
 * The point of these is that the lane is not vacuous. It reports zero unsafe
 * sites today, and a gate that reports zero because it never looks is
 * indistinguishable from one that reports zero because the tree is clean —
 * so every rule here is exercised against a seeded fixture tree that really
 * does contain `unsafe`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  auditUnsafeEdges,
  codePortion,
  discoverCrates,
  hasSafetyNote,
  scanRustSource,
} from "./unsafe-edge-audit.mjs";

/**
 * Build a throwaway crate tree.
 * @param {Record<string, string>} files Repo-relative path → contents.
 * @returns {string} The tree root.
 */
function fixture(files) {
  const root = tempDirSync("unsafe-edge-");
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

const CARGO = '[package]\nname = "fixture"\n';

describe("scanRustSource", () => {
  test("finds every shape unsafe takes", () => {
    const sites = scanRustSource(
      [
        "unsafe fn raw() {}",
        "unsafe impl Send for T {}",
        "unsafe extern \"C\" { fn c(); }",
        "fn f() { unsafe { *p } }",
      ].join("\n"),
      "a.rs"
    );
    expect(sites).toHaveLength(4);
    expect(sites.map((s) => s.line)).toStrictEqual([1, 2, 3, 4]);
  });

  test("does not count the word inside an identifier or a comment", () => {
    const sites = scanRustSource(
      [
        "// this module avoids unsafe entirely",
        "fn unsafely_named() {}",
        "let unsafe_count = 0;",
      ].join("\n"),
      "a.rs"
    );
    expect(sites).toStrictEqual([]);
  });
});

describe("codePortion", () => {
  test("drops the trailing line comment", () => {
    expect(codePortion("let x = 1; // unsafe in prose")).toBe("let x = 1; ");
    expect(codePortion("let x = 1;")).toBe("let x = 1;");
  });
});

describe("hasSafetyNote", () => {
  const lines = [
    "// SAFETY: the pointer is non-null by construction.",
    "",
    "",
    "",
    "",
    "unsafe { *p }",
    "unsafe { *q }",
  ];

  test("accepts a note within the lookback window", () => {
    expect(hasSafetyNote(lines, 5)).toBe(true);
  });

  test("refuses a note that has scrolled out of the window", () => {
    expect(hasSafetyNote(lines, 6)).toBe(false);
  });

  test("accepts doc-comment spellings", () => {
    expect(hasSafetyNote(["/// SAFETY: ok", "unsafe {}"], 1)).toBe(true);
    expect(hasSafetyNote(["//! SAFETY: ok", "unsafe {}"], 1)).toBe(true);
  });
});

describe("discoverCrates", () => {
  test("finds crate roots and ignores build output", () => {
    const root = fixture({
      "crates/one/Cargo.toml": CARGO,
      "crates/one/src/lib.rs": "",
      "crates/one/target/debug/Cargo.toml": CARGO,
    });
    expect(discoverCrates(root)).toStrictEqual(["crates/one"]);
  });
});

describe("auditUnsafeEdges", () => {
  test("passes a clean tree whose ledger matches", () => {
    const root = fixture({
      "crates/one/Cargo.toml": CARGO,
      "crates/one/src/lib.rs": "pub fn safe() {}\n",
    });
    const result = auditUnsafeEdges({ root, ledger: { "crates/one": 0 } });
    expect(result.ok).toBe(true);
    expect(result.counts).toStrictEqual({ "crates/one": 0 });
  });

  test("fails an unsafe block with no SAFETY justification", () => {
    const root = fixture({
      "crates/one/Cargo.toml": CARGO,
      "crates/one/src/lib.rs": "pub fn f(p: *const u8) -> u8 { unsafe { *p } }\n",
    });
    const result = auditUnsafeEdges({ root, ledger: { "crates/one": 1 } });
    expect(result.ok).toBe(false);
    expect(result.findings.join("\n")).toContain("no `// SAFETY:`");
  });

  test("accepts a justified unsafe block that the ledger allows", () => {
    const root = fixture({
      "crates/one/Cargo.toml": CARGO,
      "crates/one/src/lib.rs":
        "// SAFETY: caller guarantees p is a live, aligned u8.\npub fn f(p: *const u8) -> u8 { unsafe { *p } }\n",
    });
    const result = auditUnsafeEdges({ root, ledger: { "crates/one": 1 } });
    expect(result.ok).toBe(true);
  });

  test("fails when the count rises above the ledger", () => {
    const root = fixture({
      "crates/one/Cargo.toml": CARGO,
      "crates/one/src/lib.rs":
        "// SAFETY: ok\npub fn f(p: *const u8) -> u8 { unsafe { *p } }\n",
    });
    const result = auditUnsafeEdges({ root, ledger: { "crates/one": 0 } });
    expect(result.ok).toBe(false);
    expect(result.findings.join("\n")).toContain("reviewed ledger bump");
  });

  test("fails when the count falls below the ledger — the ratchet must be tightened", () => {
    const root = fixture({
      "crates/one/Cargo.toml": CARGO,
      "crates/one/src/lib.rs": "pub fn safe() {}\n",
    });
    const result = auditUnsafeEdges({ root, ledger: { "crates/one": 2 } });
    expect(result.ok).toBe(false);
    expect(result.findings.join("\n")).toContain("Lower the ledger");
  });

  test("fails a crate that has no ledger entry at all", () => {
    const root = fixture({
      "crates/new/Cargo.toml": CARGO,
      "crates/new/src/lib.rs": "pub fn safe() {}\n",
    });
    const result = auditUnsafeEdges({ root, ledger: {} });
    expect(result.ok).toBe(false);
    expect(result.findings.join("\n")).toContain("has no entry");
  });

  test("fails a ledger entry naming a crate that no longer exists", () => {
    const root = fixture({ "crates/one/Cargo.toml": CARGO });
    const result = auditUnsafeEdges({
      root,
      ledger: { "crates/one": 0, "crates/gone": 3 },
    });
    expect(result.ok).toBe(false);
    expect(result.findings.join("\n")).toContain("stale entry");
  });
});

describe("the real repository", () => {
  test("every first-party crate is clean and ledgered", () => {
    // Not a fixture: this is the assertion that the shipped gate is green on
    // the tree as it stands, so a red run here means real Rust changed.
    const result = auditUnsafeEdges();
    expect(result.findings).toStrictEqual([]);
    expect(Object.keys(result.counts).toSorted()).toStrictEqual([
      "apps/web/iroh-wasm",
      "packages/tunnel/data-plane",
      "packages/tunnel/native",
    ]);
  });
});
