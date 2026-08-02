// The `--t-*` role-parity law (#686).
//
//   Size and line-height may diverge per emitter. Family and weight may not.
//
// `toCss()` (the shell) and `toBlueprintCss()` (sandboxed app surfaces) both
// publish the same `--t-<role>` spellings. A shell and an app pane can
// legitimately want different optical sizes — different viewing distance,
// different density — which is why the two scales in `typography.ts` carry
// different numbers on purpose. But if `--t-tiny` is mono on one surface and
// sans on the other, the NAME has stopped carrying meaning: a developer
// reading `font: var(--t-tiny)` cannot know what they will get.
//
// So this file gates the two facets that make a role a role — the face and the
// weight — and deliberately does not gate the two that are surface-local.
//
// Family is compared by GENUS (the generic family the stack ends in), not by
// custom-property name or stack string. The two emitters legitimately spell
// the same role differently (`--font-display` vs `--font-title`) and ship
// different concrete stacks for the same genus (the blueprint layer is
// sandboxed and loads no fonts). What must not differ is sans vs mono vs serif.

import { describe, expect, test } from "vitest";

import { toBlueprintCss } from "./blueprint.js";
import { toCss } from "./css.js";

/**
 * Roles that are KNOWN to break the law, each with the reason it has not been
 * fixed. Same ratchet contract as `token-purity-allowlist.ts` in
 * `packages/blueprints`: an entry is asserted to STILL diverge, so fixing the
 * role turns the suite red until the entry is deleted in the same change. The
 * list may only ever get shorter.
 */
const ROLE_PARITY_ALLOWLIST: Readonly<Record<string, string>> = {
  // Measured on both sides (#686, and see docs/decisions.md). The two surfaces
  // bind this spelling to two genuinely different roles, and neither side can
  // move without visible collateral:
  //
  //  * SHELL — 5 sites, 0 of them eyebrows: two native `<select>`s, a
  //    Save/Cancel pair plus a pencil glyph, a pill holding an agent title,
  //    and the "Working"/"Ready" telemetry strip. Mobile adds 7 `t("tiny")`
  //    consumers of which 5 are prose (including an error message) and the 2
  //    that ARE eyebrows already hand-patch the family to mono. Forcing mono
  //    here would monospace `<select>` chrome and prose, which DESIGN.md's
  //    "prose is not [mono]" clause forbids, and would improve zero eyebrows.
  //  * BLUEPRINT — 12 sites, 10 of them uppercase + `--tracking-eyebrow`
  //    eyebrows at 0.6rem (9.6px). Forcing sans here would de-monospace the
  //    app surfaces' entire eyebrow idiom, which is the "Mono is the
  //    signature" rule.
  //
  // The clean fix is NOT to pick a winner: it is to give the eyebrow role its
  // own name, which is open product decision (b) in docs/decisions.md and new
  // vocabulary rather than a value change. Until that lands, this is one
  // spelling carrying two roles and it is recorded, not hidden.
  "--t-tiny": "shell control label (sans/500) vs blueprint eyebrow (mono/600)",
};

interface Shorthand {
  weight: string;
  size: string;
  lineHeight: string;
  familyVar: string;
}

function rootProps(css: string): Record<string, string> {
  const start = css.indexOf(":root {");
  const body = start < 0 ? "" : css.slice(start, css.indexOf("\n}", start));
  const out: Record<string, string> = {};
  for (const match of body.matchAll(
    /^\s*(?<prop>--[\w-]+):\s*(?<value>.+);$/gmu
  )) {
    const { prop, value } = match.groups ?? {};
    if (prop && value) out[prop] = value;
  }
  return out;
}

/** `600 20px/26px var(--font-display)` → its four facets. */
function parseShorthand(value: string): Shorthand | null {
  const match =
    /^(?<weight>\d{3}) (?<size>[^ ]+)\/(?<lineHeight>[^ ]+) var\((?<familyVar>--[\w-]+)\)$/u.exec(
      value
    );
  const { familyVar, lineHeight, size, weight } = match?.groups ?? {};
  return familyVar && lineHeight && size && weight
    ? { familyVar, lineHeight, size, weight }
    : null;
}

