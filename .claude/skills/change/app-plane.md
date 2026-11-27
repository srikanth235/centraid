# The app plane

The one interface between the vault, the core, the assistant and both shells. A read is registered SQL. A write is a typed action. A screen is a **room** holding **blocks** and at most one of four **canvases**; Rust decides which blocks, in what order, with what words and data; SwiftUI and Compose draw each block once. Everything here is stated as meaning, never layout. The wire is [`room.proto`](../../../crates/api-proto/proto/centraid/core/v1/room.proto); field names below are its field names.

**Built.** The app plane is built end to end: the vault below ([`crates/vault`](../../../crates/vault), [`001_baseline.sql`](../../../contracts/migrations/001_baseline.sql), [`vault-commands.txt`](../../../contracts/schema/vault-commands.txt)); the declaration layer ([`crates/domain`](../../../crates/domain): read registry in sections 2–3, action catalogue in section 4, kind registry in section 8, and the chat census in section 7, held by the registry and census tests); the core services (reads, actions, draft service, notification scheduler, device store with its key registry, and widget snapshots); the room builders, room runtime and rooms for Home, Chat, Settings, Backup and all nine apps ([`crates/screens/src/room`](../../../crates/screens/src/room)); and the blocks and four canvases in both shells (iOS SwiftUI and Android Compose).

**Day one** is in [`room/first.rs`](../../../crates/screens/src/room/first.rs): a founded vault with nothing of the member's opens the `welcome` room (a Stage) until Get started writes the device key `welcome.seen`; Home then shows one layout at every stage, each empty widget teaching with its own line, and every app's root shows one `first_open` card. The import and Open Settings buttons send `import:<store>` and `open_settings:<store>`, which the runtime answers through the door's `enrol_store` and `open_settings`; `permission_refused(store)` is what a refusal reads. (target) The core's door does not yet implement those three, nor tell the room plane the platform (`reminders_source` stands in for iOS), and no starter note is seeded.

## 1. Who owns what

| Layer | Owns |
| --- | --- |
| Vault ([`crates/vault`](../../../crates/vault)) | Schema, typed commands `<kind>.<verb>`, commit guard, history, trash, purge rules |
| `crates/domain` | One module per app (`apps/`): its kinds and reads; the one action table (`catalogue.rs`); pure helpers. No proto. The SQL authorizer, not crate walls, keeps a module to its tables |
| Core | Runs reads and actions, the draft service, the notification scheduler, followers |
| Room builders ([`crates/screens/src/room`](../../../crates/screens/src/room)) | Turn typed read results into a `Room`; hold selection, search, form and keep-my-place state; map each `selector_id` to a handler. `blocks`, `form` and `frame` build every block and slot; `Sel` claims selectors and refuses a repeat; `Rooms` holds a stack per tab and routes `RoomEvent`s; `snapshot` renders a room as text (`tests/rooms/*.txt`, `CENTRAID_BLESS=1` writes them) |
| Shells | Draw rooms and blocks, send `RoomEvent`s, perform effects and the hand-written native list (section 5.4) |
| Assistant | Catalogue and export generated from `ACTIONS` alone, so a screen change never moves `tools_hash` ([contract](../assistant/contract.md)) |

A shell names no screen, no action and no vault command: an element's `selector_id` is the only address. Deleted with the old plane: `manifest.json`, `load(app, query, params)`, `Screen::load`, `Route`-carrying rows, `Denied`, `<app>_screens.proto`.

## 2. The read registry (M1)

A read is a `const` declaration in the app's module of [`crates/domain/src/apps`](../../../crates/domain/src/apps), a [`Read<Row>`](../../../crates/domain/src/read/mod.rs):

| Field | Meaning |
| --- | --- |
| `name` | `<module>.<read>`; unique |
| `shape` | `ByKey`, `BoundedChild`, `Aggregate` or `PagedList` |
| `sql` | One read-only statement; all joins, filters, sums and counts run in SQLite, before `LIMIT` |
| `params` | Typed names; a civil day is the vault's `Day`, a zone is a parameter, never the host's |
| `row` | A typed result struct (no `Value` maps); the screen takes it as is |
| `reads` | Tables read. The authorizer records the tables a prepared statement touches; the declaration must equal them |
| `across` | Tables of other modules this read joins, listed apart. A cross-app read is the reader's own SQL; a cross-app write is an action, never SQL |
| `bound` | `BoundedChild`, `Aggregate`: the most rows it may return; `PagedList`: the page size (default 50, at most 200) |
| `cursor` | `PagedList`: the `ORDER BY` tuple as `(result column, keyset parameter)` pairs, the last a unique column. A list with none fails the registry test |

**Authorizer.** Every prepared statement runs under SQLite's authorizer (`read::authorizer`, installed for as long as the read-only `Reader` connection lives): read-only, a function allowlist, and denial of `locker_item_field.value_sealed`, `locker_item_field.value_blob` and `locker_item_passkey.private_key` for **every** module, Locker's included; only `core::locker` reads them. A statement touching a table not in `reads ∪ across` fails to prepare.

**Plan gate.** Each read passes `EXPLAIN QUERY PLAN` at test time; a plan outside its shape fails, and the only exceptions are rows in the query-plan allowlist (a count that only shrinks, [`contracts/ledgers/query-plans.json`](../../../contracts/ledgers/query-plans.json), `pages`, a row per read with its reason; it holds none today). The gate is [`crates/domain/tests/read_registry.rs`](../../../crates/domain/tests/read_registry.rs).

| Shape | Plan rules |
| --- | --- |
| `ByKey` | One row by a unique or primary key, equality on the whole key; no `SCAN`, no temp B-tree |
| `BoundedChild` | Rows of one parent: the index's leading column is the parent; constant `LIMIT` ≤ `bound` ≤ 200; no `SCAN`; order satisfied by the index |
| `Aggregate` | `COUNT`/`SUM`/`MIN`/`MAX`, optionally `GROUP BY` a schema-bounded key (category, month, metric); every table reached by `SEARCH` or a covering-index range; a temp B-tree for `GROUP BY` only with an allowlist row; result ≤ `bound` rows |
| `PagedList` | Total order ending in a unique column; keyset predicate; `LIMIT :n`; no `SCAN`; no temp B-tree for `ORDER BY` |

**Keyset cursor.** `c1.` + base64url (no padding) of the JSON `[read_name, k1, …, id]`: the last returned row's `ORDER BY` tuple. Opaque to shells. A cursor naming another read, or with the wrong arity, is refused as a `Failed` room ("This list changed. Reload."). A page fetches `n + 1` rows and returns `n`; the extra row only decides `next`. A first page binds the highest string `char(1114111)` for each key (it sorts after any id, instant or slug), so the predicate keeps its index seek; a key that runs upward binds `i64::MIN`. Direction is part of the read, never of the cursor. A section carries `next_page_selector_id` when `next` exists; the shell sends a `RoomTap` on it when the last row scrolls into view, and Rust appends the page.

**Read context.** A room's loads record the union of their `reads ∪ across` (`read::ReadContext`). A commit publishes the tables it wrote (the names in [`history/shape.rs`](../../../crates/vault/src/history/shape.rs)); every open room whose context intersects reloads. A reload re-runs each read of the room, and a `PagedList` re-reads the rows already loaded (one statement, `LIMIT` the loaded count, capped at 500; beyond the cap the tail pages are dropped and `next` is set). A room is `Loading` only before its first answer; a reload keeps the old blocks drawn.

**Room state (M3).** `Loading | Ready | Failed`. There is no `Denied`: apps are not principals. A failed read is `Failed` with the core's sentence and a retry selector, never an empty room and never `0` for unknown. Locker's wall is a `wall` block inside `Ready`, not a state.

