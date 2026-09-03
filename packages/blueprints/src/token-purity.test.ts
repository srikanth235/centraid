import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BLUEPRINT_TOKEN_CONTRACT } from "@centraid/design";
import {
  declaredCustomProps,
  stripCssComments,
  unresolvedVarRefs,
} from "@centraid/design/css-vars";

import type { TokenPurityBudget } from "./token-purity-allowlist.js";
import {
  TOKEN_PURITY_ALLOWLIST,
  UNRESOLVED_VAR_DEBT,
} from "./token-purity-allowlist.js";

const appDir = path.join(path.resolve(import.meta.dirname, ".."), "apps");

const RESERVED_PREFIXES = [
  "--c-",
  "--t-",
  "--r-",
  "--sp-",
  "--bg-",
  "--text-",
] as const;

const CONTRACT_PROPS = new Set<string>(BLUEPRINT_TOKEN_CONTRACT);

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

function scan(source: string): TokenPurityBudget {
  const css = source.replace(/\/\*[\s\S]*?\*\//gu, "");

  const fontFamily = [...css.matchAll(FONT_FAMILY)].filter((match) => {
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

  it("publishes fill ink through the canonical inverse role", () => {
    const css = files
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//gu, "");
    expect(css).not.toContain("--text-inv, white");
  });

  it("resolves every fallback-less var() an app references", () => {
    const kitDeclared = declaredCustomProps(
      readFileSync(
        path.join(appDir, "..", "..", "design", "src", "elements", "kit.css"),
        "utf8"
      )
    );
    const unresolved: string[] = [];
    for (const app of new Set(
      files.map((f) => path.relative(appDir, f).split(path.sep)[0])
    )) {
      const own = files.filter(
        (f) => path.relative(appDir, f).split(path.sep)[0] === app
      );
      const sources = own.map((f) => stripCssComments(readFileSync(f, "utf8")));
      const resolved = new Set([
        ...CONTRACT_PROPS,
        ...kitDeclared,
        ...sources.flatMap((css) => declaredCustomProps(css)),
      ]);
      own.forEach((file, i) => {
        for (const name of unresolvedVarRefs(sources[i] ?? "", resolved)) {
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
