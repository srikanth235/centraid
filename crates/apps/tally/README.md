# `crates/apps/tally` — the shared-expense ledger

Tally's doctrine, from the manifest's own description (`manifest.json`, copied byte for byte from v0's `app.json`):

- a friend is a canonical `core.party`;
- a group is a `social.circle` decorated by a `tally.group`, and **a group is one ledger in one money**;
- an expense stores its **resolved** splits, its payers and the method it was entered with, all re-validated by the vault to sum to the amount;
- a settlement is real cash;
- **balances are never stored.** They are derived at read time by one fold, and the simplification proposal and the rate suggestion are derived the same way and written nowhere.

## The five modules

| Module | What it owns |
| --- | --- |
| `manifest` | The manifest, embedded with `include_str!` and parsed by the kit rather than restated in Rust. Two copies of "which tables does Tally write" is how the two answers drift, and the drift is invisible because both copies look right |
| `queries` | `loadTally` — seventeen statements as `PageQuery` values, then the party resolution that depends on what the first sixteen named — and the fold into `TallyData`. Every Tally surface is a fold over this one read, not a second read |
| `balance` | The pure engine: the single attribution rule, the per-member net, the pairwise matrix, the min-cash-flow simplification. No vault reaches it, which is why the phone can import it directly |
| `views` | What each of the eight manifest queries ANSWERS — the dashboard, a group, a friend, activity, search, export, history, matches — as pure functions of `TallyData` (plus a door for the three that read planes `loadTally` does not). Presentation comes from `crates/design`, the one lowering of `packages/design`; nothing here formats a number |
| `commands` | The 23 actions, as a table of `action → command`. The projection lives in the command, not here. `door` (behind the `vault-door` feature) is the real `Commands` implementation over the vault's `execute`; the feature is off by default so an edit here rebuilds one crate |

## What this crate may not contain, and what stops it

| Not allowed | What stops it |
| --- | --- |
| **SQL, in any form** | `cargo xtask rules`' `sql-confinement` scans this crate — source and tests — and finds none. A statement here is a projection, a `from`, a predicate and an order, as data; the kit is the only place that turns one into a statement |
| **A provider SDK** | the only dependencies are the kit and `serde`. Provider-backed judgment is the assistant's plane, and there is no generic inference verb |
| **A write from a query** | `queries` holds statements and a `PageDoor`, whose one method reads |
| **An invocation with no `invoke_key`** | the field is required on `Invocation`. v0's fallback is the call's ordinal, which is stable only for a handler that makes the same call sequence every time — a replayed intent whose handler branched differently then re-executes a committed command under another call's key |
| **A denial turned into an error** | `Outcome::Denied` is a state the surface renders. `Err` is reserved for a door that is not there at all, and it fails closed |
| **An unbounded read** | every window is a stated number and every walk errors at its ceiling |
| **A stored balance** | nothing in `balance` writes, and the export states `balances_excluded` |

## The numbers that are part of the contract

| Name | Value | What it bounds |
| --- | --- | --- |
| `LEDGER_ROWS` | 2,000 | the ledger window the dashboard folds a balance over |
| `TRASH_ROWS` | 100 | the trash shelf |
| `RECURRING_ROWS` | 500 | standing orders |
| `EXCEPTION_ROWS` | 2,000 | occurrence exceptions |
| `LEDGER_FAN_OUT` | 8,000 rows | a split, a payer or a line per `(expense, person)` |
| `ALLOCATION_FAN_OUT` | 32,000 rows | an allocation per `(line, person)` |

The two fan-outs are stated at a page size of **500**, not v0's 1,000, because `MAX_PAGE_ROWS` clamps a page to 500 and a bound that asks for more reaches half the rows it names. See `contracts/apps/tally/year3-ceiling.md`.

## Parity

`tests/parity.rs` reads `contracts/apps/tally/`, which is generated from the v0 handlers by `contracts/tools/export-tally-parity.ts`:

- **`balances.json`** — all six balance-engine cases, compared answer for answer: attributions, net, pairwise, open debts, minimal transfers, and the simplification both opted in and out.
- **`rows.json`** — the fixture ledger, replayed into a vault built from `contracts/schema/vault-ddl.sql` and read back through the kit's test door. What is asserted is the fold: the party set including the member who left, the live-versus-trashed split, each group's name coming off its circle, that every payer set and split set sums to its amount, and that every group's pairwise matrix reconciles with its net.
- **`queries.json`** — all eight query outputs at 29 fixed inputs, **compared whole** by `tests/queries_parity.rs`: every field of every case, with the presentation going through `crates/design` (`design/identity-corpus.json` asserts that lowering row by row against `packages/design` itself). Two fields of a `recurring` row are the stated exception — `preview` and `next_start` are answers of v0's civil-time plane, which is the schedule lane's port, and they are named in one constant so the deferral cannot widen quietly.
- **`commands.json`** — the 20-step command script the fixture's ledger is built from, with every minted id replaced by a reference to the step that produced it. `crates/vault/tests/tally_commands.rs` replays it through the real `tally.*` commands and compares the rows table by table, modulo ids and host instants: two runs mint different ids, and nothing in the product depends on which.

`tests/year3.rs` seeds the year-3 Tally volume and times both the read and the eight views; `tests/door.rs --features vault-door` times the command path. See the ceiling note for the numbers and the v0 findings they produced.

## What is still v0's and not this crate's

| Not ported | Why, and whose it is |
| --- | --- |
| `tally.add_receipt_expense` | it claims a staged blob, mints a `core_content_item` and its representation, attaches it and writes OCR text through the enrichment plane. Four planes, none of them Tally's, and Tally is record-only — so the command refuses with a sentence naming the media lane rather than writing the expense and dropping the photo |
| The occurrence half of the two recurrence commands | `expandRecurrence` over a series' own zone, with a timezone database behind it. A minimal expander here would be a second recurrence engine, which is the drift #996 R21 (ONT-25) was filed for |
| The eight client-side models | form arithmetic and surface state, not the ledger (`split-model`, `line-model`, `draft-model`, `contrib-model`, `receipt-model`, `spending-model`, `schedule-model`, `activity-model`). The one that was a bug — `line-model.ts`'s module-level line-id counter — is fixed in v0, and the Rust port mints from `Ids` |

## Where Tally sits in the plane

Record-only (`seats.byteBearing: false`), so it must not import custody machinery; its one byte-bearing path is a receipt attachment, which is a `core.attachment` with `role = 'receipt'` and belongs to the media plane. `vault.scopes` declares 45 scopes and `ext.tables` is empty: Tally creates no tables of its own and reads the vault's.
