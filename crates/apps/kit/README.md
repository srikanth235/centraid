# `crates/apps/kit` — what an app is allowed to do

Every Centraid app is a **manifest** plus two sets of pure functions: queries that hold statements as data, and actions that invoke one typed vault command each. This crate is everything those functions may import, and there is deliberately not much of it.

It is a port of v0's read vocabulary — `packages/core/src/page`, `packages/core/src/money`, `packages/blueprints/apps/_shared/paged-reads.ts` and the grammar half of `packages/vault/src/gateway/paged-door.ts` — kept verbatim where v0 is right and fixed where porting it found it wrong. The fixes are listed at the end.

## What the kit guarantees

| Guarantee | Where |
| --- | --- |
| **Every read is a window.** `PageRequest` has a required `limit`; there is no unpaged variant and no default, because "a default is how an unbounded read gets written by accident" | `page.rs` |
| **Every window continues by keyset**, `(sort_key, pk)` compared as a SQLite row value, with the pk in the key because the sort key is not unique | `page.rs`, `statement.rs` |
| **One assembler.** `page_statement` is the only thing in the workspace that turns an app's statement into SQL, so the seat, the shell and the gateway cannot drift into three keyset dialects | `statement.rs` |
| **One grammar.** Subqueries, second statements, comments and unlisted functions are refused by construction — `parse` returns a shape or an error, and there is no path that returns a shape for a statement it rejected | `grammar.rs` |
| **A stated window is walked, not clamped.** `read_window` reads a window to its stated size and says whether it filled | `reads.rs` |
| **A ceiling errors.** `read_pages` past its bound and `in_list` over an empty set are errors, never short answers — returning what a walk had would be the truncation flag again | `reads.rs` |
| **Money keeps its currency.** `Money` is `i64` minor units and an ISO 4217 code; a position spanning currencies is a `MoneyBag` and stays several amounts; a single figure over one is a `Valuation` that carries its rates or says it is unavailable | `money.rs` |
| **NULL, MISSING and a value are three claims.** A `Row`'s absent key is an absent column and `Cell::Null` is SQL NULL, because `Option<T>` collapses two of them and the collapse is how "0 instead of unknown" comes back | `row.rs` |
| **`states` is a closed partition.** A manifest that forgets one of the seven canonical designed states fails to parse rather than reading as "it does not apply here" | `manifest.rs` |
| **Anything wider reruns.** The live-query matching rule skips only when dependency and invalidation both name rows, and different ones | `changes.rs` |

## What an app may not do, and what stops it

| Not allowed | What stops it |
| --- | --- |
| Hold a SQL statement or a connection | `cargo xtask rules`' `sql-confinement`: SQL lives only under `crates/{ontology,vault,seat,search}` and `crates/apps/kit`. It scans **tests too**, which is why `contract_vault.rs` and `testdoor.rs` are here rather than in each app's test |
| Import a provider SDK | an app crate depends on this crate and `serde`; provider-backed judgment is the assistant's plane and there is no generic inference verb (v0's `ctx-primitives`) |
| Write from a query | a query holds `PageQuery` values and a `PageDoor`, whose one method reads |
| Invoke a command without an `invoke_key` | the key is a required field on an app's invocation, not an option: v0's fallback is the call's **ordinal**, which is stable only for a handler that makes the same call sequence every time |
| Turn a denial into an error | a denial is a value in the app's own payload; `KitError` has no denial variant |
| Read an unbounded set | there is no API that takes no window |

## The doors

`PageDoor` has one method. Three things implement it:

- `crates/vault`'s paged door, which resolves entities, takes an access decision per table and compiles the manifest row filters in — the real one.
- `testdoor::TestDoor`, over a plain `rusqlite` connection. It runs the same grammar, so a statement a test would pass and the real door would refuse never gets through, and it applies **no** access decision: it is the owner's view, which is the identity the parity fixtures were generated under.
- `contract_vault::open_contract_vault`, which rebuilds a fixture vault from `contracts/schema/vault-ddl.sql` and a `rows.json` bundle, for an app's parity tests.

## Where the port deliberately differs from v0

Each of these is a v0 bug found while porting, recorded in `receipts/issue-1020-v1-platform.md` under wave 2 lane D3.

1. **A keyset page cannot be continued over a NULLABLE sort column.** SQLite compares a row value with a NULL operand to NULL, so v0's continuation silently drops rows in three of the four (direction, boundary) cases. The port refuses the continuation (`KitError::NullableSortKey`). Found by a property test, which is why `tests/keyset_properties.rs` is a property test and not a table of examples.
2. **A fan-out bound reports the cap it can REACH.** `MAX_PAGE_ROWS` clamps a page to 500, so v0's `pageSize × fanOutPages` names a number twice the one it stops at whenever `pageSize` is over 500.
3. **A stated window is walked.** v0 asks for a 2,000-row window as one page, gets 500, discards the cursor that says there are more, and folds a balance over it.
4. **Formatting takes an explicit locale and a minor-unit table.** v0 divides minor units by 100 unconditionally and passes `undefined` as the locale, so JPY and KWD are wrong and the same vault renders differently on two devices.
5. **A cursor over a column the projection never carried is refused** rather than stringified as `"undefined"`.
6. **`writes` is required on every manifest action.** v0's schema has it optional and re-imposes it from outside with a shell script; a gate outside the type is a gate that can be forgotten. `[]` is still valid and still means "no database writes".

Two places the port keeps a v0 divergence rather than reconciling it, both unreachable for the values these types can hold, both documented at the code: the `MoneyBag` sort and the balance folds' tie-break use byte order where v0 uses `localeCompare`.
