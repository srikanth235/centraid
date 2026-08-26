// Token-purity ratchet allowlist (#686).
//
// packages/design owns every color, type ramp, radius, and font; blueprint app
// CSS consumes them through `var(--token)` and never restates them, since a
// hardcoded literal or a local `--c-*` forks the palette. This file is the
// burn-down ledger of what each file still carries: `token-purity.test.ts`
// asserts real counts EQUAL these numbers, so a new literal AND an uncounted
// cleanup both turn the suite red. The ledger may only shrink — do not add an
// entry or raise a count; the end state is an empty object and no file here.
// Counting rules live in token-purity.test.ts.

/** Keyed by path relative to `packages/blueprints/apps`. */
export interface TokenPurityBudget {
  hex: number;
  /** `rgb()` / `hsl()` literals, with or without alpha. */
  functional: number;
  /** `font-family` declarations naming a concrete stack. */
  fontFamily: number;
  /** Distinct reserved-namespace custom property NAMES, not occurrences. */
  customProps: readonly string[];
}

export const TOKEN_PURITY_ALLOWLIST: Readonly<
  Record<string, TokenPurityBudget>
> = {
  // Sanctioned residue: the two per-app identity knobs, plus photos' stage
  // backdrop awaiting a `--stage` token in packages/design.
  "docs/Chrome.module.css": {
    hex: 0,
    functional: 0,
    fontFamily: 0,
    customProps: ["--app-hue", "--app-identity"],
  },
  "people/Chrome.module.css": {
    hex: 0,
    functional: 0,
    fontFamily: 0,
    customProps: ["--app-hue", "--app-identity"],
  },
  "photos/Chrome.module.css": {
    hex: 0,
    functional: 1,
    fontFamily: 0,
    customProps: ["--app-hue", "--app-identity"],
  },
};

/**
 * Fallback-less `var()` references that resolve to nothing (#686). Empty, and
 * must stay so: every entry is a live bug — the declaration is dropped at
 * computed-value time, so the rule silently does not apply. Bind the name to a
 * token or give an explicit fallback instead of listing it here.
 */
export const UNRESOLVED_VAR_DEBT: readonly string[] = [];
