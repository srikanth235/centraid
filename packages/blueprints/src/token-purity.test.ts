import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BLUEPRINT_TOKEN_CONTRACT } from "@centraid/design";

import type { TokenPurityBudget } from "./token-purity-allowlist.js";
import {
  TOKEN_PURITY_ALLOWLIST,
  UNRESOLVED_VAR_DEBT,
} from "./token-purity-allowlist.js";

const appDir = path.join(path.resolve(import.meta.dirname, ".."), "apps");

/**
 * Custom-property namespaces owned by `packages/design`. An app that declares
 * one of these is shadowing the design system's own token, so its value wins
 * locally and the app stops tracking theme changes.
 */
const RESERVED_PREFIXES = [
  "--c-",
  "--t-",
  "--r-",
  "--sp-",
  "--bg-",
  "--text-",
] as const;

const CONTRACT_PROPS = new Set<string>(BLUEPRINT_TOKEN_CONTRACT);

// `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`. Longest alternative first so a
// 6-digit literal is never reported as a 3-digit one plus trailing junk.
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/gu;
const FUNCTIONAL = /\b(?:rgba?|hsla?)\(/gu;
const FONT_FAMILY = /(?:^|[;{])\s*font-family\s*:(?<value>[^;}]*)/gmu;
const CUSTOM_PROP_DECL = /(?:^|[;{])\s*(?<name>--[A-Za-z0-9_-]+)\s*:/gmu;
const VAR_REFERENCE = /var\(--[A-Za-z0-9_-]+\)/gu;
const FONT_KEYWORDS = /inherit|initial|unset|revert/gu;

function listModuleCss(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) listModuleCss(full, out);
    else if (entry.endsWith(".module.css")) out.push(full);
  }
  return out;
}

/**
 * Count the violations in one stylesheet. Comments are stripped first so a
 * documented "was #fff" note doesn't read as a live literal. Note that
 * `color-mix(in oklab, #fff 20%, var(--bg))` is still a violation: the hex
 * endpoint is matched regardless of the function wrapping it.
 */
function scan(source: string): TokenPurityBudget {
  const css = source.replace(/\/\*[\s\S]*?\*\//gu, "");

  const fontFamily = [...css.matchAll(FONT_FAMILY)].filter((match) => {
    // A value assembled purely out of `var()` (plus CSS-wide keywords,
    // whitespace, and commas) is exactly the compliant form.
    const residue = (match.groups?.value ?? "")
      .replace(VAR_REFERENCE, "")
      .replace(FONT_KEYWORDS, "")
      .replace(/[\s,]/gu, "");
    return residue !== "";
  }).length;

  const customProps = [
    ...new Set(
      [...css.matchAll(CUSTOM_PROP_DECL)]
        .map((match) => match.groups?.name ?? "")
        .filter(
          (name) =>
            CONTRACT_PROPS.has(name) ||
            RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))
        )
    ),
  ].sort();

  return {
    hex: [...css.matchAll(HEX)].length,
    functional: [...css.matchAll(FUNCTIONAL)].length,
    fontFamily,
    customProps,
  };
}

const EMPTY: TokenPurityBudget = {
  hex: 0,
  functional: 0,
  fontFamily: 0,
  customProps: [],
};

