# Selectors

A room control's id is the `selector_id` Rust gave it, set with `Modifier.testTag` in Compose and `.accessibilityIdentifier` in SwiftUI, the same string on both. A flow names the id the room tree prints: `cargo test -p centraid-screens` writes every room as text under `crates/screens/tests/rooms/*.txt`, each selector shown as `#id`. On Android a test tag reaches Maestro's `id:` as a resource id because `MainActivity` sets `testTagsAsResourceId` once on the root content.

An id no room draws selects nothing, so a flow names only ids a room snapshot lists, or one in the table below. Nothing checks that mechanically.

## Ids the shells add around a room's selectors

| Id | What renders it |
| --- | --- |
| `room-<key>` | a room's root (`room-home`, `room-calendar`, `room-photos`) |
| `room-header`, `room-back`, `room-search`, `room-status-line`, `room-filter`, `room-filter-menu`, `room-selection`, `room-stage`, `room-sheet` | the room's header, back key, search slot, status line, filter funnel and its menu, selection bar, stage and sheet |
| `search-corrected` | the line over the search field, drawn only when the core corrected a typo |
| `block-<kind>` | a block with no selector of its own: `block-tiles`, `block-empty`, `block-section`, `block-row`, `block-choice`, `block-form` |
| `canvas-calendar-grid`, `calendar-controls` | the Calendar's grid and its stepper |
| `<choice id>-<option id>` | one option of a choice block, e.g. `choice/view-week` |
| `<field id>-switch`, `<field id>-keypad`, `<field id>-secret-input` | a form field's switch, keypad and secret input |
| `words-make`, `words-make-primary`, `words-make-restore`, `words-make-secondary`, `words-shown`, `words-save-copy` | the words screens that make a vault and show its key |

## Ids a room draws

Home: `tile/<app>` (`tile/calendar`, `tile/photos` ...), `tab/home`, `tab/chat`, `tab/backup`, `glance/today`, `band/search`, `search`, `search/close`.

A place (Calendar, Reminders, Notes, Photos ...): `tab/<place>`, `band/home`, `band/search`, `band/more`, `key/add`, `filter/clear`, `search`, `search/close`, `more/<item>`, `choice/<name>`, `tile/<assetId>` for a photograph's cell, `cal/prev`, `cal/next`, `cal/today`.

The rest are in the room snapshots.
