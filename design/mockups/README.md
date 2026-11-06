# Native redesign mockups

The mockups for the native redesign tracked in #1173: one HTML file per screen, plus `canvas.json`, which groups the screens into pages.

## What is here

- `*.dc.html`: one screen each, 390×844 for iPhone and 412×915 for Android. Open any of them in a browser. A file named `…Dark.dc.html` is the dark version of the screen without the suffix.
- `canvas.json`: the pages (Design rules, App icon, Light mode, Dark mode, Archive), each screen's place and title, and the row titles.
- `DesignRules.dc.html` and `Decisions.dc.html`: the colour, type and layout rules, and the decisions the owner has made.
- `QuartersIcon.dc.html`: the app icon. Earlier icon rounds are on the Archive page.

## How they change

These files are the source of the design. A visual or UX change edits the light screen here first, in the same change as the code. The files are written by a design tool, so `oxfmt.config.ts` leaves them unformatted.

Only the light screens are drawn. The dark screens are derived from them, so a dark screen is never edited by hand. `design/tokens.toml` owns the shared values. Run `cargo xtask design` to regenerate the dark screens and native resources together; `cargo xtask design --check` detects drift.