describe("blueprint app CSS token purity", () => {
  const files = listModuleCss(appDir).sort();
  const actual = new Map<string, TokenPurityBudget>();
  for (const file of files) {
    actual.set(path.relative(appDir, file), scan(readFileSync(file, "utf8")));
  }

  it("finds the blueprint stylesheets it claims to police", () => {
    // Guards against the walker silently matching nothing (a green suite that
    // asserts nothing is the failure mode this whole test exists to prevent).
    expect(files.length).toBeGreaterThan(50);
  });

  it("declares no colors, fonts, or design tokens beyond the ratchet", () => {
    for (const [rel, found] of actual) {
      const budget = TOKEN_PURITY_ALLOWLIST[rel] ?? EMPTY;
      expect(
        found,
        `${rel}: token-purity violations changed. If you cleaned this file up, ` +
          "shrink or delete its entry in token-purity-allowlist.ts. If you " +
          "added a literal, use a var(--token) from @centraid/design instead."
      ).toStrictEqual({
        hex: budget.hex,
        functional: budget.functional,
        fontFamily: budget.fontFamily,
        customProps: [...budget.customProps],
      });
    }
  });

  it("never inks an --accent-deep fill with the theme-stable --on-accent", () => {
    // `--accent-deep` flips across the ramp (deepened under light ink on the
    // light theme, lifted under dark ink on the dark one, #686 F3), so the ink
    // it carries must flip with it: `--text-inv`. `--on-accent` is the FIXED
    // white for surfaces that are dark in both themes (a photo, a scrim, a
    // saturated `--accent` badge) — pairing it with `--accent-deep` reads as
    // white-on-near-white the moment the dark theme lifts the fill. The kit's
    // own header contract states this pair; this test holds apps to it.
    const offenders: string[] = [];
    for (const file of files) {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
      for (const match of css.matchAll(/\{(?<body>[^{}]*)\}/gu)) {
        const body = match.groups?.body ?? "";
        if (
          /background(?:-color)?\s*:\s*var\(--accent-deep\)/u.test(body) &&
          /(?:^|;)\s*color\s*:\s*var\(--on-accent\)/u.test(body)
        ) {
          offenders.push(path.relative(appDir, file));
        }
      }
    }
    expect(
      offenders,
      "these rules fill with --accent-deep but ink with --on-accent; use " +
        "var(--text-inv), which flips with the fill"
    ).toStrictEqual([]);
  });

  it("resolves every fallback-less var() an app references", () => {
    // A `var(--x)` with no fallback that names nothing declared is invalid at
    // computed-value time: the declaration is dropped and the property falls
    // back to inherited/initial. Nothing throws, nothing logs — the rule just
    // silently does not apply, which is how a stale rename survives review.
    // An app may resolve a name from the contract, from kit.css (served to
    // every app surface), or from anywhere in its OWN stylesheets, since an
    // app's Chrome declares tokens its components inherit.
    const kitDeclared = new Set(
      [
        ...readFileSync(
          path.join(appDir, "..", "..", "design", "kit", "kit.css"),
          "utf8"
        ).matchAll(CUSTOM_PROP_DECL),
      ].map((m) => m.groups?.name ?? "")
    );
    const unresolved: string[] = [];
    for (const app of new Set(
      files.map((f) => path.relative(appDir, f).split(path.sep)[0])
    )) {
      const own = files.filter(
        (f) => path.relative(appDir, f).split(path.sep)[0] === app
      );
      const sources = own.map((f) =>
        readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "")
      );
      const declared = new Set(
        sources.flatMap((css) =>
          [...css.matchAll(CUSTOM_PROP_DECL)].map((m) => m.groups?.name ?? "")
        )
      );
      own.forEach((file, i) => {
        const source = sources[i] ?? "";
        for (const m of source.matchAll(
          /var\(\s*(?<name>--[A-Za-z0-9_-]+)\s*(?<next>[,)])/gu
        )) {
          const name = m.groups?.name ?? "";
          if (m.groups?.next === ",") continue; // an explicit fallback is a choice
          if (
            CONTRACT_PROPS.has(name) ||
            declared.has(name) ||
            kitDeclared.has(name)
          ) {
            continue;
          }
          unresolved.push(`${path.relative(appDir, file)} -> ${name}`);
        }
      });
    }
    expect(
      [...new Set(unresolved)].sort(),
      "a fallback-less var() naming nothing declared silently drops its " +
        "declaration; declare the token, use a contract name, or give it a fallback"
    ).toStrictEqual(UNRESOLVED_VAR_DEBT);
  });

  it("keeps the allowlist free of entries for files that no longer exist", () => {
    for (const rel of Object.keys(TOKEN_PURITY_ALLOWLIST)) {
      expect(
        actual.has(rel),
        `token-purity-allowlist.ts has a stale entry for ${rel}`
      ).toBe(true);
    }
  });
});
