# `centraid-apps-notes` — notebooks as a projection of the vault

Notes is 6 queries and 17 actions over the vault's one model ([#1135](https://github.com/srikanth235/centraid/issues/1135)). A note is an `entity` of kind `note` with its words on a `note` row; a notebook is an `entity` and a `container`; a pin or a tag is a `tagged` edge; a link, a memo and an attachment are `links`, `about` and `attached` edges; a past version is a `revision`. This crate is the read plane and the action table; `crates/core` answers its phone queries as the `notes_*` arms of `app_query` (`notes.proto`, [#1046](https://github.com/srikanth235/centraid/issues/1046)); the writes are `crates/vault`'s four `note.*` commands plus the shared verbs every app uses, and the text search is `crates/search`.

| Module | What it is |
| --- | --- |
| `manifest` | The app's `manifest.json`, parsed by the kit's parser at load time. Two copies of "which commands does Notes act with" is how the two answers drift. |
| `queries` | `library`, `note`, `search`, `history`, `journal` and `link-targets`: the statements, the three shelves, the `IN`-bounded reads that decorate them, the tag chips and the powerbox. |
| `derive` | The preview and the checklist tally. ONE copy. |
| `journal` | The memo set — every note that is about something — read once and excluded four ways. |
| `cards` | The far end of a link, as the shelf draws it: one read of `entity`, plus one of the kind's own table for the few kinds that add a subtitle or a thumbnail. |
| `commands` | The seventeen actions as invocations, `invoke_key` mandatory. |
| `shelves` | The phone's shelves over the library fold: sort and filters (pinned, notebook, unfiled, tags), the trash shelf on its own, and the notebook spine with live-note counts. |
| `editor` | The editor's note: the whole body, the pin, the notebook and `row_version` — the base an autosave compares against. |
| `local` | The Journal grouped by the local day of `created_at`, in the zone the request states, through `centraid_vault::time`'s one zone engine. |

## What is Notes' and what is shared

Notes does not wrap a shared verb. What only a note has is `note.create`, `note.edit` (title, body, format), `note.move` (into a notebook, or out of one) and `note.restore_version`; every other action names the shared verb directly — `entity.trash` and `entity.restore` for a note or a notebook, `entity.retitle` to rename a notebook, `container.create` for a notebook, `flag.set` / `flag.clear` for a pin, `tag.add` / `tag.remove`, `edge.add` / `edge.remove` for a link or an attachment. `send-to-tasks` is the one action making two invocations: Agenda's `task.add`, then `edge.add` joining the task to the note with an `about` edge.

An edit that changes the body writes the words it replaced as a `revision`; a restore swaps one in and keeps what it replaced; an edit or a restore that lands on the words already there writes nothing. A body over 64 KiB is refused.

## Wikilinks compile in the vault (Q-1047-9)

