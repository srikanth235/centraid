// Token-purity ratchet allowlist (#686).
//
// packages/design owns every color, type ramp, radius, and font in the
// product. Blueprint app CSS is supposed to *consume* those tokens through
// `var(--token)` and never restate them — a hardcoded `#fff` or a locally
// declared `--c-*` silently forks the palette and breaks theming the moment
// the design package changes a value.
//
// The apps are not clean yet. This file is the burn-down ledger: every entry
// records exactly how many violations of each kind a file still carries.
// `token-purity.test.ts` asserts the real counts EQUAL these numbers, so:
//
//   * adding a new hardcoded literal turns the suite red (count too high);
//   * cleaning a file up ALSO turns the suite red (count too low) until the
//     entry here is shrunk or deleted in the same change.
//
// That second direction is deliberate. The ledger may only ever get smaller,
// and every shrink is a reviewed diff. Do not add new entries or raise a
// count without a very good reason — the intended end state is an empty
// object and the deletion of this file.
//
// Counting rules live in token-purity.test.ts (comments are stripped first,
// `font-family` values built only from `var()` are legitimate, and
// `customProps` lists distinct reserved-namespace property NAMES, not
// occurrences).

/** Per-file violation budget, keyed by path relative to `packages/blueprints/apps`. */
export interface TokenPurityBudget {
  /** `#rgb` / `#rrggbb` / `#rrggbbaa` literals. */
  hex: number;
  /** `rgb()` / `rgba()` / `hsl()` / `hsla()` literals. */
  functional: number;
  /** `font-family` declarations naming a concrete font stack. */
  fontFamily: number;
  /** Distinct reserved-namespace custom properties declared in the file. */
  customProps: readonly string[];
}

export const TOKEN_PURITY_ALLOWLIST: Readonly<
  Record<string, TokenPurityBudget>
> = {
  // Remaining entries after the #686 burn-down (was 28 files / 252 violations).
  // What's left is sanctioned: per-app identity props
  // (--app-hue / --app-identity), the photos wall,
  // and hsl(var(--app-hue) ...) theater-stage backdrops awaiting a --stage
  // token in packages/design.
  // Docs' teal identity, declared in the same commit that added it. The two
  // knobs are the sanctioned per-app identity surface (see `people` and
  // `photos` below); everything else in that file is contract vocabulary.
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
 * Fallback-less `var()` references that resolve to nothing (#686).
 *
 * **This list is empty and must stay that way.** Any entry is a live latent
 * bug: the declaration is dropped at computed-value time, so the rule silently
 * does not apply. Resolve a new one by reading what the site is actually doing
 * — bind the name to the token its peers already use, or give the documented
 * default as an explicit fallback — rather than listing it here.
 */
export const UNRESOLVED_VAR_DEBT: readonly string[] = [];
