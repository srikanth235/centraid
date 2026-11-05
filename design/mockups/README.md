# Native redesign mockups

The source of the native redesign canvas tracked in #1173: one HTML file per screen, plus `canvas.json`, which lays the screens out on the canvas's pages. The live canvas is at https://claude.ai/artifact/4XKj7NZBfm1HoJD8hUHRTC; it is private to its owner until shared.

## What is here

- `*.dc.html`: one screen each, 390×844 for iPhone and 412×915 for Android. A file named `…Dark.dc.html` is the dark version of the screen without the suffix.
- `canvas.json`: the canvas's pages (Design rules, App icon, Light mode, Dark mode, Archive), each screen's place and title, and the row titles.
- `DesignRules.dc.html` and `Decisions.dc.html`: the colour, type and layout rules, and the decisions the owner has made.
- `QuartersIcon.dc.html`: the app icon. Earlier icon rounds are on the Archive page.

The screens load `./support.js`, the canvas's own runtime, which is not in the repo. Open them on the live canvas; a browser shows the markup without the canvas's frame.

## How they change

The canvas is the source. Change a screen there, then copy the files back here in the same change. The canvas writes these files itself, so `oxfmt.config.ts` leaves them unformatted.

Only the light screens are drawn. The dark screens are derived from them by a script kept with the canvas, so a dark screen is never edited by hand. Phase 2 of #1173 moves the colour values into `design/tokens.toml`, so the canvas and the apps cannot disagree.
