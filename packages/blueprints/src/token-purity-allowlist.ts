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
  "agenda/Chrome.module.css": {
    hex: 4,
    functional: 0,
    fontFamily: 0,
    customProps: ["--warning"],
  },
  "agenda/components/EventDrawer.module.css": {
    hex: 0,
    functional: 1,
    fontFamily: 0,
    customProps: [],
  },
  "agenda/components/MonthView.module.css": {
    hex: 2,
    functional: 0,
    fontFamily: 0,
    customProps: [],
  },
  "agenda/components/Sidebar.module.css": {
    hex: 3,
    functional: 0,
    fontFamily: 0,
    customProps: [],
  },
  "agenda/components/WeekView.module.css": {
    hex: 4,
    functional: 0,
    fontFamily: 0,
    customProps: [],
  },
  "docs/Chrome.module.css": {
    hex: 22,
    functional: 0,
    fontFamily: 0,
    customProps: [
      "--c-doc",
      "--c-image",
      "--c-media",
      "--c-pdf",
      "--c-sheet",
      "--c-slide",
      "--font-sans",
    ],
  },
  "docs/components/Details.module.css": {
    hex: 1,
    functional: 1,
    fontFamily: 0,
    customProps: [],
  },
  "docs/components/Editor.module.css": {
    hex: 0,
    functional: 1,
    fontFamily: 0,
    customProps: [],
  },
  "docs/components/QuickLook.module.css": {
    hex: 8,
    functional: 8,
    fontFamily: 0,
    customProps: [],
  },
  "docs/components/shared.module.css": {
    hex: 2,
    functional: 1,
    fontFamily: 0,
    customProps: [],
  },
  "locker/Chrome.module.css": {
    hex: 1,
    functional: 7,
    fontFamily: 0,
    customProps: [
      "--bg-side",
      "--font-sans",
      "--font-title",
      "--t-strong",
      "--warning",
    ],
  },
  "locker/components/Generator.module.css": {
    hex: 1,
    functional: 1,
    fontFamily: 0,
    customProps: [],
  },
  "locker/components/Sidebar.module.css": {
    hex: 3,
    functional: 0,
    fontFamily: 0,
    customProps: [],
  },
  "locker/components/shared.module.css": {
    hex: 2,
    functional: 0,
    fontFamily: 0,
    customProps: [],
  },
  "notes/Chrome.module.css": {
    hex: 2,
    functional: 0,
    fontFamily: 0,
    customProps: ["--font-sans"],
  },
  "notes/components/Editor.module.css": {
    hex: 0,
    functional: 1,
    fontFamily: 0,
    customProps: [],
  },
  "people/Chrome.module.css": {
    hex: 18,
    functional: 40,
    fontFamily: 0,
    customProps: [
      "--_accent",
      "--accent",
      "--bg",
      "--bg-elev",
      "--bg-l",
      "--bg-sunken",
      "--bg-wall",
      "--c-close",
      "--c-family",
      "--c-friends",
      "--c-network",
      "--c-work",
      "--danger",
      "--ease",
      "--font-sans",
      "--font-title",
      "--line",
      "--line-strong",
      "--mono",
      "--on-accent",
      "--r-btn",
      "--r-card",
      "--r-md",
      "--r-pill",
      "--sel",
      "--selb",
      "--shadow-lg",
      "--shadow-md",
      "--shadow-sm",
      "--success",
      "--t-body",
      "--t-body-strong",
      "--t-mono",
      "--t-small",
      "--t-strong",
      "--t-tiny",
      "--t-title",
      "--text",
      "--text-faint",
      "--text-soft",
    ],
  },
  "people/components/Details.module.css": {
    hex: 0,
    functional: 1,
    fontFamily: 0,
    customProps: [],
  },
  "photos/Chrome.module.css": {
    hex: 0,
    functional: 6,
    fontFamily: 0,
    customProps: ["--_accent", "--app-hue", "--bg-wall"],
  },
  "photos/components/Editor.module.css": {
    hex: 0,
    functional: 8,
    fontFamily: 0,
    customProps: [],
  },
  "photos/components/Lightbox.module.css": {
    hex: 0,
    functional: 12,
    fontFamily: 0,
    customProps: [],
  },
  "photos/components/Memories.module.css": {
    hex: 0,
    functional: 3,
    fontFamily: 0,
    customProps: [],
  },
  "photos/components/Sidebar.module.css": {
    hex: 0,
    functional: 1,
    fontFamily: 0,
    customProps: [],
  },
  "photos/components/Slideshow.module.css": {
    hex: 0,
    functional: 4,
    fontFamily: 0,
    customProps: [],
  },
  "photos/components/Timeline.module.css": {
    hex: 0,
    functional: 11,
    fontFamily: 0,
    customProps: [],
  },
  "tally/Chrome.module.css": {
    hex: 8,
    functional: 3,
    fontFamily: 0,
    customProps: ["--font-sans", "--t-strong"],
  },
  "tasks/Chrome.module.css": {
    hex: 1,
    functional: 0,
    fontFamily: 0,
    customProps: [],
  },
  "tasks/components/Detail.module.css": {
    hex: 0,
    functional: 1,
    fontFamily: 0,
    customProps: [],
  },
};
