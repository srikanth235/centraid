// Token-purity ratchet allowlist (issue #686, item A2).
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
  // What's left is sanctioned: app-font knobs declaring contract font roles,
  // per-app identity props (--app-hue / --app-identity), the photos wall,
  // and hsl(var(--app-hue) ...) theater-stage backdrops awaiting a --stage
  // token in packages/design.
  "docs/Chrome.module.css": {
    hex: 0,
    functional: 0,
    fontFamily: 0,
    customProps: ["--font-sans"],
  },
  "docs/components/QuickLook.module.css": {
    hex: 0,
    functional: 1,
    fontFamily: 0,
    customProps: [],
  },
  "locker/Chrome.module.css": {
    hex: 0,
    functional: 0,
    fontFamily: 0,
    customProps: ["--font-sans"],
  },
  "notes/Chrome.module.css": {
    hex: 0,
    functional: 0,
    fontFamily: 0,
    customProps: ["--font-sans"],
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
  // `photos/components/Lightbox.module.css` used to sit here with one
  // `hsl(0 0% 4%)` theater-stage backdrop, waiting on a `--stage` role in
  // packages/design. That role landed (Photos v4 §2.2 / CHANGELOG §B), the
  // stylesheet now says `var(--stage)`, and the seam is closed — so the entry
  // is gone rather than shrunk to an empty budget.
  "tally/Chrome.module.css": {
    hex: 0,
    functional: 0,
    fontFamily: 0,
    customProps: ["--font-sans"],
  },
};

/**
 * Fallback-less `var()` references that resolve to nothing (issue #686).
 *
 * **The debt is cleared — this list is empty and must stay that way.** Each
 * entry was a live latent bug: the declaration is dropped at computed-value
 * time, so the rule silently did not apply. The twelve that predated #686 were
 * all resolved by reading what each site was actually doing:
 *
 *   * `--r-lg` (3 refs) — the shell radius scale has `lg`, the blueprint
 *     contract does not. All three sites are the repo's card idiom
 *     (`1px solid var(--line)` + `var(--bg-elev)` + 14px padding), which every
 *     peer in the same two apps rounds with `--r-xl`. Bound to that.
 *   * `--acc` — an abbreviation of `--accent` in a focus ring. Bound to
 *     `var(--accent)`, matching every other `:focus-visible` in the apps.
 *   * `--t-label` — the uppercase sidebar section label. The blueprint type
 *     ramp has no `label` rung; every peer section label in every app is
 *     `--t-control`. Bound to that.
 *   * `--bg-l` — genuinely emitted by the blueprint DARK token block (10%) but
 *     absent from the light one, so it is not contract vocabulary. Given the
 *     documented default as an explicit fallback instead.
 */
export const UNRESOLVED_VAR_DEBT: readonly string[] = [];
