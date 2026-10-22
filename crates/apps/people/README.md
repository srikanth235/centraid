# `centraid-apps-people` — a personal CRM as a projection of the vault

People is five queries, twenty-five actions and thirty-three scopes. It stores nothing of its own ([#1135](https://github.com/srikanth235/centraid/issues/1135)): a person is an `entity` of kind `person` with its columns, and everything else a screen shows is another row joined by an edge. This crate is the read plane and the action table; the writes are `person.*` commands in `crates/vault/src/commands/{person,contact_point}.rs` and the shared verbs (`entity.*`, `flag.*`, `container.*`), and the phone shell reaches the reads through `crates/core`'s `app_query` ([`people.proto`](../../api-proto/proto/centraid/core/v1/people.proto)).

| Module | What it is |
| --- | --- |
| `manifest` | The app's `manifest.json`, parsed by the kit's parser at load time. |
| `queries` | What People reads, one table at a time: the circle's window, the star, the lists, the touches (computed last-contacted), the notes about a person, the yearly dates, and the three declared windows. |
| `roster` | `people`, `search` and `trash`: the three reads that answer in the people-row shape. |
| `person` | The sheet. |
| `dashboard` | The keep-in-touch summary: Reconnect, Upcoming and the latest touches. |
| `dates` | Civil time against a `today` the caller states, and elapsed time for cadence. There is no clock in this crate. |
| `phone` | The phone's readings of the folds: the roster's chips and sort, each person's cadence facts and each annual date's distance from `today`. |
| `commands` | The twenty-five actions as invocations, `invoke_key` mandatory. |

## How the model draws a person

| A screen's word | The model |
| --- | --- |
| a person, how you met, cadence | `entity` + `person` (`form` is `person`, `org`, `group` or `pet`) |
| starred | a `tagged` edge to `flag:starred` |
| a list | a `list` container with ordered `contains` edges; a person is in one at a time (`person.move`) |
| a touch | an `activity` of an activity kind with a `with` edge; the words kept of it are a `note` `about` the activity |
| last contacted | **computed at read** from the activities `with` the person |
| a note, a journal entry | a `note` `about` the person; an entry is about the owner, titled by its mood |
| a follow-up, a gift idea | a `task` `about` the person; a gift also carries the `gift` tag |
| the birthday | the person's `birthday` column (`MM-DD`, or `YYYY-MM-DD`); its reminder is always on |
| any other important date | a yearly all-day `event` `about` the person (R-FP-2) |
| a relationship | a `related` edge labelled by a `relation` concept |
| how to reach them | `contact_point` rows (one preferred per kind) |

**The circle is the people you keep**: every live person but the owner and a pet. The roster, the dashboard, the sheet, the search and Home's person hits answer for that one set.

## What this crate is allowed to contain

SQL, in any form, is refused by `cargo xtask rules` (`sql-confinement`): a read is a `PageQuery` over one table, and the paged door pages one table (a join is refused at the vault's door), so every read is a window and then, per table, the rows its ids name. `Read::among` names a set of ids only while it is small, and otherwise takes the table under the read's own predicate: a keyset page re-binds the whole `IN` list on every page, and the first cut took 19 s for a 5,000-person roster where the table scans take 0.56 s (R-1135-3-14). A write from a query is not expressible. A denial is a value (`Denial`), never an error.

## The rulings this crate is shaped by

R-1135-3-1 to R-1135-3-14 are in [docs/decisions.md](../../../docs/decisions.md#people). The ones a reader of this crate meets first:

- **A toggle is two actions.** `toggle-gift` is `complete-task` and `reopen-task`, `toggle-reminder` is `set-reminder`; three commands (`task.complete`, `task.reopen`, `event.edit`) are Agenda's and `ActionRow::pending_schema` names them until that lane lands.
- **Four actions are confirm-gated** by the manifest, which is the surface's gate: `trash-person`, `purge-person`, `delete-contact-channel` and `merge-people`. No command sets the command-level `confirm`.
- **A person holds what is written about them alone**: their notes, touches and yearly dates go to the trash and are purged with them; a task about them stays.
- **`people.limit` is 20-10,000**, the widest window in the tree and the manifest's own (D-1020-PE4); the walk reports `truncated` when it filled.
- **There is no clock here.** A civil date is read in a zone somebody stated (D-1020-PE7).

## The five queries

`people` is the roster: a window of the circle, newest-added first, with the star, the list, the reminders that are on and when each person was last touched. `person` is one sheet: the roster's row, nickname, how you met, contact points (with who else holds the same value), dates, notes and the touch log. `dashboard` folds Reconnect (most overdue first, ties by id), Upcoming (nearest first across the year boundary) and the newest 30 touches over the whole window. `search` is the vault's one index over `person` (name, nickname, role, how you met, contact points and the notes about them and about their touches), ranked, with a snippet. `trash` is the reversible shelf, most recently trashed first.

## On the phone

The v1 phone shell reaches `people` (as `roster`), `dashboard` (as `touch`), `person`, `search` and `trash` through `AppQueryRequest` arms 20-24. `party_id` on the wire is the person's entity id. Every civil date is answered in the device's zone (`tz`): the answer carries `today` and each annual date's `in_days` from it. The avatar hue is not stored (R-1135-3-8): `avatar_color` is `reserved` and a shell draws the hue from the id. `touches_known` and `channels_known` stay on the wire and are always true.

## Volume

`centraid_apps_kit::fixtures::year3_people` is the axis People's ceilings are stated at: 5,000 people (250 trashed) beside 100 pets and the owner, 10,000 yearly dates and 2,000 birthdays, 20,000 touches (8,000 with a note), 3,000 notes about people and 8,000 contact points. `tests/year3.rs` asserts that the walk reaches past the door's 500-row page, that the circle holds nothing else, and that last-contacted is the newest touch; `cargo test -p centraid-apps-people --test year3 -- --ignored --nocapture` prints the declared profile's numbers (the roster in 0.56 s and the dashboard in 0.49 s, a debug build on `ci-linux-x64-4c`, projected, never a ceiling).