/**
 * The generic family a stack ends in — `sans-serif` / `monospace` / `serif`.
 * Follows `var()` aliases (the blueprint layer's `--font-title` is
 * `var(--font-sans)`).
 */
function genus(props: Record<string, string>, familyVar: string): string {
  let value: string | undefined = props[familyVar];
  for (let hop = 0; hop < 5; hop++) {
    const alias = /^var\((?<name>--[\w-]+)\)$/u.exec(value ?? "");
    if (!alias?.groups?.name) break;
    value = props[alias.groups.name];
  }
  if (!value) throw new Error(`${familyVar} is referenced but never declared`);
  return (value.split(",").pop() ?? "").trim();
}

function shorthands(css: string): Map<string, Shorthand & { genus: string }> {
  const props = rootProps(css);
  const out = new Map<string, Shorthand & { genus: string }>();
  for (const [prop, value] of Object.entries(props)) {
    if (!prop.startsWith("--t-") || prop.endsWith("-size")) continue;
    const parsed = parseShorthand(value);
    if (!parsed) throw new Error(`${prop} is not a font shorthand: ${value}`);
    out.set(prop, { ...parsed, genus: genus(props, parsed.familyVar) });
  }
  return out;
}

const shell = shorthands(toCss());
const blueprint = shorthands(toBlueprintCss());
const shared = [...shell.keys()].filter((key) => blueprint.has(key)).sort();
const gated = shared.filter((key) => !(key in ROLE_PARITY_ALLOWLIST));

function facets(key: string): {
  a: Shorthand & { genus: string };
  b: Shorthand & { genus: string };
} {
  const a = shell.get(key);
  const b = blueprint.get(key);
  if (!(a && b)) throw new Error(`${key} is not published by both emitters`);
  return { a, b };
}

describe("--t-* role parity across the two emitters", () => {
  test("the two emitters share type roles, and most are gated", () => {
    // Guards the guard: if the shared set ever empties (a rename, a scale
    // moved out of an emitter) or the allowlist swallows it, the per-role
    // assertions below would pass vacuously and the law would be silently
    // unenforced.
    expect(shared.length).toBeGreaterThanOrEqual(6);
    expect(gated.length).toBeGreaterThanOrEqual(5);
  });

  test.each(gated)("%s resolves to one family and one weight", (key) => {
    const { a, b } = facets(key);
    expect(
      { family: a.genus, weight: a.weight },
      `${key} means two different things: the shell emits ${a.genus}/${a.weight}, the blueprint layer emits ${b.genus}/${b.weight}. Size and line-height may diverge per surface; family and weight may not (#686).`
    ).toStrictEqual({ family: b.genus, weight: b.weight });
  });

  test("every waiver is still needed", () => {
    // A waiver may not outlive the divergence it excuses: the moment the two
    // sides agree, the stale entry has to be deleted in the same change.
    for (const [key, reason] of Object.entries(ROLE_PARITY_ALLOWLIST)) {
      const { a, b } = facets(key);
      expect(
        { family: a.genus, weight: a.weight },
        `${key} now agrees (${a.genus}/${a.weight}) — delete its ROLE_PARITY_ALLOWLIST entry: ${reason}`
      ).not.toStrictEqual({ family: b.genus, weight: b.weight });
    }
  });

  test("size and line-height are explicitly allowed to diverge", () => {
    // Not incidental: `--t-body` is 15px/22px in the chrome and 0.855rem/1.5
    // on an app surface, and that is the intended design. If this ever starts
    // failing, someone has widened the law past what was agreed.
    const a = shell.get("--t-body");
    const b = blueprint.get("--t-body");
    expect(a?.size).not.toBe(b?.size);
    expect(a?.lineHeight).not.toBe(b?.lineHeight);
    expect(a?.genus).toBe(b?.genus);
    expect(a?.weight).toBe(b?.weight);
  });

  test("every allowlisted role still exists on both surfaces", () => {
    // A waiver naming a role neither emitter publishes any more is dead text.
    for (const key of Object.keys(ROLE_PARITY_ALLOWLIST)) {
      expect(shared, `${key} is waived but is not a shared role`).toContain(
        key
      );
    }
  });
});
