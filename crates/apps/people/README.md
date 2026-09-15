# `centraid-apps-people` — a personal CRM as a projection of the vault

People is 7,849 lines of v0 TypeScript: 7 queries, **29 actions — the largest action surface of any bundled app** — 24 scopes over seven schemas, and a 90-line demo seed. Against that, six test files. This crate is the read plane and the action table; the writes are `crates/vault`'s `people` schema (all twenty-eight), the `social` schema (four), and one `core.*` command — `core.merge_party`, the ontology primitive behind `merge-people`.

| Module | What it is |
| --- | --- |
| `manifest` | v0's `app.json`, byte for byte, parsed by the kit's parser at load time. Two copies of "which tables does People write" is how the two answers drift. |
| `queries` | The thirty statements, the taxonomy pair, the list and star fold, the reminder fold, and the three declared windows. |
| `roster` | `people`, `search` and `trash` — the three queries that answer in the people-row shape. |
| `person` | The sheet, and the three readings that deny independently of it. |
| `dashboard` | The keep-in-touch summary, and the birthday rail the daily brief reads. |
| `journal` | The owner's entries folded together with what they logged. |
| `dates` | Civil time **in the vault's zone**, and elapsed time for cadence. There is no clock in this crate. |
| `commands` | The twenty-nine actions as invocations, `invoke_key` mandatory. |

## The rulings this crate is shaped by

Every one is an answer to a way the port could have been wrong, and every one has a test named after it.

**D-1020-PE1 — three denials, three readings, one type.** `Person { profile, sharing, links, obligations }` with `ReadState<T> = Loading | Denied | Ready(T)`. v0 makes ONE of the three independent — the share plane is caught and answered `null`; everything else sits in one `Promise.all` under one `try`, so revoking `tally.obligation`, a scope over **another app's table**, answers `{person: null}` and a member who uninstalled Tally loses their grandfather's birthday. The port makes all three readings, and the fact lives INSIDE the state: a denied sharing read has no `linked` and no `vault_count` to draw a chip on, where v0 ships `linked: null` and `vault_count: 0` on the same row. `tests/three_state.rs` runs the real queries through a door that refuses one plane at a time.

**D-1020-PE2 — `merge_party` is exhaustive by construction.** The sweep is generated from the live schema rather than from a hand-kept registry: forty-four engine foreign keys onto `core_party`, fifteen composite `(type, id)` pointers into the entity supertype, and one column the engine cannot see (`share_authority.principal_id`, polymorphic on a kind that selects a party, a circle, a harness or an automation — no single `REFERENCES` clause can express it). Sixty columns; fifty-nine are planted by a row builder that reads each table's own schema, and zero rows name the folded-in party afterwards. Two v0 registry findings fell out of generating it — see the receipt.

**D-1020-PE3 — the test-to-action ratio is fixed here.** Every command has a fixture case in `contracts/apps/people/commands.json` (61 steps over 33 distinct commands, 15 of them refusals on purpose), and each of the fourteen `once` commands has an idempotency replay: a repeated `invoke_key` writes no second row and no second invocation.

**D-1020-PE4 — `people.limit` is 20–10,000 and v0 stops at 9,999.** The clamp is a look-ahead row the same file removed when the probe became the host's. The port honours the declared maximum; **nothing in the manifest explains why the number is 10,000 at all**, and every other app's widest window is 2,000. The parity mapping lowers the port's answer onto v0's so the comparison stays exact.

**D-1020-PE5 — one nullable sort column, and it is the trash shelf.** Of the thirty statements, only `people.trash.profiles` orders by a column the DDL declares without `NOT NULL` (`people_profile.deleted_at`), so the kit's door refuses to CONTINUE a page over it. The shelf's predicate makes the column non-null and the door reads the DDL rather than the `where` — so the shelf is safe because `TRASH_ROWS` is exactly `MAX_PAGE_ROWS` and is never continued. A window of 501 refuses, and that is the demonstrated red. Where a nullable sort column must genuinely be continued, the adopted order is **nulls last, then by primary key**.

