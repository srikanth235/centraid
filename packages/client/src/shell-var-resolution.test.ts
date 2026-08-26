/**
 * Every fallback-less `var()` in the shell's CSS resolves (#686).
 * Unresolvable `var()` with no fallback invalidates the declaration silently.
 * Fine when the name is in `SHELL_TOKEN_CONTRACT`, declared in shell CSS, or
 * in `RUNTIME_DECLARED` (set from TSX). A reference WITH a fallback is never
 * reported — the author chose the miss.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { SHELL_TOKEN_CONTRACT } from "@centraid/design";
import {
  declaredCustomProps,
  stripCssComments,
  unresolvedVarRefs,
} from "@centraid/design/css-vars";

const SRC = path.resolve(import.meta.dirname);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo"]);

/**
 * Names TSX sets inline with no stylesheet default. Adding one claims both
 * halves (checked below). Do not list names that also have a CSS default —
 * that would hide a later default deletion.
 */
const RUNTIME_DECLARED: Readonly<Record<string, string>> = {
  // Per-render swatch; no CSS default — the ring is meaningless until a colour is chosen.
  "--profile-accent": "react/screens/SettingsProfileScreen.tsx",
};

function walk(dir: string, match: (f: string) => boolean, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, match, out);
    else if (match(full)) out.push(full);
  }
  return out;
}

const cssFiles = walk(SRC, (f) => f.endsWith(".css")).sort();
const sources = new Map(
  cssFiles.map((f) => [f, stripCssComments(readFileSync(f, "utf8"))])
);

const cssDeclared = new Set(
  [...sources.values()].flatMap((css) => declaredCustomProps(css))
);
const resolved = new Set<string>([
  ...SHELL_TOKEN_CONTRACT,
  ...Object.keys(RUNTIME_DECLARED),
  ...cssDeclared,
]);

describe("shell CSS custom-property resolution", () => {
  test("finds the stylesheets it claims to police", () => {
    // A walker matching nothing is a green suite asserting nothing.
    expect(cssFiles.length).toBeGreaterThan(80);
    expect(SHELL_TOKEN_CONTRACT.length).toBeGreaterThan(50);
  });

  test("resolves every fallback-less var() the shell references", () => {
    const unresolved: string[] = [];
    for (const [file, css] of sources) {
      for (const name of unresolvedVarRefs(css, resolved)) {
        unresolved.push(`${path.relative(SRC, file)} -> ${name}`);
      }
    }
    expect(
      unresolved.sort(),
      "a fallback-less var() naming nothing declared silently drops its " +
        "declaration. Use a SHELL_TOKEN_CONTRACT name (packages/design/src/" +
        "contract.ts), declare the property, give it a fallback, or — if TSX " +
        "sets it inline — add it to RUNTIME_DECLARED above with the component " +
        "that writes it."
    ).toStrictEqual([]);
  });

  test("keeps every runtime allowlist entry earned", () => {
    const findings: string[] = [];
    for (const [name, owner] of Object.entries(RUNTIME_DECLARED)) {
      const source = readFileSync(path.join(SRC, owner), "utf8");
      if (
        !source.includes(`setProperty("${name}"`) &&
        !source.includes(`"${name}":`)
      ) {
        findings.push(`${name}: ${owner} no longer sets it`);
      }
      if (cssDeclared.has(name)) {
        findings.push(`${name}: CSS declares it, so the entry is redundant`);
      }
    }
    expect(
      findings,
      "RUNTIME_DECLARED entries must be both true (the named component sets " +
        "the property) and necessary (no stylesheet declares it); an entry " +
        "that is neither hides a real phantom"
    ).toStrictEqual([]);
  });
});
