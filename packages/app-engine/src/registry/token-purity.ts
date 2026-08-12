/*
 * Token-purity lint for authored app CSS (issue #686, item D3).
 *
 * `packages/design` owns every colour, radius, spacing rung, and type face in
 * the product; app CSS is supposed to *consume* those names through
 * `var(--token)` and never restate them. Until now that rule reached
 * harness-authored apps only as prose in the system prompt
 * (`packages/gateway/src/skills/ui-grounding.ts`) — nothing checked the CSS an
 * harness actually wrote. Checked-in blueprint apps have a vitest ratchet
 * (`packages/blueprints/src/token-purity.test.ts`); this module is the runtime
 * equivalent, run at the publish gate.
 *
 * Pure and dependency-free on purpose: the design contract's own property
 * names are *injected* (`contractProps`) by the caller that already depends on
 * `@centraid/design`, so app-engine does not grow a dependency on the design
 * package. The detection rules deliberately mirror the blueprint ratchet's.
 */

/** One token-purity problem found in a stylesheet. */
export interface TokenPurityFinding {
  /** 1-based line number in the scanned source. */
  line: number;
  /** What rule was broken. */
  kind: "hex" | "functional-color" | "font-family" | "reserved-custom-prop";
  /** The offending text, trimmed for display. */
  text: string;
  /** What the author should write instead. Read by an LLM app author. */
  fix: string;
}

/**
 * Custom-property namespaces owned by `packages/design`. An app that declares
 * one of these shadows the design system's token, so its value wins locally
 * and the app silently stops tracking theme changes.
 */
const RESERVED_PREFIXES = [
  "--c-",
  "--t-",
  "--r-",
  "--sp-",
  "--bg-",
  "--text-",
] as const;

/**
 * The two identity knobs an app is explicitly allowed to declare
 * (`DESIGN.md`, "Do's and Don'ts"). Everything else
 * in the contract is read-only to an app.
 */
const APP_OWNED_PROPS = new Set(["--app-hue", "--app-identity"]);

// `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`. Longest alternative first so a
// 6-digit literal is never reported as a 3-digit one plus trailing junk.
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/gu;
const FUNCTIONAL = /\b(?:rgba?|hsla?)\(/gu;
const FONT_FAMILY = /(?:^|[;{])\s*font-family\s*:(?<value>[^;}]*)/gmu;
const CUSTOM_PROP_DECL = /(?:^|[;{])\s*(?<name>--[A-Za-z0-9_-]+)\s*:/gmu;
const VAR_REFERENCE = /var\(--[A-Za-z0-9_-]+[^)]*\)/gu;
const FONT_KEYWORDS = /inherit|initial|unset|revert/gu;

const HEX_FIX =
  "use a contract token instead — var(--text) / var(--text-soft) / " +
  "var(--text-faint) for ink, var(--bg) / var(--bg-elev) / var(--bg-sunken) " +
  "for fills, var(--line) / var(--line-strong) for hairlines, " +
  "var(--accent) / var(--accent-soft) / var(--accent-deep) for the accent, " +
  "and var(--danger) / var(--warning) / var(--success) for states";

const FUNCTIONAL_FIX =
  "use a contract token instead of an rgb()/hsl() literal — " +
  "var(--text), var(--bg-elev), var(--line), var(--accent), var(--scrim) " +
  "for overlays; for a tint of the accent use var(--accent-soft)";

const FONT_FAMILY_FIX =
  "delete the family — type comes from the contract: set " +
  "`font: var(--t-body)` (or --t-title / --t-body-strong / --t-small / " +
  "--t-control / --t-mono), and if you must name a family use " +
  "var(--font-sans) / var(--font-mono) / var(--font-serif)";

/**
 * Replace every CSS comment with the same number of newlines, so a documented
 * `/* was #fff *\/` note does not read as a live literal while line numbers
 * stay accurate.
 */
function blankComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, (block) =>
    "\n".repeat((block.match(/\n/gu) ?? []).length)
  );
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

