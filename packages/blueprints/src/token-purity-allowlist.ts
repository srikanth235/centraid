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
  // per-app identity props (--app-hue / --accent aliases), the photos wall,
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
    customProps: ["--font-sans", "--font-title"],
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
    customProps: ["--_accent", "--accent", "--app-hue"],
  },
  "photos/Chrome.module.css": {
    hex: 0,
    functional: 3,
    fontFamily: 0,
    customProps: ["--_accent", "--app-hue", "--bg-wall"],
  },
  "photos/components/Lightbox.module.css": {
    hex: 0,
    functional: 1,
    fontFamily: 0,
    customProps: [],
  },
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
 * Each entry is a live latent bug: the declaration is dropped at computed-value
 * time, so the rule silently does not apply. All of these predate #686 — the
 * burn-down neither introduced nor fixed them — and they are pinned here so the
 * class can only shrink. Fixing one means deleting its line, not editing it.
 */
export const UNRESOLVED_VAR_DEBT: readonly string[] = [
  "_shared/AudiencePlacement.module.css -> --acc",
  "people/components/TrashCard.module.css -> --r-lg",
  "photos/Chrome.module.css -> --bg-l",
  "tally/components/ExpenseUndo.module.css -> --r-lg",
  "tally/components/GroupManager.module.css -> --r-lg",
  "tasks/components/Board.module.css -> --accent-deep-fg",
  "tasks/components/Capture.module.css -> --accent-deep-fg",
  "tasks/components/Detail.module.css -> --accent-deep-fg",
  "tasks/components/Row.module.css -> --accent-deep-fg",
  "tasks/components/Sidebar.module.css -> --accent-deep-fg",
  "tasks/components/Sidebar.module.css -> --t-label",
  "tasks/components/shared.module.css -> --accent-deep-fg",
];
