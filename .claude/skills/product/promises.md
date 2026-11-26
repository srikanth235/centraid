# The promises

What every app owes a member. Eleven promises: P1–P8 look after the member's data, P9–P11 are daily speed and connection. A promise kept in some apps and broken in others is broken: the same behaviour and words in every app, on both platforms. An exception is named and held to that.

**Enforced** says where a promise can no longer be skipped. The registry test and the kind registry are **(target)**: they land with `crates/domain` (lane A), and replace the substring scans of `crates/xtask/src/promises.rs`. Until then `cargo xtask rules` prints the old register.

| # | Promise | The rule every app follows | Enforced |
| --- | --- | --- | --- |
| P1 | **Yours to change** | Any live fact is editable, imported and followed data included. What the source said stays underneath, shown as "Phone says" or "Statement says", and earlier versions are kept and restorable | Kind registry: every kind declares its earlier-versions formatter **(target)**; follower merge tests |
| P2 | **Truthful** | A screen is `Loading`, `Ready` or `Failed`, never emptiness for a failure or 0 for unknown. Units and currencies are explicit, in the member's one units choice. "Backed up" says only what a gateway acknowledged | Room state type; the units formatter **(target)** |
| P3 | **Follows, never writes back** | Phone stores are read one way. A record the member trashed stays trashed | Follower tests |
| P4 | **In, out and back** | Open-format import and export in every app. One item can be handed to the OS share sheet with no owner check, except a Locker item. Other apps can share into Centraid. Originals can be fetched back, and the 24 words recover everything | Registry: every kind declares export and share formatters **(target)**; `arrived_via` is checked by the schema |
| P5 | **Captured in seconds, right here** | `+` opens with the primary input focused. `+` inside a place (notebook, folder, album, list, account, day, person) files there. A new-item editor keeps a draft across a kill, except Locker | Action here-scope; draft service tests **(target)** |
| P6 | **Keeps your place** | Back restores the scroll, the search term and the filter. An app root remembers its view. A cold start anchors time views to Today | Room contract **(target)** |
| P7 | **One or a hundred** | Long-press menu, trailing swipe to trash with no confirm, and Select mode. A bulk action is one commit and one Undo | Catalogue target sets; Undo groups **(target)** |
| P8 | **Connected both ways, and tidy** | Every item links to any other, Locker items included, through one picker. Links, mentions, guests, people in photos and places show on both records. A receipt captured in an item is filed with it. Duplicates merge cleanly | Footer blocks; the home rule in the schema |
| P9 | **Change without fear** | Prose autosaves; a form has Cancel and Save. A stale save is refused. Every action is undoable from the status line, or confirmed first because it cannot be. Trash lasts 30 days. A delete takes only what the item holds, and says how many | Kind registry: trash noun, inverse, holder count **(target)** |
| P10 | **Guarded where it matters, calm everywhere** | The owner check is asked only for Locker, export, the recovery key and restore. Sealed values stay out of search, prompts and notifications. One status line, no badges or streaks. Every alert offers Snooze and a task's also Done. A trashed item's notifications are cleared. Imported dates are silent until asked | Catalogue confirm classes; the notification scheduler **(target)** |
| P11 | **Grounded assistant** | Answers cite live cards. Writes preview or can be undone, and are marked `actor='assistant'`. A purge leaves none of the item's words in a chat. A Locker secret never enters a prompt | Assistant tests; the census; `locker_plaintext_gate` |

Where the promises meet the member: the 24 words, pairing and "Back up" are the backup skill's ([backup/product.md](../backup/product.md)); permissions are asked once, at the moment of need, and a refusal reads the same way everywhere ([rulings/see-truthfully.md](rulings/see-truthfully.md)).

Rulings behind these are in [rulings/](rulings/). To make an app keep one, see [the kind registry](../change/app-plane.md#8-the-kind-registry-and-the-promise-charter).