Four reads, plans checked against `001_baseline.sql`. They are declared as `photos.library`, `entity.starred`, `entity.in_home` and one `<app>.trash` per app (`calendar`, `reminders`, `notes`, `docs`, `photos`, `health`, `people`, `money`, `locker`, `shared`), each naming the kinds its app lists. A holder's count is `entity.held_counts` (a `GROUP BY kind` of what a home holds), `money.account_lines` or `people.touches_held`: `Aggregate` reads that answer one row per kind.

| Read | Shape | Statement and plan |
| --- | --- | --- |
| Photos library | `PagedList` | `WHERE kind='photo' AND parent_id IS NULL AND deleted_at IS NULL AND (created_at,id) < (:a,:b) ORDER BY created_at DESC, id DESC LIMIT :n` → `entity_by_created` |
| Starred of a kind | `PagedList` | `WHERE kind=:kind AND starred_at IS NOT NULL AND deleted_at IS NULL AND (starred_at,id) < (:a,:b) ORDER BY starred_at DESC, id DESC` → `entity_starred` |
| What a home holds, one kind | `PagedList` | `WHERE parent_id=:home AND kind=:kind AND deleted_at IS NULL AND (updated_at,id) < (:a,:b) ORDER BY updated_at DESC, id DESC` → `entity_by_home`. A read of a home without `kind` sorts in a temp B-tree: name the kind |
| A Trash list | `PagedList` | `FROM entity INDEXED BY entity_trashed WHERE deleted_at IS NOT NULL AND trashed_by IS NULL AND kind IN (…) AND (deleted_at,n) < (:a,:b) ORDER BY deleted_at DESC, n DESC` → `entity_trashed`. Only rows trashed on their own; a capture returns with its item |

## 3. The "With <name>" timeline (S11)

A person's page holds one section per source; each is a `PagedList` on an index that already exists, and the preview shows the first page's first few rows with the section's own "Show all". No section shows a count (a count is an unbounded aggregate). `:person` is the person's id; `:after`, `:after_start` and `:after_id` are the first-page sentinel or the last row's key. Plans below were run against `001_baseline.sql`, and the registry test holds each: `people.with_events`, `with_payments`, `with_workouts`, `with_catch_ups`, `with_photos`, `with_docs` and `with_notes`.

```sql
-- Events (ordered by when the event starts; event_guest.starts copies event.starts)
SELECT ev.id, e.title, ev.starts
  FROM event_guest g JOIN event ev ON ev.id = g.event_id JOIN entity e ON e.id = ev.id
 WHERE g.person_id = :person AND e.deleted_at IS NULL AND (g.starts, g.event_id) < (:after_start, :after_id)
 ORDER BY g.starts DESC, g.event_id DESC LIMIT :n;          -- event_guest_by_person_start, no temp B-tree

-- Payments, Workouts, Catch-ups: one read each, :kind = 'txn' | 'workout' | 'touch'
SELECT e.id, e.title FROM edge x JOIN entity e ON e.id = x.from_id
 WHERE x.to_id = :person AND x.rel = 'with' AND e.kind = :kind AND e.deleted_at IS NULL AND x.from_id < :after
 ORDER BY x.from_id DESC LIMIT :n;                          -- edge_to, no temp B-tree

-- Photos (people in photos; library photos only, never a capture homed in an item)
SELECT e.id, e.title FROM edge x JOIN entity e ON e.id = x.from_id
 WHERE x.to_id = :person AND x.rel = 'depicts' AND e.deleted_at IS NULL AND e.parent_id IS NULL AND x.from_id < :after
 ORDER BY x.from_id DESC LIMIT :n;                          -- edge_to

-- Docs (documents about the person, top level only)
SELECT e.id, e.title FROM edge x JOIN entity e ON e.id = x.from_id
 WHERE x.to_id = :person AND x.rel = 'about' AND e.kind = 'document' AND e.deleted_at IS NULL
   AND e.parent_id IS NULL AND x.from_id < :after
 ORDER BY x.from_id DESC LIMIT :n;                          -- edge_to

-- Notes (a note about the person, or one whose [[…]] resolves to them); ids only, the merge needs one column
SELECT m.note_id AS id FROM mention m
 WHERE m.to_id = :person AND m.note_id < :after
   AND EXISTS (SELECT 1 FROM entity e WHERE e.id = m.note_id AND e.deleted_at IS NULL)
UNION
SELECT x.from_id FROM edge x
 WHERE x.to_id = :person AND x.rel = 'about' AND x.from_id < :after
   AND EXISTS (SELECT 1 FROM entity e WHERE e.id = x.from_id AND e.kind = 'note' AND e.deleted_at IS NULL)
ORDER BY id DESC LIMIT :n;                                  -- MERGE (UNION) of mention_by_target and edge_to, no temp B-tree
```

Ids are UUIDv7, so `ORDER BY id` is by when the item was made. The Notes section reads ids; titles come from a `ByKey`/`BoundedChild` read on the page's ids in the same load (adding a title column puts a temp B-tree in each leg). Events order by the stored `starts` text, so a date, a floating and a zoned start sort by their text, not strictly by instant. Locker items are not a section: a Locker item linked to a person shows in that person's `linked` footer.

## 4. The action catalogue (M4)

An action is `(kind, verb, qualifier)` and wraps **one vault command** (or the same command over `ids[]`), so an action's name is the command's: `<kind>.<verb>` for a kind or a shared group (`entity`, `tag`, `flag`, `edge`, `link`, `container`, `concept`, `history`, `follow`, `alert`, `vault`, …). A screen or chat may run any kind's action: Calendar ticks a task, Notes writes a journal entry. Actions belong to kinds, not apps.

| Part | Rule |
| --- | --- |
| `kind` | An entity kind or a command group, as in `vault-commands.txt` |
| `verb` | One word of the closed list below |
| `qualifier` | Optional. Fixes the variant of one command that a separate member intent needs: the arrival route (`txn.add` / `csv`, `event.propose` / `ics`) or the one field a narrow edit sets. Two actions never share `(kind, verb, qualifier)` |
| `input` | A typed struct taken from the vault command's input type; no free-form map. A minted id is declared on the field and the core mints it |
| `target` | `One(id)` or `Set(ids[])` (below) |
| `here` | Which pre-filled scope the action accepts (below) |
| `inverse` | How Undo takes it back (below) |
| `confirm` | `none`, `outlined` or `owner` (below) |
| `chat` | `Direct(Say)` or `Handoff(reason)` (section 7). `Say` is one verb of [`verbs.json`](../../../contracts/assist/verbs.json), the kinds the model says it on, and the narrowing it names (`edit:cadence`) |

The table is [`crates/domain/src/catalogue.rs`](../../../crates/domain/src/catalogue.rs): **131** actions, one for each of the 124 commands whose verb is an action verb, and seven more where one command serves a second intent (`flag.set` and `flag.clear` for star, pin and archive, `account.edit` for a currency change, `txn.add` and `event.propose` for a file). An action is named `kind.verb`, or `kind.verb/qualifier` when its qualifier tells it from another; Undo and the census use that name. Each row's `input` is held to the command's own schema by the registry test.

**Closed verb list.** [`command_list.rs`](../../../crates/vault/tests/command_list.rs) holds the vault's 97 verbs. The catalogue narrows them to the **76** a member or the assistant intends, and the 21 below are **system verbs**: called by core services and followers, never by a screen or chat. A test holds `ACTION_VERBS ∪ SYSTEM_VERBS` equal to the vault's `VERBS`, so a new vault verb must be classified.