function isTokenOnlyFontFamily(value: string): boolean {
  // A value assembled purely out of `var()` (plus CSS-wide keywords,
  // whitespace, and commas) is exactly the compliant form.
  return (
    value
      .replace(VAR_REFERENCE, "")
      .replace(FONT_KEYWORDS, "")
      .replace(/[\s,]/gu, "") === ""
  );
}

/** Options for {@link scanCssTokenPurity}. */
export interface TokenPurityOptions {
  /**
   * The design package's public custom-property names (i.e.
   * `BLUEPRINT_TOKEN_CONTRACT`). Injected so this module stays free of a
   * dependency on `@centraid/design`. Omitted → only the reserved namespace
   * prefixes are enforced.
   */
  contractProps?: readonly string[];
}

/**
 * Find every token-purity violation in one stylesheet. Pure; the caller owns
 * reading files and deciding what to do with the findings.
 *
 * Note that `color-mix(in oklab, #fff 20%, var(--bg))` is still a violation:
 * the hex endpoint is matched regardless of the function wrapping it.
 */
export function scanCssTokenPurity(
  source: string,
  options: TokenPurityOptions = {}
): TokenPurityFinding[] {
  const css = blankComments(source);
  const contract = new Set(options.contractProps);
  const findings: TokenPurityFinding[] = [];

  for (const match of css.matchAll(HEX)) {
    findings.push({
      line: lineAt(css, match.index),
      kind: "hex",
      text: match[0],
      fix: HEX_FIX,
    });
  }
  for (const match of css.matchAll(FUNCTIONAL)) {
    findings.push({
      line: lineAt(css, match.index),
      kind: "functional-color",
      text: `${match[0]}…)`,
      fix: FUNCTIONAL_FIX,
    });
  }
  for (const match of css.matchAll(FONT_FAMILY)) {
    const value = match.groups?.value ?? "";
    if (isTokenOnlyFontFamily(value)) continue;
    findings.push({
      line: lineAt(css, match.index),
      kind: "font-family",
      text: `font-family:${value.trimEnd()}`,
      fix: FONT_FAMILY_FIX,
    });
  }
  const seenProps = new Set<string>();
  for (const match of css.matchAll(CUSTOM_PROP_DECL)) {
    const name = match.groups?.name ?? "";
    if (APP_OWNED_PROPS.has(name) || seenProps.has(name)) continue;
    const reserved =
      contract.has(name) ||
      RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (!reserved) continue;
    seenProps.add(name);
    findings.push({
      line: lineAt(css, match.index),
      kind: "reserved-custom-prop",
      text: `${name}:`,
      fix:
        `${name} is owned by @centraid/design — reference it with ` +
        `var(${name}) instead of redeclaring it. The only custom properties ` +
        "an app may define are --app-hue and --app-identity (its identity); any " +
        "other name you need must be app-local and outside the reserved " +
        "--c-/--t-/--r-/--sp-/--bg-/--text- namespaces",
    });
  }

  return findings.sort((a, b) => a.line - b.line);
}

/**
 * Render findings as one publish-blocking error string, or `""` when clean.
 * The wording is deliberately instructive: an LLM app author reads this text
 * as its only feedback from the publish gate.
 */
export function formatTokenPurityError(
  findings: readonly TokenPurityFinding[],
  relPath: string
): string {
  if (findings.length === 0) return "";
  const lines = findings.map(
    (finding) =>
      `  - ${relPath}:${finding.line}  ${finding.text}\n      ${finding.fix}`
  );
  return [
    `${relPath} breaks the design token contract ` +
      `(${findings.length} violation${findings.length === 1 ? "" : "s"}). ` +
      "App CSS must consume tokens, never restate them — no hex/rgb()/hsl() " +
      "literals, no concrete font stacks, and no redeclaring a design-system " +
      "custom property. The full token list is at the top of your app.css.",
    ...lines,
  ].join("\n");
}
