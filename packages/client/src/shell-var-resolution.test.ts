/**
 * Every fallback-less `var()` in the shell's CSS resolves to something (#686).
 *
 * `packages/blueprints/src/token-purity.test.ts` gained this gate for blueprint
 * apps earlier in #686 — and only for blueprint apps. The shell was never
 * scanned, and carried 13 unresolvable names, among them four `--ink-*`
 * phantoms (`--ink-1`, …) that the `.design-sync/conventions.md` staging notes
 * had explicitly flagged as "never emitted" and that #677's `--ink-*` →
 * `--text-*` rename then carried forward verbatim as `--text-1`. The failure is
 * silent by construction: an unresolvable `var()` with no fallback makes the
 * whole declaration invalid at computed-value time, so the property falls back
 * to inherited/initial with nothing thrown and nothing logged. The builder's
 * three language dots had been painting no background at all.
 *
 * Resolution rules — a reference is fine when the name is:
 *   1. in `SHELL_TOKEN_CONTRACT` (what `toCss()` injects at boot);
 *   2. declared anywhere in the shell's own CSS (a component may declare a
 *      knob its descendants read, and the cascade does not respect file
 *      boundaries); or
 *   3. in `RUNTIME_DECLARED` below — set from TSX via an inline `style` prop or
 *      `setProperty()`, so no stylesheet declares it and none should.
 *
 * A reference WITH a fallback is never reported: the author chose what happens
 * on the miss, so nothing is silent.
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
 * Custom properties the shell sets from TypeScript rather than CSS, with the
 * component that sets each one. These are legitimately absent from every
 * stylesheet: the value is per-instance (a chosen swatch, a row's hue, an
 * animation index), which is exactly what an inline `style` prop is for.
 *
 * Adding a name here is a claim that some TSX writes it, and that no
 * stylesheet does. Both halves of that claim are checked below, so neither a
 * stale entry nor a redundant one can quietly widen the gate.
 *
 * Deliberately minimal. The shell sets a dozen other properties inline
 * (`--onb-accent`, `--route-accent`, `--pack-c`, `--tk-hue`, `--depth`,
 * `--stage-i`, …) and every one of them ALSO carries a CSS default on the
 * element that reads it, so they resolve by rule 2 and want no entry here —
 * listing them would mean the gate stops noticing if that default is deleted.
 */
const RUNTIME_DECLARED: Readonly<Record<string, string>> = {
  // Settings → You, profile group: the avatar ring, focus state, and save affordance all
  // take the swatch the user is currently pointing at, before anything is
  // saved, so the value only exists per render. No CSS default on purpose —
  // the ring has no meaning until a colour is chosen.
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
    // A walker that silently matches nothing is a green suite asserting
    // nothing — the exact failure this gate exists to prevent.
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