| Set | Verbs |
| --- | --- |
| System (21) | `advance_cursor` `calendar` `camera_roll` `collect` `contacts` `counts` `drop` `files` `health` `health_readings` `mark_unlock_failed` `mark_unlocked` `mark_used` `reminders` `remember_layout` `save_turn` `settle_proposal` `stage` `statement` `undo` `write` |
| Action (76) | `add` `add_date` `add_guest` `add_item` `add_note` `add_relationship` `apply` `asset_add` `asset_remove` `asset_reorder` `cancel` `categorize` `clear` `color` `complete` `confirm_match` `create` `create_text` `delete` `dismiss_match` `duplicate_item` `edit` `edit_date` `edit_item` `edit_occurrence` `empty_trash` `export` `export_all` `export_csv` `export_ics` `export_vcf` `export_zip` `import` `import_csv` `import_vcf` `keep_version` `link_transfer` `locate` `log` `merge` `move` `organize` `prefer_contact_point` `propose` `purge` `record` `remove` `remove_contact_point` `remove_date` `remove_field` `remove_passkey` `rename` `reopen` `reorder_contact_points` `replace` `respond` `restore` `restore_version` `retitle` `save_contact_point` `set` `set_avatar` `set_carry` `set_cover` `set_field` `set_opening` `set_passkey` `set_place` `snooze` `split` `stop` `style` `take_stated` `totp_code` `trash` `unlink_transfer` |

A system verb can still name a member's action through another command: `checkpoint.record` is an action while `measurement.record` (the health follower's day totals) is not, so the split is **per command**: the catalogue holds the commands whose verb is an action verb, minus `measurement.record`, and `follow.*` except `follow.stop` and `follow.take_stated`. Undo is the runtime's own (`history.undo`), never a catalogue row. Followers' enrolment toggles ("Follow Contacts") are the follow service's, after the OS permission effect.

**Target sets (N15).** `ids[]` (1 to 500; more is refused with a sentence) is accepted by every shared verb: `trash`, `restore`, `move`, `set` (star, pin, archive), `tag.add`/`remove`, `categorize`. The whole set runs in **one commit**, with one `invoke_key`, one status line and **one Undo**. A set action is atomic: if one id is refused, none is written and the sentence names why.

**Here scope (N16).** `+` pre-fills from where the member stands. The catalogue maps each scope to input fields:

| Scope | Where | Fills |
| --- | --- | --- |
| `Home(id)` | Inside a notebook, folder, task list, calendar, or a task (subtask) | `parent_id` |
| `Member(id)` | Inside an album or list | the `contains` edge, in the same commit |
| `Account(id)` | Inside an account | `account_id` |
| `Day(day)` | A calendar day | the start day |
| `Person(id)` | From a person's page | a `with`/`about` edge, in the same commit |

An action lists the scopes it accepts; a scope it does not accept is ignored, never an error. A `Member` or `Person` scope makes the action run the vault command plus the edge command in one commit, declared as a `with:` list on the catalogue row; Undo inverts both.

**Inverses (Undo).** Every action declares exactly one:

| Inverse | Applies to | How |
| --- | --- | --- |
| `Pair(action)` | `trash`↔`restore`; `set`/`clear` of star, pin, archive (`flag.*`); `tag.add`↔`remove`; `edge`/`link` `add`↔`remove`; `complete`↔`reopen`; `add`, `create`, `log`, `import*` (inverse: `trash` over the ids the commit made) | The paired action over the same `ids[]` |
| `Restore` | `edit`, `retitle`, `move`, `categorize`, `set_*`, `respond`, `cancel` of an event, `snooze` | `history.restore_many` over the `(entity_id, seq)` pairs the commit wrote, returned in the action's output. Where a verb writes no revision (trash, restore, star, pin, archive, tag) the inverse is a `Pair`, never `Restore` |
| `None` | `purge`, `empty_trash`, `merge`, every `export*`, `totp_code` | Not undoable; `purge`, `empty_trash` and `merge` are `outlined` |

A currency change on an account (`account.edit` with `currency`, N2) is `outlined`; its Undo is the inverse `account.edit` carrying the old currency, which rescales the figures back. Restoring an **earlier version** of an account that changes its currency goes through the same rescale, never a bare column write. An Undo whose record changed again is refused in the core's sentence and the later change stays.

**Confirm classes.**

| Class | When | Drawn as |
| --- | --- | --- |
| `none` | Everything with an Undo: trash from a swipe, a menu or a set, edit, move, star | Nothing; the status line says what happened, with Undo |
| `outlined` | `purge`, `empty_trash`, `merge`, a currency change, and **trashing a non-empty holder** (notebook, folder, task list, account): the body names the count, "and its 12 notes" (N11, held by one `Aggregate` read) | `confirm` block in a sheet room, destructive outlined button, never an alert |
| `owner` | Locker (reveal, edit of a sealed value, export), every `export*` verb, the recovery key, restore | The OS owner check (an effect), then the action. **A single visible, unsealed item opens the OS share sheet with no owner check (N13)**; that is an effect, not an action; a Locker item cannot be shared |

## 5. Rooms and blocks (M6)

### 5.1 The seven rooms

