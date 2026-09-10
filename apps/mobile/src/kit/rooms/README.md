# The six rooms (#1015)

Every mobile screen declares one of six surface classes, and gets header, back, search, empty, loading, error, status and selection from the room rather than from its own JSX. Before this, nine surfaces shared no header (6 shapes), no back affordance (7), no search placement (5), no confirm (5 plus "no confirm"), no empty (8+) and no date format (5) — none of which was a product difference.

| Room | Anatomy | Examples |
| --- | --- | --- |
| `HomeRoom` | cover grid of app marks, one status line, no floating key, one trailing verb (Settings, D6) | Home |
| `AppPlace` | `AppHeader` (mark + name + ≤1 trailing action), optional search under it, app band as a render prop | Photos grid, Tasks list, Tally ledger |
| `PushedPage` | `PlaceHeader`, back to the **named parent** (`PlaceRef`, computed), ≤1 trailing action | album, contact, doc, settings sub-page |
| `EditorRoom` | full screen, autosave, close = done, band hidden, one foot row of acts, status line hosted inside | note, doc, expense, event |
| `SheetRoom` | grabber, title with the noun, ≤1 ink button, status line hosted inside | confirm delete, pick date, add to album |
| `SystemPlace` | `PlaceHeader` + `SectionBlock` / `RowsBlock` only, `HomeKey` in the header's leading slot | Settings, Vault, Devices, Backup |

## What the rooms decide, and screens may not

- **Back is a value, not a word.** `backTo` takes a `PlaceRef` (`place.ts`), which no caller can write down; it comes from `parentPlace(stack)`. Audit B7 was thirteen screens hardcoding `backTo="All"`, twelve of them wrong.
- **State order is fixed** (`RoomBody`): error, then loading, then empty, then content. An empty state over a failed read tells a member their vault is empty when it is only unreachable.
- **Selection is a mode** (D5): the header swaps in place to "N selected · Cancel", the band is dimmed through leaf tokens and stops answering, and the verbs sit in one foot row. Never two live bars (audit B8).
- **The band belongs to the app**, so a room never renders one — it hands the app's `band` render prop the state it is in (`BandState`). `EditorRoom` takes no `band` prop at all: an editor hides it and carries its own leave key (R-KIT-2). An editor that is state rather than a route sets `presented` and gates itself with `visible`; the room does its own `Modal`, and hosts the line inside it.
- **Frame chrome is a node, not an import.** The vault lockup (which vault, which gateway) is true on every route of an app, so `AppPlace` and `PushedPage` take a `chrome` node and draw it above the header. The room does not import `VaultBar`: that would pull the launcher catalog and the gateway client into the kit, which is the constraint `VaultBar` states about itself.
- **The status line is hosted where it can be read.** `EditorRoom` and `SheetRoom` mount `StatusLineHost`; every other room uses the root host.

## Not `OptionSheet`

`OptionSheet` is the single-choice list and stays so; on iOS it lowers to `ActionSheetIOS`, which cannot draw an outlined `--net` verb or host a status line. `SheetRoom` is the room; `ConfirmSheet` is built on it.

## Adoption

Wave 2 migrates the screens; `scripts/lint-mobile-rooms.mjs` measures what is left. The rooms are the only permitted screen roots once that lint is wired.
