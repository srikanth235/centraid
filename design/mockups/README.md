# Boards

The mockups for the native app: one HTML file per screen state, `canvas.json`, which places them on pages, and the generated `tokens.css`. The flow and the checks are in [`.claude/skills/design/mockups.md`](../../.claude/skills/design/mockups.md); the values are in [`design/tokens.toml`](../tokens.toml).

## What is here

- `X.dc.html`: one light board per screen, 390×844 for iPhone and 412×915 for Android. Open any of them in a browser; no server is needed. A board uses colour only as `var(--role)` from `tokens.css`.
- `XDark.dc.html`: the same board with `data-theme="dark"`, written by `cargo xtask design`. Never edited.
- `Part<Block>.dc.html`: a part board for each block, room slot and canvas, on the Parts page. It shows the block's states, and its `<!-- variant:… -->` regions are what screen boards insert. There are 33: the 26 blocks (`Hero`, `Section`, `Row`, `Facts`, `Form`, `Choice`, `Figure`, `Prose`, `Media`, `Progress`, `Empty`, `Wall`, `Tiles`, `Glance`, `Trash`, `Confirm`, `Menu`, `Attachments`, `Linked`, `MentionedIn`, `Says`, `EarlierVersions`, `Origin`, `Filter`, `Search`, `Selection`), the three room slots that are not blocks (`Header`, `Band`, `StatusLine`) and the four canvases (`CanvasCalendarGrid`, `CanvasPhotoGrid`, `CanvasNoteEditor`, `CanvasChart`).
- `tokens.css`: light colours on `:root`, dark on `[data-theme="dark"]`. Generated.
- `canvas.json`: the pages (Design rules, App icon, Parts, Light mode, Dark mode, Archive), each board's place and title, and the row titles. The dark entries are generated.
- `DesignRules.dc.html` and `Decisions.dc.html`: the colour, type and layout rules, and the decisions the owner has made. `DesignRules` shows the token values and the check keeps them equal to `tokens.toml`; `Decisions` is the one board that keeps retired words.
- `CourtyardIcon.dc.html`: the app icon. Earlier icon rounds are on the Archive page.
- **Android boards exist only where Android draws a screen differently from iOS** (`Android…dc.html`, 412×915). Where the two draw the same screen from the same Rust state and the same kit components, the iOS board is the reference for both.

## How they change

These files are the source of the design. A visual or UX change edits the light board (or its part board) first, in the same change as the code. The files are written by a design tool, so `oxfmt.config.ts` leaves them unformatted.

1. Edit the light board. For a block, edit its part board and run the generator; do not edit a part region inside a board.
2. Use roles, not values: `var(--text-ink)`, never `#1C1B19`. A new colour is added to `design/tokens.toml` with both its light and its dark value. A photograph or a third-party mark carries `data-keep` instead.
3. Link a control that opens another board with `<a href="X.dc.html">`; `data-next="X"` marks one not drawn yet.
4. Run `cargo xtask design`. It writes `tokens.css`, fills every `<!-- part:… -->` region from its part board, writes each dark twin and its `canvas.json` entry, and regenerates the shells and the sites.
5. Commit the boards, the dark twins and the generated files together. `cargo xtask design --check` (the gate's `design` step) fails on anything stale and on a raw colour, a bad part marker or link, a retired word and the other findings the skill lists.

Dark is designed, not converted: the dark value of each role is chosen in `tokens.toml`. To change how a colour looks in dark, change that value and rerun the generator.
