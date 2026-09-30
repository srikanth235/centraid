# `centraid-apps-people` — a personal CRM as a projection of the vault

People is 7 queries, **29 actions — the largest action surface of any bundled app** — and 20 scopes over six schemas, plus a demo seed. This crate is the read plane and the action table; the writes are `crates/vault`'s `people` schema (all twenty-eight), the `social` schema (four), and one `core.*` command — `core.merge_party`, the ontology primitive behind `merge-people`.

| Module | What it is |
| --- | --- |
| `manifest` | The app's `manifest.json`, parsed by the kit's parser at load time. Two copies of "which tables does People write" is how the two answers drift. |
| `queries` | The thirty statements, the taxonomy pair, the list and star fold, the reminder fold, and the three declared windows. |
| `roster` | `people`, `search` and `trash` — the three queries that answer in the people-row shape. |
| `person` | The sheet, and the two readings (links, obligations) that deny independently of it. |
| `dashboard` | The keep-in-touch summary, and the birthday rail the daily brief reads. |
| `journal` | The owner's entries folded together with what they logged. |
| `dates` | Civil time against a `today` the caller states, and elapsed time for cadence. There is no clock in this crate. |
| `phone` | The phone's readings of the folds (#1046): the roster's chips and sort, each person's cadence facts, and each annual date's distance from `today`. `crates/core`'s `app_query` answers them as `people.proto`. |
| `commands` | The twenty-nine actions as invocations, `invoke_key` mandatory. |

## The rulings this crate is shaped by

Every one is an answer to a way this crate could be wrong, and every one has a test named after it.

