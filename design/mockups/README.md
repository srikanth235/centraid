# Native redesign mockups

The mockups for the native redesign tracked in #1173: one HTML file per screen, plus `canvas.json`, which groups the screens into pages.

## What is here

- `*.dc.html`: one screen each, 390×844 for iPhone and 412×915 for Android. Open any of them in a browser. A file named `…Dark.dc.html` is the dark version of the screen without the suffix, generated from it (see below).
- `canvas.json`: the pages (Design rules, App icon, Light mode, Dark mode, Archive), each screen's place and title, and the row titles.
- `DesignRules.dc.html` and `Decisions.dc.html`: the colour, type and layout rules, and the decisions the owner has made.
- `QuartersIcon.dc.html`: the app icon. Earlier icon rounds are on the Archive page.

## How they change

These files are the source of the design. A visual or UX change edits the light screen here first, in the same change as the code. The files are written by a design tool, so `oxfmt.config.ts` leaves them unformatted.

Only the light screens are drawn. Every `…Dark.dc.html` is generated from its light screen and is never edited by hand:

1. Edit the light screen (`X.dc.html`).
2. Run `cargo xtask design-dark`. It rewrites each dark screen from its light one, swapping the colours by role (text, fill, line, shadow) and the few context rules (document pages and switch thumbs stay light) with the values in the `[mockups.dark]` section of `design/tokens.toml`.
3. Commit the light and dark screens together. `cargo xtask design-dark --check` fails when a dark screen is not what the generator writes, and the `xtask` tests run the same comparison.

A new colour in a light screen has no dark value yet and stops the generator until you add it to `[mockups.dark]` (as a `colors` entry, or under `keep` if it is content that does not change). To change how a colour looks in dark, change `design/tokens.toml` and rerun the generator, not the dark screens. The generator is `crates/xtask/src/design_dark.rs`; it covers the screens the `canvas.json` places on the Light mode page. Phase 2 of #1173 moves the rest of the colour values into `design/tokens.toml`, so the mockups and the apps cannot disagree.