`[[title]]` is what the powerbox writes into a body, and the vault compiles it: `note.create`, `note.edit` and `note.restore_version` recompute the note's `links` edges from the new words in the same transaction (`crates/vault/src/commands/note.rs`), so the library's `references` and `backlinks` need no scan of bodies. The compile owns the edges it writes and no others: its edges carry the anchor `{"wikilink": "<title>"}`, a link the member made by hand carries a text range, and a hand link to the same thing stands in for the compiled one. A title names every live note, person, event, task, document, photo and Locker item with that title (the compile skips a Locker item under the assistant's principal) — never a memo or a trashed row — and the powerbox offers exactly those seven kinds (`note::LINKABLE`). A title that names nothing waits, and a rename of its target does not re-resolve it: the edge appears the next time the linking note's words change.

## The rulings this crate is shaped by

Every one is an answer to a way this crate could be wrong, and every one has a test named after it.

**D-1020-N3 — the library asymmetry is the contract, not an oversight.** A memo is a note with an `about` edge: a People-journal entry, a note on a task. It is **absent from the library, the trash shelf, the derived tag chips, `search` and the powerbox — and reachable by id**, because the People screen opens one (#834 R-journal). The asymmetry is spelled as the ABSENCE of a filter in `load_note`, which does no memo read at all. The Journal place reads the same set the other way round. `crates/apps/notes/tests/year3.rs` holds both halves, and `crates/core/src/app_query/notes.rs` pins them through the wire. Code that unified the two would either leak memos onto the shelf or break the screen that opens one.

**The library is a bounded recent window PLUS every pinned note.** A pin survives the note ageing out, so the pinned shelf is read _beside_ the window and never out of it — which means `notes` can hold pins the window does not. Clamping the union to `window` would drop a pin, which is the bug the shelf exists to prevent. `truncated` is measured on what the vault returned, before the memos are left out.

**D-1020-D3-12 — the declared window is walked, not clamped.** `MAX_PAGE_ROWS` clamps a page to 500, so a library declaring `limit: 2000` and read as one page would answer **500 notes** and discard the cursor that says there are more. `entity.updated_at` is `NOT NULL`, so the keyset walk is continuable and the stated window is reachable. At the year-3 profile (10,000 notes, 600 of them 48 KiB) the library folds 1,943 live rows and 200 trashed in ~370 ms on `ci-linux-x64-4c` (debug).

**History is the words that were replaced.** `history` answers the current words and then each `revision` newest first, 200 at most with `truncated` saying more exist. A revision has a `seq`, so there is no chain to walk and no cycle to refuse; a long-lived note collects a version per save, which is why the list is a window.

**D-1020-N1 — the powerbox is secret-free by construction.** `link-targets` is one bounded probe per linkable kind through `crates/search`, each probe **isolated** so a refused kind leaves its column absent rather than emptying the sheet. Locker is not indexed: the absence is structural, so a secret cannot become a link target by adding a probe. A Locker item is an entity, so a note may link one by an edge (`edge.add` from the note, `links`); the link renders the item's title (`notes.cards.entity` is a read the vault serves a Locker item's row to) and opening it goes through Locker's gate. The powerbox does not list Locker items, and its foot says so. The memo read rides inside the note probe, because that is the only kind it narrows.

**A list row carries a preview, never a body** (#404). Six lines, 200 **characters** — not bytes: a byte slice would split an em dash. The editor pulls the full text lazily through `note`, which is what keeps a 48 KiB body off the shelf.

**A denial is a value.** Every query answers the empty shape plus a `Denial` rather than throwing. The one read that fails CLOSED is the memo set (`journal.rs`): answering "no memos" would leak them into four surfaces, so its refusal propagates — and the query still turns it into the payload's own `vaultDenied`, so the app's contract holds at the surface.

## The phone's arms

`crates/core/src/app_query/notes.rs` answers eight typed queries — `library`, `notebooks`, `journal`, `search`, `trash`, `history`, `link_targets` and `note` — at numbers 40–47 of `app_query.proto`. Facts a shell author needs:

- **A filter narrows the window, not the vault.** `shape_library` filters the rows the recent window returned; a notebook or tag filter over a `truncated` window can miss older notes, and `truncated` says so. The pinned filter is complete.
- **The spine counts "Unfiled" too** (#1047): live, non-memo notes filed in no notebook, over the library's default window plus every pinned note, with `unfiled_truncated` when the window filled.
- **A notebook holds notes by one column** (`note.notebook_id`). A notebook's delete is `entity.trash`, which takes the notes filed in it to the trash with it and brings them back with it on restore.
- **A new journal entry is a note, and Notes owns no command for it** (Q-1047-8). The Journal's "New entry for today" sheet saves People's `people.add_journal_entry`, which founds a note and adds its `about` edge; the entry is drawn under the day it was written in the device's zone, kept off the library and reachable by id.
- **`note.edit` takes no base.** The conflict check is the editor's, against `note`'s `row_version`, which every commit that changes the note bumps. `title` may be empty on an edit and not on a create; `body` may be empty on both (a note may be cleared).

```sh
cargo test -p centraid-apps-notes
cargo test -p centraid-core --lib app_query::notes
cargo test -p centraid-vault --test notes
```

## The year-3 volume

`crates/apps/kit/src/fixtures.rs` writes the profile `YEAR3_NOTES` declares as rows of the model: 10,000 notes (400 trashed, 200 pinned and older than the window, 1,200 memos), 600 long bodies, tags, links, revisions. `tests/year3.rs` runs a sample of it on every test pass and the declared profile on demand:

```sh
cargo test -p centraid-apps-notes --test year3 -- --ignored --nocapture
```

## Owner hand-off — the typing-latency number

The typing-latency target is a round trip through the **editor's state machine on a reference device** (#1020 `:167`), and that machine is Kotlin with no Rust twin:

```sh
./gradlew -p mobile :shared:jvmTest --tests '*ScreenMachineSpec*'   # the reducer, on a JVM
```

The on-device half has no automated flow; it is a manual measurement on a reference device. What the Rust box measures is the editor's on-open pull over the largest body the product holds (~1.5 ms for 48 KiB on `ci-linux-x64-4c`, debug), printed by `tests/year3.rs`.