**D-1020-PE1 — independent denials, one type.** `Person { profile, links, obligations }` with `ReadState<T> = Loading | Denied | Ready(T)`. Revoking `tally.obligation` — a scope over **another app's table** — must not answer `{person: null}`: a member who uninstalled Tally would lose their grandfather's birthday. Both readings deny independently of the profile, and the fact lives INSIDE the state, so a denied reading has no list to draw as empty. `tests/three_state.rs` runs the real queries through a door that refuses one plane at a time. There is no sharing reading: v1 has no share plane ([#1029](https://github.com/srikanth235/centraid/issues/1029)).

**D-1020-PE2 — `merge_party` is exhaustive by construction.** The sweep is generated from the live schema rather than from a hand-kept registry: forty-four engine foreign keys onto `core_party`, and the composite `(type, id)` pointers into the entity supertype. Every column is planted by a row builder that reads each table's own schema, and zero rows name the folded-in party afterwards. Two registry findings fell out of generating it — see the receipt.

**D-1020-PE3 — the test-to-action ratio is fixed here.** Every command has a fixture case in `contracts/apps/people/commands.json` (61 steps over 33 distinct commands, 15 of them refusals on purpose), and each of the fourteen `once` commands has an idempotency replay: a repeated `invoke_key` writes no second row and no second invocation.

**D-1020-PE4 — `people.limit` is 20–10,000.** This crate honours the declared maximum, where the captured fixture stopped at 9,999; **nothing in the manifest explains why the number is 10,000 at all**, and every other app's widest window is 2,000. The parity mapping lowers this crate's answer onto the fixture's so the comparison stays exact.

**D-1020-PE5 — one nullable sort column, and it is the trash shelf.** Of the thirty statements, only `people.trash.profiles` orders by a column the DDL declares without `NOT NULL` (`people_profile.deleted_at`), so the kit's door refuses to CONTINUE a page over it. The shelf's predicate makes the column non-null and the door reads the DDL rather than the `where` — so the shelf is safe because `TRASH_ROWS` is exactly `MAX_PAGE_ROWS` and is never continued. A window of 501 refuses, and that is the demonstrated red. Where a nullable sort column must genuinely be continued, the adopted order is **nulls last, then by primary key**.

**D-1020-PE6 — four manifest confirmations, and one command-level park.** `trash-person`, `delete-contact-channel`, `merge-people` and `purge-person` (#1015 D1) carry `confirmation: "required"`, which is the DISPATCHING surface's gate. Exactly one of the thirty commands carries `confirm: true`, and it is `core.merge_party` — a NON-OWNER park, because an irreversible fold of one person into another is not a thing an assistant does on the member's behalf. Neither gate substitutes for the other.

**D-1020-PE7 — the birthday rail is civil time, in a zone somebody stated.** Reading the HOST's local midnight is wrong: a member's day is not the machine's. `dates` takes the civil date as an argument and there is no clock here to read the wrong one from; the phone's queries state it as the device's `tz`, else the vault's own zone (`app_query.proto`'s rule). **February 29 clamps to 28 February in a common year**, so a leap-day birthday still fires; the fixture carries one.

**D-1020-PE8 — a command's name and its owner schema must agree.** The gateway authorises by owner schema and the caller types the name, so a `people.*_contact_channel` command owned by `social` would answer to two different schemas; the registry refuses the split by construction. The three contact-channel commands are `people`-owned, and the manifest's three narrow `social` act scopes are now dead weight.

**D-1020-PE9 — the recurrence rollover is not People's to own.** `people.complete_task` refuses a task carrying an `rrule`, with a sentence naming `schedule.organize_task`. Reproducing the rollover here would re-introduce exactly the drift (#996 R21, ONT-27) that took People's own `toggle_task` away — a repeating task completed from People never got its next occurrence, because only Tasks' code knew how to spawn one.

**D-1020-PE10 — which parity lists are compared in order, and which as sets.** A list whose statement orders by a MINTED ID is compared as a set, because the fixture's `id-NNNN` tokens are assigned in first-appearance order across the whole bundle and a date whose id first appears inside a revision's snapshot gets a lower token than one that appears in its own table. That order is a fact about the canonicaliser. Six lists are named in `tests/parity.rs`; every other list is compared in order.

## The seven queries

The roster's window is a **walked page set** over `people_profile`, newest-created first. Everything else — the parties, the tags and the important dates — is `IN`-bounded by ids that walk returned. The host clamps a page to 500, so reading the window as ONE page would return five hundred of ten thousand; this crate walks the stated window and `truncated` is the walk's own answer.

`person` is the largest query in the app: the party, its profile, its contact rail with a collision search bounded by the values this person holds, and then the two readings. `dashboard` folds the same window into four counts. `journal` projects two shapes into one feed and is the one read in the workspace whose denial is deliberately NOT graceful — an empty marker set would leak journal entries into Notes' library. `search` ranks FTS hits (name, then role, then notes, as v0 did) and the fold keeps that order; on the phone only the `core.party` name index exists in `crates/search`, so the name index is the whole search. `trash` is secret-free by construction. Emptying it is `purge-person` (`people.purge_person`, one person per call): the party, the profile, its owned children (dates, handles, channels), its participation rows (attendance, circle and thread membership, the Tally friend row), the interactions about only them and their gift ideas go, and the entity cascade takes every link, tag and annotation on them; a task about them stays as the member's own. It is refused, naming the columns, while money, messages or any other `NO ACTION` record still names them — generated from the live schema, as the merge sweep is. `core.merge_party` folds two profiles into one (nickname and liveness included: a live side keeps the survivor live). `history` is the undo rail, row-filtered by the manifest to this app's own entity type.

## On the phone

The v1 phone shell reaches `people` (as `roster`), `dashboard` (as `touch`), `person`, `search` and `trash` through `AppQueryRequest` arms 20–24 (`crates/api-proto/proto/centraid/core/v1/people.proto`, `crates/core-ffi/CONTRACT.md` clause 4e). The roster is the live `people_profile` rows: a party with no profile — the owner, or a face-review party made with `core.add_party` — is not a People row, and a surface that makes a person for People makes it with `people.add_person`.

## Parity

`contracts/apps/people/` is a frozen golden, captured from an independent implementation's real handlers over a real vault: the app's own demo seed, then a script of all twenty-eight `people.*` commands, the four `social.*` ones and `core.merge_party`, then all seven queries at twenty-seven inputs. `tests/parity.rs` rebuilds the vault from `rows.json` and compares this crate's answers case by case.

## Volume

`centraid_apps_kit::fixtures::year3_people` is the axis People's ceilings are stated at, and it includes `people_profile` rows, not just parties: five thousand people, 250 of them trashed, 12,000 important dates with 6,000 live reminders, 20,000 interactions and 600 obligations. A shrunken axis runs on every `cargo test`; the measured run is `#[ignore]`d and its numbers are in the lane's receipt.
