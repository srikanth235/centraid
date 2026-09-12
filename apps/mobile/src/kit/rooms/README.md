# The seven rooms (#1015)

Every mobile screen declares one of seven surface classes, and gets header, back, search, empty, loading, error, status and selection from the room rather than from its own JSX. Before this, nine surfaces shared no header (6 shapes), no back affordance (7), no search placement (5), no confirm (5 plus "no confirm"), no empty (8+) and no date format (5) — none of which was a product difference.

| Room | Anatomy | Examples |
| --- | --- | --- |
| `HomeRoom` | cover grid of app marks, one status line, no floating key, one trailing verb (Settings, D6) | Home |
| `AppPlace` | `AppHeader` (mark + name + ≤1 trailing action), optional search and toolbar under it, app band as a render prop | Photos grid, Tasks list, Tally ledger |
| `PushedPage` | `PlaceHeader`, back to the **named parent** (`PlaceRef`, computed), ≤1 trailing action | album, contact, doc, settings sub-page |
| `EditorRoom` | full screen, autosave, close = done, band hidden, one foot row of acts, status line hosted inside | note, doc, expense, event |
| `SheetRoom` | grabber, title with the noun, ≤1 ink button, status line hosted inside | confirm delete, pick date, add to album |
| `SystemPlace` | `PlaceHeader` + `SectionBlock` / `RowsBlock` only; on a place root the frame's Home band at the foot and no `HomeKey`, otherwise `HomeKey` in the header's leading slot | Settings, Vault, Devices, Backup |
| `StageRoom` | full-bleed `--stage` ground, no header and no band, the caller's own floating chrome, close control + swipe-down dismiss | photo lightbox, its slideshow, a video |

## What the rooms decide, and screens may not

- **Back is a value, not a word.** `backTo` takes a `PlaceRef` (`place.ts`), which no caller can write down; it comes from `parentPlace(stack)`. Audit B7 was thirteen screens hardcoding `backTo="All"`, twelve of them wrong.
- **State order is fixed** (`RoomBody`): error, then loading, then empty, then content. An empty state over a failed read tells a member their vault is empty when it is only unreachable.
- **Selection is a mode** (D5): the header swaps in place to "N selected · Cancel", the band is dimmed through leaf tokens and stops answering, and the verbs sit in one foot row. Never two live bars (audit B8).
- **The band belongs to whoever owns the place**, so a room never builds one. In an app it is the app's: the room hands the app's `band` render prop the state it is in (`BandState`). On a frame place it is the frame's Home band (R-NY-1): `SystemPlace` takes it as a `band` node, draws it at the foot, and then draws no `HomeKey`, because the band's Home tab is the way home. Screens take it from `usePlaceFrame` (`screens/home/usePlaceFrame.tsx`): a place standing directly on Home gets the band (`PlaceBand`); pushed from anywhere else (Vault → Copies, Settings → On this phone) it gets a back key naming what is beneath it and no band (`place-frame.ts`). The Home band never appears inside an app. `EditorRoom` and `StageRoom` take no `band` prop at all: an editor hides it and carries its own leave key (R-KIT-2), and a stage is one piece of media edge to edge, with a band nowhere to stand. An editor that is state rather than a route sets `presented` and gates itself with `visible`; the room does its own `Modal`, and hosts the line inside it.
- **Frame chrome is a node, not an import.** The vault lockup (which vault, which gateway) is true on every route of an app, so `AppPlace` and `PushedPage` take a `chrome` node and draw it above the header. The room does not import `VaultBar`: that would pull the launcher catalog and the gateway client into the kit, which is the constraint `VaultBar` states about itself.
- **The controls that pick what the body shows go in `toolbar`.** A day stepper, a lens-and-sort row: they sit above the body and outside it, for the same reason `overlay` does — a stepper that vanished on the empty day is the control the member needs to leave that day.
- **A screen's own presentations go in `overlay`, not in the body.** A confirm sheet and a presented editor mount outside `RoomBody`, because the body is a state machine and an empty state replaces the children — an editor that vanished the moment its list went empty would be the room deciding something no screen asked it to.
- **The status line is hosted where it can be read.** `EditorRoom` and `SheetRoom` mount `StatusLineHost`; every other room uses the root host.

## The stage is a room, not a room with its chrome removed

`StageRoom` (R-NY-14) is the seventh, and the ONE room with no `PlaceHeader`: the photograph is the screen, and a strip across the top of it is a second ground (§7). It is not `PushedPage` with the header switched off — a room is what a screen may not decide, and a stage's three decisions are its own:

- **The ground is `--stage` from the theme, never a literal.** It is the same value in both schemes (the media ground does not follow the theme), and every control on it inks from `--on-stage` / `--on-stage-soft` / `--stage-line`, or it vanishes. A page-ramp `textDisabled` on a stage reads as absent rather than as refused.
- **There is ONE way out, reached two ways.** The room owns the swipe-down (`stage-gesture.ts`, one `Pan` for both directions so two recognisers cannot race; a horizontal drag fails it, so a pager on the stage keeps its swipe), and it hands the chrome `close` — the same act — so a chrome cannot invent a second way back. A caller that brings no chrome gets the room's own close key, because a stage with no visible way out is a black screen. `PhotoLightbox` is both: its loading hold has no chrome and takes the room's key; its loaded tree brings its own.
- **The ground is full-bleed and the chrome is inset.** A `SafeAreaView` would letterbox the media, so the room's ground takes no inset and every control on it carries its own — the room's close key sits under the notch's inset, and a caller's chrome reads `useSafeAreaInsets` as `PhotoLightbox` does.

`chrome` is a render prop rather than children because paint order is what puts it on the stage — `zIndex` alone is not enough on every Android surface — and `overlay` paints after both, for the stage's own sheets and menus. A stage's MODES (the slideshow, the editor, a video) are state inside the one room, never a second room: nothing is written until Save, and that is a lifetime property rather than a navigation one.

Docs' `DocumentViewer` is deliberately NOT a stage: it keeps `PushedPage` and its title, and simply passes no `band` (#821). Its body is stage-coloured because a document reads better on the dark ground, but a member still needs the document's name and the way back to the shelf it came from.

## Not `OptionSheet`

`OptionSheet` is the single-choice list and stays so; on iOS it lowers to `ActionSheetIOS`, which cannot draw an outlined `--net` verb or host a status line. `SheetRoom` is the room; `ConfirmSheet` is built on it.

## Adoption

The rooms are the only permitted screen roots, and `scripts/lint-mobile-rooms.mjs` enforces it under `bun run lint:product`. A screen roots in a room directly, or in its app's frame — `LockerScreen`, `PeopleScreen`, `PhotosScreen`, `TallyScreen` — when that frame's own root is a room: one level, never two (R-NY-7). A first read's skeleton is the room's `loading` state, never a screen's own root.

Every screen is now in a room and `screen-root` carries no baseline: it is unconditional, like `page-margin`, so a hand-rolled root is a red diff. `PhotoLightbox` was the last one outside, and R-NY-14 gave it the room it was waiting for rather than forcing it into one of the six.