**D-1020-PE6 — three manifest confirmations, and one command-level park.** `trash-person`, `delete-contact-channel` and `merge-people` carry `confirmation: "required"`, which is the DISPATCHING surface's gate. Exactly one of the twenty-nine commands carries `confirm: true`, and it is `core.merge_party` — a NON-OWNER park, because an irreversible fold of one person into another is not a thing an assistant does on the member's behalf. Neither gate substitutes for the other.

**D-1020-PE7 — the birthday rail is civil time, in the vault's zone.** v0's `daysUntilMonthDay` builds `new Date(now)` and reads the HOST's local midnight. A gateway on a VPS runs UTC and a member in UTC−07:00 disagrees with it for seven hours of every day, so the _birthday, daily brief_ notification fires a day early or late depending on which machine answered. `dates` takes the vault's own civil date as an argument and there is no clock here to read the wrong one from. **February 29 clamps to 28 February in a common year**, so a leap-day birthday still fires; the fixture carries one.

**D-1020-PE8 — a command's name and its owner schema must agree.** v0 names three commands `people.*_contact_channel` and declares `ownerSchema: "social"` on all three. The gateway authorises by owner schema and the caller types the name, so the two halves answer to two different schemas; the registry refuses the split by construction. They are `people`-owned here, and the manifest's three narrow `social` act scopes are now dead weight.

**D-1020-PE9 — the recurrence rollover is not People's to own.** `people.complete_task` refuses a task carrying an `rrule`, with a sentence naming `schedule.organize_task`. Reproducing the rollover here would re-introduce exactly the drift (#996 R21, ONT-27) that took People's own `toggle_task` away — a repeating task completed from People never got its next occurrence, because only Tasks' code knew how to spawn one.

**D-1020-PE10 — which parity lists are compared in order, and which as sets.** A list whose statement orders by a MINTED ID is compared as a set, because the fixture's `id-NNNN` tokens are assigned in first-appearance order across the whole bundle and a date whose id first appears inside a revision's snapshot gets a lower token than one that appears in its own table. That order is a fact about the canonicaliser. Six lists are named in `tests/parity.rs`; every other list is compared in order.

## The seven queries

The roster's window is a **walked page set** over `people_profile`, newest-created first. Everything else — the parties, the tags, the important dates and the share bindings — is `IN`-bounded by ids that walk returned. v0 asks for the window as ONE page and the host clamps a page to 500, so a roster declaring ten thousand returns five hundred; the port walks the stated window and `truncated` is the walk's own answer.

`person` is 542 lines in v0 and the largest handler in the app: the party, its profile, its contact rail with a collision search bounded by the values this person holds, and then the three readings. `dashboard` folds the same window into four counts plus a pair that stays absent together when the share plane is denied. `journal` projects two shapes into one feed and is the one read in the tree whose denial is deliberately NOT graceful — an empty marker set would leak journal entries into Notes' library. `search` takes its hits from three FTS indexes in rank order and the fold keeps that order. `trash` is secret-free by construction. `history` is the undo rail, row-filtered by the manifest to this app's own entity type.

## Parity

`contracts/apps/people/` is generated by `contracts/tools/export-people-parity.ts` from the real v0 handlers over a real v0 vault: the app's own demo seed, then a script of all twenty-eight `people.*` commands, the four `social.*` ones and `core.merge_party`, then all seven queries at twenty-seven inputs. `tests/quality/people-parity.contract.test.ts` is both the emitter and the oracle — with `CENTRAID_WRITE_CONTRACTS=1` it writes, and without it asserts, so "the fixture passes in v0 too" is not a second suite that could rot. `tests/parity.rs` rebuilds the vault from `rows.json` and compares the ported answers case by case.

## Volume

`centraid_apps_kit::fixtures::year3_people` is the axis People's ceilings are stated at, and it fills a real hole: v0's year-3 generator writes 5,000 parties and **no `people_profile` rows at all**. Five thousand people, 250 of them trashed, 12,000 important dates with 6,000 live reminders, 20,000 interactions, 900 share bindings and 600 obligations. A shrunken axis runs on every `cargo test`; the measured run is `#[ignore]`d and its numbers are in the lane's receipt.