A `Room` is one of seven kinds (`RoomKind`, as named in [behaviour](../design/behaviour.md#rooms)). The room owns the header, back, search, the empty/loading/failed states, the status line, selection and the gutter. Fields: `kind`, `key` (the screen's stable identity for keep-my-place and snapshots; never shown, never routed on), `header`, `band`, `state` (`loading | ready | failed`), `status_line`, `search`, `selection`, `restore`, `secure`.

| Room | Holds | Slots it draws |
| --- | --- | --- |
| `HOME` | Vault lockup, `tiles`, `glance`, one status line, one trailing verb | `band` (Home, Chat, Backup), `search` |
| `APP_PLACE` | An app root: title, `subtitle`, at most two `keys` (the funnel via `header.filter`, a filled `+` or Select), blocks or a canvas | `band` (two to four tabs, then More), `search`, `selection` |
| `PUSHED_PAGE` | A drilled page: `back` to the named parent, at most one trailing key (a "…" `menu` counts) | `search` in a list page |
| `EDITOR` | Full screen, `form` or `note_editor`; band hidden | `status_line` hosted inside |
| `SHEET` | One `confirm`, `menu` or `form` | `status_line` hosted inside |
| `SYSTEM_PLACE` | Settings, Backup: section and row blocks only | `band` on a root; `back` on a sub-page |
| `STAGE` | Full-bleed media: a `photo_grid` viewer's slideshow or a video; no header or band; a swipe down closes | None; the shell draws one close key |

`secure` is set on every room that draws a Locker value: the shell shields capture and keeps keyboard and clipboard learning off.

### 5.2 Room slots (not in the block list)

| Slot | Fields and meaning |
| --- | --- |
| `header` | `title`, `subtitle` (scope line; `subtitle_clear_selector_id` shows ✕ when the scope can be cleared), `back` (`label` of the named parent, computed by Rust), `keys[]` (`RoomKey`: `role` `ADD`/`TOOL`/`MENU`/`VERB`, `icon`, `label`, optional `menu`), `filter` |
| `filter` (`RoomFilterMenu`) | The funnel's whole menu as `menu` sections (checked options, submenus, then the sort, then any view choice), `filtering` (draws the funnel solid; "Clear filters" stands first), `clear_selector_id` |
| `band` | `tabs[]` (`label`, `icon`, `selected`), `home_selector_id`, `search_selector_id`, `more` (a `menu` ordered: following, import and export, Trash) |
| `status_line` | `sentence`, `action_label` (Undo, or empty), `refused`. One line, never a toast |
| `search` | `open`, `term`, `placeholder`, `corrected` ("Including results for …"), `containers[]` (rows for a matched notebook, album, list, folder), `ask` (the Ask row; absent in Locker) |
| `selection` | `on`, `label` ("3 selected"), `count`, `select_all_selector_id`, `done_selector_id`, `actions[]` (the verbs valid for the whole target set) |
| `restore` | Keep-my-place state (section 6) |

### 5.3 Blocks

Twenty-three blocks sit in `RoomBlock`; with `filter`, `search` and `selection` that is **26 blocks**, plus the room's `status_line`, plus four canvases. A section may hold blocks one level deep; a section never holds a section or a canvas.

| Block | Fields (meaning) |
| --- | --- |
| `hero` | `title`, `noun`, `mark`, `lines[]` (finished facts), `chips[]`, `primary` (one action: the one-tap catch-up), `menu` ("…") |
| `section` | `heading`, `count_label`, `trailing` ("Show all"), `blocks[]`, `next_page_selector_id`, `selector_id` |
| `row` | `title`, `meta`, `trailing` + `trailing_tone`, `chips[]`, `mark` (glyph, thumb or check), `a11y_label`, `dimmed`, `pending`, `selected`, `menu` (long-press), `swipe` (trailing swipe, trash) |
| `facts` | `facts[]`: `label`, `value`, `kind` (text, date, money, link, phone, email, address, secret), `open_selector_id`, `copy_selector_id`, `sealed` + `reveal_selector_id` (a masked value) |
| `form` | `fields[]`, `repeats[]` (a repeatable child row with `add`), and one of `autosave` (prose) or `explicit` (Cancel/Save, `dirty`, `drafted`) |
| `choice` | `label`, `style` (segmented 2–4, menu, list, chips), `multiple`, `options[]` (`id`, `label`, `selected`) |
| `figure` | `label`, `value` (finished, units and currency explicit), `caption`, `tone`; one number, never a chart |
| `prose` | `text`, `spans[]` (link ranges, each a selector) |
| `media` | One image, video, scan or file: `kind`, `thumb.ref`, `aspect_milli`, `caption`, `duration_label` |
| `progress` | `label`, `done`, `total`, `count_label`, `cancel`; determinate with exact counts |
| `empty` | `glyph`, `title`, `body`, `action` (an empty state with something to do carries it) |
| `wall` | Locker's locked state: `title`, `body`, `unlock` (starts the owner check), `failure` |
| `tiles` | Home's app tiles: `label`, `subtitle`, `glyph` |
| `glance` | A widget card: `title`, `lines[]`; the same shape is written to the widget snapshot (D6) |
| `trash` | `heading` ("Trash · 4"), `retention` ("30 days, then erased"), `rows[]` (`title`, `meta` "Deleted … · Erased …", `restore_selector_id`, `purge_selector_id`), `empty_trash` |
| `confirm` | `class` (outlined, owner), `title`, `body`, `warning` (one amber line), `confirm_label`, `cancel_label` |
| `menu` | `sections[]` of items (`label`, `secondary`, `icon`, `destructive`, `checked`, `enabled`, `submenu[]`): the More sheet, a "…" menu, a long-press menu |
| `attachments` | Footer: `items[]` (rows), `add` (a `menu`: Scan, Choose file, Photo) |
| `linked` | Footer: `items[]`, `add`. Hand-made links only; shown on both ends; no direction |
| `mentioned_in` | Footer: `items[]`, the notes whose `[[…]]` resolve here |
| `says` | Footer: `source` (`PHONE` or `STATEMENT`), `fields[]` (`label`, `stated`, `mine`, `take_selector_id`), `take_label`. "Phone says" / "Statement says" |
| `earlier_versions` | Footer: `summary`, `count`, one `selector_id` that opens the versions page (a list of `row`s with Restore and Keep) |
| `origin` | Footer: `line` ("From Contacts, 3 Nov"; "Shared from Safari"), optional `selector_id` |
| `filter`, `search`, `selection` | Room slots above |

**The shared text field.** One field per platform replaces the old clean gate. It owns caret, selection and composition (IME) and sends `RoomChange` only for a committed edit, with `seq` rising per field. Rust answers with the value and `rev`; the shell adopts Rust's value only when it differs and no edit above its last `seq` is unsent, so the caret never jumps. `RoomText.kind` is `LINE`, `PARAGRAPH`, `EMAIL`, `PHONE`, `URL` or `NUMBER`; `chips[]` carry a typed date that became a removable chip (Reminders). A field with `focused` takes focus when the room appears (capture in two seconds, N18). Money's field is a keypad entry whose `RoomMoney.display` is finished by Rust (formatting law: [`money-render.json`](../../../contracts/screens/money-render.json)); the shell never formats a figure.

**Form rules.** Prose autosaves (`autosave`: `phase`, `label`, `reload_label` on a conflict). A structured form has Cancel and Save and one "Discard changes?" confirm when dismissed dirty. An explicit new-item form keeps a draft (D1), except Locker's, whose unsealed values never reach disk. A stale save is refused with the vault's sentence and the words stay.

### 5.4 Native by construction

What moves into Rust is **which blocks a screen holds, in what order, with what data**. How a block looks and behaves is native code written once per platform from its own components. No web view, no cross-platform toolkit.

1. **Blocks state meaning, never layout.** "A row with a destructive action", "a choice of one from three", "a form with a repeatable child". Never a colour, a position or a size in points or dp.
2. **Chrome is the platform's; content is the kit's** ([behaviour § Controls](../design/behaviour.md#controls)).

| Meaning | iOS | Android | Drawn by |
| --- | --- | --- | --- |
| Navigation bar, back, title, trailing verb | `NavigationStack`, edge swipe | Top app bar, predictive back | Platform |
| App band, round keys, search field | Tab bar and floating controls, Liquid Glass | Navigation bar and floating controls, native look | Platform |
| Sheet grabber and detents | `.sheet` detents | M3 modal bottom sheet | Platform; content is the kit's `OptionSheet` |
| "…" menu, row long-press menu | `Menu`, `contextMenu` | `DropdownMenu` | Platform; Rust supplies rows and words |
| Row swipe to trash | `swipeActions` | Swipe to dismiss | Platform gesture, kit row |
| Date and time | `DatePicker` | M3 date and time pickers | Platform |
| One thing to do, secondary verb, link | `KitInkButton`, `KitOutlineButton`, `KitLink` | `InkButton`, `OutlineButton`, `KitLink` | Kit |
| Two to four views, filter chips | `KitSegmented`, `KitChip` | `KitSegmented`, `KitChip` | Kit |
| Destructive confirm | `ConfirmSheet` | `ConfirmSheet` | Kit, never an alert |
| Loading, empty, failure | `ReadStateView` | `ReadStateView` | Kit |
| Text entry | The shared text field | The shared text field | Kit |

Each platform keeps its own type scale, its haptics as `behaviour.md` rules them, and its accessibility roles. Values come only from the generated tokens.

3. **No lowest common denominator.** A block that cannot feel right on one platform grows a platform variant, or the screen becomes a canvas. Never a per-app native screen; never a fifth canvas.
4. **Hand-written native, outside the spec:** the four canvases; widgets, the share extension and the Android receiver; system pickers (photos, files, contacts permission); notifications and their actions; the Locker wall's biometric prompt.
5. **Proof:** each block is built to its part board and, where Android draws differently, its Android board; a golden per block state (Roborazzi, committed, cropped); iOS simulator screenshots at the hand-offs.

### 5.5 The four canvases

A canvas is a `RoomBlock` arm that owns the room's scrolling area. At most one per room; blocks before it pin above, blocks after it pin below. A canvas takes finished words, never raw numbers to format, and sends `RoomCanvasEvent` (its own `selector_id` plus a typed payload) or `RoomTap`. A screen a block cannot draw well becomes one of these four or the block grows; there is no fifth.

| Canvas | Takes | Draws | Events back | Boundary |
| --- | --- | --- | --- | --- |
| `calendar_grid` | `view` (day, week, month, list, year), `anchor_day`, `days[]` each with `items[]` (event, task or person date: `time_label`, `all_day`, minutes, `done`, `overdue`, `needs_reply`), `now_minute`, step and Today selectors | The time grid of the view, the now line, dated reminders inline | `calendar_day` (pick), `calendar_create` (long-press an empty slot: day, minute), taps on items and keys | The view picker, stepper and "Needs reply" filter are blocks around it; no drag-to-move in v0 |
| `photo_grid` | `zoom` (years, months, all), `sections[]` of `tiles[]` (`thumb.ref`, `aspect_milli`, `starred`, `selected`), `next_page_selector_id`, optional `viewer` | The justified grid; the viewer (paging, pinch zoom, details sheet as `details[]` blocks, "…" `menu`, slideshow) | `photo_zoom`, `photo_page`, taps; selection through `RoomTap` | Only library photos (`parent_id IS NULL`); Places is a list of rows, not a map |
| `note_editor` | `title`, `body` (Markdown text), `rev`, `base_revision_id`, `autosave`, `suggest` (`[[`/`@` candidates), `assets[]`, `read_only` | The rich text, its formatting accessory and inline attachments | `note_edit` (text, `seq`), `note_trigger`, taps on suggestions | Autosave is Rust's; the body is plain text the vault stores, nothing native keeps a second copy |
| `chart` | `series[]` (`mark` line, bar, area or point; `points[]` with finished `x_label`/`y_label`, optional `y_low`/`y_high`), `x_ticks`, `y_ticks`, `rules[]`, `summary` (a11y), `readout_point_id` | One mark set shared by Money's charts and Health's trends | `chart_scrub` (a point id) | Every label is finished by Rust; the canvas keeps no unit or currency logic |

## 6. Gestures, selection, and keeping your place

**Row gestures (N15).** The same on every row of every kind:

| Gesture | Meaning | Mechanics |
| --- | --- | --- |
| Tap | Open (or toggle, in Select mode) | `RoomTap` on the row |
| Long-press | The row's `menu` | Platform menu; items per kind: **Open**, **Star** (or Unstar), **Pin** (Notes), **Move to…**, **Tag…**, **Share** (visible, unsealed kinds), **Select**, **Move to trash**; plus the kind's own verbs (**Done**, **Snooze**, **Merge**, **Archive**). Rust supplies the rows; a verb the kind lacks is absent, never disabled |
| Trailing swipe | Move to trash, **no confirm** | `row.swipe`; the status line says "{title} moved to trash" with Undo |
| Select | Many at once | A key (or a menu row) sets `selection.on`; a tap toggles; **one** `selection` bar holds the valid verbs for the whole set; one commit and one Undo for the set |

A kind that cannot be trashed from the swipe (a Locker item behind its wall) draws no `swipe`.

**Keep my place (N14).** Back keeps your place; ✕ clears search. Each room saves, **in memory only**, the state it needs to look the same on return:

| Saved on push | Restored on pop (`Room.restore`) |
| --- | --- |
| Scroll position as the first visible row's `selector_id` and `anchor_fraction_milli` (0–999 of how far past it is scrolled); never a pixel offset | The room re-scrolls to that row |
| `search_term` and the open search field | The same term and answer |
| `filter_selector_ids[]` (checked filter items) | The same funnel state |
| `lens` (view, zoom, list: the app's root choice) | The same view |

The shell reports scroll as `RoomScrolled{anchor_selector_id, anchor_fraction_milli}`; Rust keeps it with the room instance. `restore` is sent once, on the first `ready` after a pop; a reload never re-sends it. The **root lens** (Calendar's Day/Week, the Photos zoom, Money's last-used account, Reminders' smart list) also persists across launches in D3. A **cold start anchors every time view to Today**; a pop to a time view keeps its day.

## 7. Chat surfaces

[behaviour](../design/behaviour.md) and the [assistant skill](../assistant/SKILL.md) own the conversation. This page owns how chat reaches actions. **Chat reaches every action** (owner): no screen-only action exists.

| Surface | Which actions | What happens |
| --- | --- | --- |
| `Direct` | Parametric actions with an inverse or no destructive effect: create, edit, complete, move, star, tag, link, snooze, trash, restore, categorize, respond | The model's call runs as `actor='assistant'`; the answer shows a card with Undo |
| `Handoff(PickFile)` | `document.add`/`replace`, `photo.add`, `note.import`, `person.import_vcf`/`import_csv`, `txn.add`/`csv`, `event.propose`/`ics` | A card opens the screen with the inputs filled; the member picks the file |
| `Handoff(Reveal)` | `locker.totp_code`, any reveal of a Locker secret | The card opens Locker behind its wall; no secret enters a prompt |
| `Handoff(Open)` | what the assistant's runtime has no plan for yet: `link`, `attach`, `detach`, `respond`, `categorize`, `duplicate`, `apply`, `follow.stop`, and the actions whose kind the model has no word for (places, readings, dates, contact points) | The card opens the screen with the inputs filled |
| `Handoff(Destructive)` | `entity.purge`, `entity.empty_trash`, every `merge`, a currency change, `thread.clear` | The card opens the confirm sheet, filled |
| `Handoff(OwnerCheck)` | every `export*` | The card opens the screen; the OS owner check comes first, which a model's call cannot pass |

The **census** ([`catalog-census.csv`](../../../contracts/assist/catalog-census.csv), held by [`census.rs`](../../../crates/domain/tests/census.rs), regenerated with `cargo run -p centraid-domain --bin export-census`) lists every action with how chat reaches it, and fails a build that adds an action neither surface covers. The assistant's catalogue and the export in [`contracts/assist/export/`](../../../contracts/assist/export) are generated from `ACTIONS` and the model's kinds ([`chat.rs`](../../../crates/domain/src/chat.rs)) and no screen or read: a `Direct` action says one verb of [`verbs.json`](../../../contracts/assist/verbs.json) on its chat kinds, so each action maps to at most one chat verb. `cargo xtask model-pin` runs **once**, at the end of lane A, and again only when a catalogue change moves the prompt ([contract](../assistant/contract.md)).

A chat card holds no words of the item: it names an entity id and a short `qualifier` code (`due`, `balance`); a thread resolves titles when it opens, and a purged item draws "An item you deleted" (S1, S2).

## 8. The kind registry and the promise charter

Each kind declares in `crates/domain` one `KINDS` row ([`kind.rs`](../../../crates/domain/src/kind.rs), the rows in each app's module); the registry test (L7, [`kind_action_registry.rs`](../../../crates/domain/tests/kind_action_registry.rs)) took the place of `promises.rs` and fails a kind missing any of them, or whose row differs from the vault's own `entity_kind`, `home_shape` and `source_shape`. A promise that does not apply to a kind says so, with its reason (`Trash::Purged`, `Share::Never`, `Export::Within`):

| Declared | Keeps promise |
| --- | --- |
| Noun for trash and Undo ("note", "transaction") | P9 |
| Holder: which kinds it holds, and the held-count read (`Aggregate`) | P9 (N11) |
| Earlier-versions formatter | P1 |
| Export formatter and share formatter (portable file; the OS share payload) | P4 |
| Home shape (where it may sit; whether a capture may be homed in it) | P8 (S12) |
| Footers it takes (`attachments`, `linked`, `mentioned_in`, `origin`; `says` where followed) | P8, P3 |
| Trash read | P9 |

The charter is [promises](../product/promises.md). The registry tests also fail: a read with a full scan or a temp B-tree outside the allowlist; a read touching a sealed column; a `PagedList` with no cursor; an action with no inverse and no `outlined`/`owner` class; an action neither `Direct` nor `Handoff`; a screen-only action; a room whose selectors repeat (held by `Sel::finish`, which refuses the room, exercised across the room snapshot suites in `crates/screens/tests/room_*.rs`).

## 9. Notifications

One scheduler in core ([`crates/core/src/notify`](../../../crates/core/src/notify)) reads the vault's alert index (`reminder` ⋈ its owner minus `snooze`, kept by `centraid_vault::alerts`) and registers OS notifications. It pushes the whole desired set as `Event.notify` (`ScheduleNotifications`, `retain_delivered`); a shell applies it and answers with `NotifyRequest` (`launched`, `scheduled`, `presses`, `ask_permission`). A commit touching `reminder`, `snooze`, a due or start, or an item's trash reschedules.

| Rule | Detail |
| --- | --- |
| Targets | `reminder_target`: `event`, `task`, `person` (a `person_date`), `locker_item` (a dated field) |
| Done | **Only on a task alert**: `task.complete`. On an event, a birthday or a Locker expiry "Done" would read as cancelling or deleting, so those offer Snooze plus the OS's own dismiss, which writes nothing |
| Snooze | **Every alert**: `alert.snooze` with `until` one hour on. One mechanism, one `snooze` row per alert target (the same `(entity, date, field)` identity as `reminder`) |
| Clearing a snooze | In the vault: a task's due, lead or rule edit and finishing it; an event's time edit; a date or field edit |
| Locker copy | Masked: "An item in Locker expires soon". It names no item and no field |
| Imported dates | Silent until the member asks: a follower never writes a `reminder` row (N20) |
| Trash and purge | **Cancel the pending notification and remove the already-delivered banner** (`removeDeliveredNotifications`; `NotificationManager.cancel`) |
| Widgets | Rewritten on every commit that changes what they show (D6), so a trash or purge clears them at once |
| Platform limit | The scheduler registers the soonest alerts that fit the platform's pending cap and refills on every commit and launch |
| Payload | `centraid://open/<kind>/<id>`, plus action ids `done` and `snooze`; categories per `reminder_target` kind. No `Route` in any payload (D4) |

## 10. Device store (D1–D13)

Persisted outside the vault, so frozen: every key a shell or the core writes is listed once in the **device-key registry (D5)** ([`crates/core/src/device/registry.rs`](../../../crates/core/src/device/registry.rs)) with its version, and a test fails on an unlisted key or a JSON value without `"v"`.

| # | Shape | Version and notes |
| --- | --- | --- |
| D1 | **Drafts.** One record per `(vault_id, kind)`: `{"v":1,"kind":…,"fields":{…},"saved_at":…}`, replacing Calendar's proto-bytes-in-JSON | Never Locker. Cleared on Save, a confirmed discard and a vault switch |
| D2 | **Share-in inbox.** iOS app-group container, or Android app-private files. Per item `<uuid>/payload` and `manifest.json` `{"v":1,"type":"file\|text\|url","uti_or_mime":…,"name":…,"from_app":…,"received_at":…}` | The extension and receiver write files only; they never open the vault. The app files the item on next open and deletes it from the inbox; draining is idempotent by uuid. Mapping below |
| D3 | **View preferences** per `(vault_id, app)`: `{"v":1,"lens":…,"zoom":…,"account":…,"list":…}` | The Calendar lens, the Photos zoom, Money's last-used account, the Reminders smart list |
| D4 | **Notification and deep-link contract:** `centraid://open/<kind>/<id>`; action ids `done`, `snooze`; one category per `reminder_target` kind | A contract, versioned by this page; no `Route` in a payload |
| D5 | **The device-key registry** and its test | Every key below and every setting key, with owner and version |
| D6 | **Widget snapshots** (Today glance, Health glance): `{"v":1,…}` with `centraid://open` links | Renamed off `agenda`; rewritten on every commit that changes them |
| D7 | **Notification outbox and delivered store** (Android `centraid.notify.outbox`, `NotifyStore`; the iOS counterparts): `{"v":1,"items":[{"id","action":"done\|snooze","entity","date_id","field_id","at","key"}]}` | Replayed on launch through `task.complete` and `alert.snooze` with the stored `invoke_key`; deleted-store ids drive banner removal |
| D8 | **Keychain and secret keys** (recovery seed, words-saved marker, gateway tokens) and **settings keys** (backup rule and toggles, appearance, units, permission details, install id, follower device ids) | Listed in D5 with versions |
| D9 | **Followed-folder grants** (Android SAF tree URIs, iOS security-scoped bookmarks) | Listed in D5 |
| D10 | **Locker clipboard lease** (vault id, item marker, digest, expiry; never the secret) | Listed in D5 |
| D11 | **The backup plane's state file** (`plane.state_path()`) | Owned by the backup plane, out of this plane's changes; listed in D5 so the registry is complete |
| D12 | **Portable files:** the "Export everything" manifest, each kind's portable JSON/CSV header, Locker's export, the index file's version header | Each states a format version; one export test per kind |
| D13 | **Follow enrolment.** `follow.<store>`: `{"v":1,"on":true,"chosen":[…]}`, one per phone store this device enrolled | Core-owned; written when the OS grants the member's tap, deleted by a stop. Section 16 |

**Where D1–D12 live.** [`crates/core/src/device`](../../../crates/core/src/device): `registry.rs` (D5), `store.rs` (a file per key beside the vault, written through the registry), `draft.rs` (D1), `inbox.rs` (D2, the drain), `open_url.rs` (D4), `widget.rs` (D6: `widget.today`, rewritten on every commit that touches `event`, `task` or `entity`, and `widget.health`, rewritten on every commit that touches Health's tables). A shell reads and writes device keys through `DeviceRequest`, so its keys are checked by the same registry. `.ics` files drain into `event.propose`; Money `.csv` files stay in the inbox because Money's column mapping needs its account and column layout.

**Share-in mapping (D2, N8).** The inbox item's type decides the route; the route is named by format when one exists, and sets `arrived_via` (a pair the file refuses if not in `arrival_via_kind`):

| Inbox item | Becomes | `arrived_via` |
| --- | --- | --- |
| `text`, `url` | a note | `share` |
| An image or video | a photo | `share` |
| A PDF or any other file | a document | `share` |
| `.vcf` | people | `vcard` |
| `.csv` | the CSV import that matches (Money lines, people, Locker items) | `csv` |
| `.ics` | events | `ics` |

## 11. Money's CSV column mapping, from blocks

No fifth canvas. The import is a pushed page of blocks over the remembered layout (the `layout` of `account.remember_layout`: `delimiter`, `date_order`, `sign_mode`, `date_col`, `amount_col`, `debit_col`, `credit_col`, `indicator_col`, `indicator_out_value`, `desc_col`, `memo_col`):

| Block | Meaning |
| --- | --- |
| `choice` (menu) per column role | Which CSV column holds Date, Description, Amount (or Debit and Credit, or Amount and an indicator), Memo; options are the file's headers |
| `choice` (segmented) | `date_order` (month first, day first, year first) and `sign_mode` (signed, debit and credit, indicator, flip) |
| `section` of three `row`s | A three-row preview of the lines this mapping makes, with the sign and date as parsed |
| `empty` / `facts` | A sentence when the mapping cannot make a line ("This layout does not say which columns hold the amount") |
| `form.explicit` | Cancel and Import |

Import runs `txn.add` with qualifier `csv` over the lines in one commit (`arrived_via='csv'`; lines are hand lines the member can edit) and saves the layout with `account.remember_layout` in the same commit.

## 12. Vault facts this plane relies on

- **Stars, pins and archives are columns** of `entity` (`starred_at`, `pinned_at`, `archived_at`), never edges. Setting one stamps neither `updated_at` nor a revision. Star is the one mark of importance (Notes keeps Pin, which is about position).
- **One home column:** `entity.parent_id`, with `home_shape` saying which kind may sit in which. Albums and lists are edges (`contains`), because an item can be in several.
- **A capture is homed in its item.** A photo or document captured inside a payment, event, workout, note, task or person takes it as its `parent_id`; never inside a Locker item (its capture is a sealed field) or a reading. It goes to the trash with the item and comes back with it.
- **Library reads filter `parent_id IS NULL`:** every Photos read (library, videos, scans, places, search scopes) and Docs' top level. Attaching an existing library photo stays an `attached` edge. Moving a capture to the top level or into a folder promotes it.
- **Trash lists show only `trashed_by IS NULL`.** A capture is never listed alone.
- **A currency change** is `account.edit`; its Undo is the inverse `account.edit`, and restoring an earlier version that changes the currency goes through the same rescale. A relabel is refused if a figure would lose a fraction.
- **Merges** (`person.merge`, `concept.merge`, `place.merge`) re-point `entity.parent_id` from loser to winner before purging the loser.

## 13. Calls made here

Where the plan left a choice, the safest was taken. Reverse by editing this page and `room.proto` together.

| Call | Choice |
| --- | --- |
| Action verb list | The vault's 97 verbs narrowed to 76 by command class; the 21 system verbs are called only by core services |
| Chat verbs | `verbs.json` stays the model's word list; each action maps to at most one |
| Target set size | `ids[]` of 1–500, atomic |
| Here scopes | Five (`Home`, `Member`, `Account`, `Day`, `Person`), where the plan names three; `Member`/`Person` add an edge in the same commit |
| Composite actions | A row may list `with:` follow-up commands of the same commit; Undo inverts all |
| Page size | 50, at most 200; reload re-reads up to 500 loaded rows |
| Snooze length | One hour, as today |
| Locker items on a timeline | Not a section; they show in `linked` |
| Photos and Docs sections of a timeline | Library only (`parent_id IS NULL`) |
| Timeline headings | No counts |
| Places | A list of place rows; no map canvas |
| Calendar | No drag to move an event in v0 |
| Events from the shell | `RoomEvent` carries only member events; appeared, left, timers, data changes and effect results stay on the envelope's `ScreenEvent` |
| `account.remember_layout`, `thread.settle_proposal`, `locker.counts` | System: called by the import flow, the assistant's turn and reads |
| Room selectors | A caller-chosen stable label (`row/<id>`, `back`, `filter/clear`), claimed once per room; a snapshot prints it as `#label` |
| Room events a screen owns | A `Handler::Tag` (the screen's own), a field's change, a canvas event; local state (search, selection, filters, lens, scroll) is the runtime's |
| Undo from a room | The status line offers it for actions whose inverse is a `Pair`; a `Restore` inverse waits for `history.restore_many` |
| Settings keys | Appearance, units and details are core-owned device keys (`settings.*`, `{"v":1,"value":…}`); the shell reads `settings.appearance` at launch through `DeviceRequest` |
| Notifications, ids and window | `alert|<reminder id>|<fire key>`; a delivered banner stays 2 days past its moment (`alerts::KEEP_PAST_MS`) unless its item is trashed, purged, finished or moved, then it is named in `cancel_delivered_ids` |
| Notification presses | `Done` runs `task.complete`; `Snooze` runs `alert.snooze` an hour from the press, and a press whose snooze is already over is `EXPIRED`; each press is run once per its id (`notify.applied`) |
| Backup room | Reads `BackupStatusRequest` and draws the line, the waiting rows, the devices and "Back up now" (`DrainRequest`); `backup/pair` (`BackupPair`) handles pairing (`PairPhone`) |
| Share-in `.ics` and Money `.csv` | `.ics` drains into `event.propose` (`inbox.rs`); Money `.csv` stays in the inbox because Money's column mapping needs its account and column layout |
| Chat kinds | Two tables: `KINDS` says what a vault entity kind owes a member (section 8), and `chat::KINDS` says what the model may call things and which fields a question can name (18 kinds, the nine apps'). A `Say` names chat kinds, so `budget`, `rule` and `daily figure`, which are tables and not entities, are sayable |
| Qualifiers | `flag.set` and `flag.clear` are three actions each (`starred`, `pinned`, `archived`); `account.edit/currency`, `txn.add/csv`, `event.propose/ics`, `edge.add/contains`, `edge.remove/contains`, `task.edit/reschedule` and `person.edit/cadence` tell a second intent of one command apart |
| `Restore` | The vault has `history.restore_version` for one `(entity, seq)` and no `restore_many`; the core runs it over the pairs a commit wrote |
| `follow.stop`, `thread.clear` | `outlined`: no Undo exists (a stopped follow is the follow service's to resume) |

## 14. The wire a shell speaks

Requests, answered inside `centraid_call`; no symbol was added. `RoomRequest` (`open{key, tab, root}`, `send{instance, event}`) answers with the `RoomShown`s that changed (none for a scroll report or a stale selector); the same `RoomShown` is pushed as `Event.room` when a commit reaches a room's reads. `NotifyRequest` and `Event.notify` are section 9's. `DeviceRequest` (`get`, `put`, `delete`), `FollowRequest` (section 16) and `ShareInRequest` (drain the inbox) are bounded or, for the drain, cancellable. `AssistRequest.plan`, `.finished` and `.opened` decide the chat model's files (what to fetch, load and delete; a reload held back by a running turn): the transfer is the shell's, the rules are [`core/src/assist/files.rs`](../../../crates/core/src/assist/files.rs).

## 15. Adding to the plane

| You are adding | Do, in order |
| --- | --- |
| A read | The declaration in the module; the domain crate's tests run the plan gate; add an allowlist row only with the statement's home and a one-line reason |
| An action | The vault command ([vault-model](vault-model.md)); the catalogue row with `inverse`, `confirm`, `chat`; the census row; if the prompt moves, `cargo xtask model-pin` |
| A screen | Its board in `design/mockups/` first ([design](../design/SKILL.md)); a builder that returns a `Room` of existing blocks; a room-tree snapshot test |
| A block | A part board first; the `RoomBlock` arm and fields in `room.proto` with this page's row; both native blocks; a golden per state |
| A string | A `strings/` row, as today ([wording](../design/wording.md)); `cargo xtask rules copy` |
| A kind | The `KINDS` row (section 8) and the vault steps in [vault-model](vault-model.md) |
| A followed store | [following](following.md), section 16 |
| The C ABI or a wire message | [ffi](ffi.md) |

Proof is in [land](../land/SKILL.md): room-tree text snapshots, the registry test, Android block goldens, iOS simulator screenshots at the hand-offs.

## 16. Following a phone store (D13)

The member turns a phone store on from the More of the app that owns it; the core asks the shell to read it; the vault merges what the shell read. The rooms say the state, the core owns every decision about when to read and whether to ask, and a shell reads and answers. Nothing is written back to the phone. What a member is promised is [arrive-take-out](../product/rulings/arrive-take-out.md); the page that lists what each shell performs is [following](following.md).

| Store (`system`) | Owner and row in its More | The shell reads | May ask the OS |
| --- | --- | --- | --- |
| `contacts` | People: "Follow Contacts" | the address book | on the member's tap |
| `calendar` | Calendar: "Follow phone calendars" | the calendars, over a window | on the member's tap |
| `reminders` | Reminders: "Follow phone reminders"; Android answers `UNAVAILABLE` and the row says so | iOS Reminders | on the member's tap |
| `files` | Docs: "Follow a folder" | a folder the member picks (the picker is the ask) | the picker, on the member's tap |
| `health` | Health: "Follow Health" | the health store, read permission only; windows and a cursor | on the member's tap |
| `camera_roll` | Photos: "Follow camera roll" | the grant only (the camera-roll walk stays the pass service's) | on the member's tap |

**The wire** is `FollowRequest`/`FollowResponse` and the shell-effect channel of section 17 (`ShellStoreRead`, `ShellPhoneWatch`, `ShellOpenSettings`, `ShellReleaseGrant`, pushed as `Event.effect`). Field numbers are additive.

| Direction | Message | Meaning |
| --- | --- | --- |
| Room, on a tap | `FollowRequest{verb: ENROL, system}` through `Door::call` | The member's tap. Core mints an ask with `ask_permission` true and pushes it |
| Shell, app forward, a watch, a window | `FollowRequest{verb: TRIGGER, system}` (empty `system` is every store) | A trigger carries no data. For every store this device enrolled and the phone has not refused, core pushes one ask with `ask_permission` false. It never pushes one for a store not enrolled, refused, restricted or unavailable, and a trigger while an ask is in flight queues exactly one more |
| Core to shell | `Event.effect`: `store_read{system, ask_permission, window, cursor}`, `phone_watch{system, on}`, `release_grant{ref}`; a room's tap on a refused row asks `open_settings{system}` through `Outcome::effect` | `store_read`: read the store and answer with `PASS` (its `ask_id` is the effect's `effect_id`). `phone_watch`: start or stop watching (contacts, calendar, reminders) and send a `TRIGGER` for it on each change. `release_grant`: release the grant for one folder |
| Shell to core | `FollowRequest{verb: PASS, system, ask_id, grant, input_json, refused, background_refused}` | The answer to a `store_read`. `grant` is what the OS said; with `GRANTED`, `input_json` is the follow command's input (`origin`, `records`, `complete`, `since`, `gone`; for Health `{"workouts": …, "readings": …}`). An answer to an older ask is `stale` and ignored |
| Room, on the stop row | `FollowRequest{verb: STOP, system, input_json: {"ref"?}}` | Retires every origin of the store (or the one `ref`), forgets this device's habit, pushes `phone_watch` off and, for a folder, `release_grant`. Deletes nothing |

**Rules.**

1. **`ask_permission` is true only in the ask a member's tap made.** A trigger's ask never is. Core holds the enrolment as a device key (`follow.<store>`, D13), so "did this device enrol" is asked first, before any ask, exactly as the old keychain habit was; a vault restored onto a new phone is enrolled there once.
2. **A refusal ends reading.** A `REFUSED`, `RESTRICTED` or `UNAVAILABLE` answer sets the store's state; no trigger asks again until the member taps the row again (a `LIMITED` read is merged and said). The room offers the `OPEN_SETTINGS` effect for a plain refusal only; a restricted grant has no button that can change it.
3. **One ask in flight per store.** Triggers during it set one `queued` bit; the answer sends one more ask. A tap supersedes whatever is in flight. There is no clock: the machine is driven by triggers and answers, and tests count asks.
4. **The cursor is the origin's.** For Health the ask carries the cursor the vault holds for this install (`entity.origin_cursor`; absent or another install's is empty and the read is complete). The answer's command input carries the new one in `origin.cursor` with this install's `device_id`, which core sets itself, so it moves in the same commit as the records. A shell keeps none.
5. **A stop never erases.** `follow.stop` per origin, then the habit goes; the rows the follow filled stay. Following again revives the same origin.
6. **State is words from core.** The rows say "Following Contacts", "Contacts is off", "Only part of your phone's contacts was readable" from the same report the pass left (`Follower::report`); the room reloads when it changes (the `follow` watch, as the backup ledger's).

**D13: the enrolment key.** `follow.<store>` (`contacts`, `calendar`, `reminders`, `files`, `health`, `camera_roll`): `{"v":1,"on":true,"chosen":[…]}` (`chosen` is Health's types), core-owned, in the device store beside the vault.

**Not built (target).** The native adapters (Swift, Kotlin) that perform the following effects and send `FollowRequest`; until they land a shell that sends nothing leaves every store as it is. A background-window pass for Health (Android only) waits on the same adapters.

## 17. The shell-effect channel

A room never touches the phone. When a tap needs the phone, its screen returns `Outcome::effect(tag, kind)`; the runtime gives the effect an id, answers the event with it in `RoomResponse.effects`, and routes the shell's answer (`RoomEvent.effect_result`, carrying the id) back to the same room as `Input::Effect` under `tag`. The core asks on its own through `Event.effect` (following does); an answer to those is a request of its own (`FollowRequest{PASS}`), not a room event. The wire is `ShellEffect` and `ShellEffectResult` in [`room.proto`](../../../crates/api-proto/proto/centraid/core/v1/room.proto); every variant is defined now so the native lanes are briefed once. Bytes never cross: a file is a path the core wrote or a shell picked. A shell names no command and no screen, and does only what an effect says.

The old performers are the intended homes: iOS `ScreenPlatform.swift`, `LockerClipboardLease.swift`, `ShelfCopyExport.swift`, `Chat/ChatModelDownload.swift`; Android `kit/ScreenEffects.kt`, `kit/OwnerPrompt.kt`.

| Effect (answer) | iOS | Android | Used by |
| --- | --- | --- | --- |
| `store_read` (a `FollowRequest{PASS}`) | `CNContactStore`, `EKEventStore` events and reminders, `HKHealthStore` read-only, the document picker with a security-scoped bookmark, `PHPhotoLibrary` authorization | `ContactsContract`, `CalendarContract`, Health Connect `HealthConnectClient`, `ACTION_OPEN_DOCUMENT_TREE`, `READ_MEDIA_IMAGES`; Reminders answers `UNAVAILABLE` | Following (built in Rust; the performers are target) |
| `phone_watch` (none) | `EKEventStoreChanged`, `CNContactStoreDidChange` | content observers (`PhoneWatchers.kt`) | Following |
| `open_settings` (`ShellDone`) | `UIApplication.openSettingsURLString` | `Settings.ACTION_APPLICATION_DETAILS_SETTINGS`, or the notification channel page for `notifications` | Following (built); Notifications |
| `release_grant` (none) | drop the folder's bookmark | release the persisted tree URI permission | Following |
| `owner_check` (`ShellOwner`) | `LAContext` `deviceOwnerAuthentication` | `BiometricPrompt` with device credential (`OwnerPrompt.kt`) | Locker, every `export*`, recovery key, restore (target) |
| `share` (`ShellDone`) | `UIActivityViewController` | `Intent.ACTION_SEND` through a `FileProvider` | A single item's Share (target) |
| `save_file` (`ShellDone`) | `UIDocumentPickerViewController` export | `ACTION_CREATE_DOCUMENT` | Export (target) |
| `pick_file` (`ShellPicked`) | `UIDocumentPickerViewController` open | `ACTION_OPEN_DOCUMENT` | Docs, imports (target) |
| `pick_photo` (`ShellPicked`) | `PHPickerViewController` | the photo picker | Photos (target) |
| `scan_document` (`ShellPicked`) | `VNDocumentCameraViewController` | the document scanner | Docs, Money (target) |
| `clipboard_copy` (`ShellDone`) | `UIPasteboard` with `localOnly` and an expiry, the lease in `LockerClipboardLease.swift` | `ClipboardManager` with `EXTRA_IS_SENSITIVE`, cleared at the lease | Locker (target) |
| `photo_delete` (`ShellDone` or `ShellFailed{cancelled}`) | `PHAssetChangeRequest.deleteAssets` | `MediaStore.createDeleteRequest` | Photos Free up space (target) |
| `model_download` (`ShellDone`) | a background `URLSession` download (`ChatModelDownload.swift`) | `DownloadManager` or `WorkManager` | Chat (target) |
| `permission_status` (`ShellGrant`) | `UNUserNotificationCenter`, `PHPhotoLibrary`, `AVCaptureDevice`, the store's own status | `NotificationManagerCompat`, `checkSelfPermission` | Settings, the More rows (target) |

A refused grant answers `ShellFailed{grant}` or `ShellGrant{grant}` with one of `REFUSED`, `RESTRICTED`, `LIMITED`, `UNAVAILABLE`; a dismissed sheet is `ShellFailed{cancelled}`. Core words every sentence the member reads. Built here: the channel, `Outcome::effect`, `Input::Effect`, and the callers for following (`store_read`, `phone_watch`, `open_settings`, `release_grant`); the rest are defined and wait for their lanes.
