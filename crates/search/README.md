# `centraid-search` — the FTS door

Text search is a question the **vault** answers, not one an app answers by pulling a table. The FTS5 indexes are the vault's (one per domain, kept in step by triggers that the baseline and rung thirteen install); this crate owns every `MATCH` statement in the workspace, and the app kit's read grammar has no `MATCH` production at all — which is what makes "an app cannot search by hand" a fact rather than a convention.

Ruling **D-1020-N1** ([#1020](https://github.com/srikanth235/centraid/issues/1020)).

## The shape

```rust
let door = SqliteDoor::open(&connection)?;                  // checks the model
let answer = door.query(&Principal::Owner,
                        &SearchRequest::new("knowledge.note", "cabin", 8))?;
match answer {
    Answer::Denied(denial) => /* a surface renders the ask */,
    Answer::Data { page, window } => /* page.rows: Vec<Target>, page.next: keyset */,
}
```

- **Every read is a window.** `SearchRequest::page` is the kit's `PageRequest`: `limit` is required and there is no default. One assembler for the paging law, so a search page and a drive page continue the same way (D-1020-N1a).
- **A window continues by keyset**, over `(rank, id)`. FTS5's `rank` is bm25 negated, so ascending is best-first — "vault order is rank order".
- **A denial is a value.** `Answer::Denied` is a state a surface renders. An `Err` is for a question that cannot be answered at all.
- **A bound reports the size it reaches.** `Answer::window` is the caller's limit after both clamps (`MAX_MATCH_ROWS` here, `MAX_PAGE_ROWS` in the kit), never the number that was asked for (D-1020-D3-12).

## Secret-free by construction

A result is a `Target`: five strings and a snippet, every one read from a column named in `domains::DOMAINS`. There is no `Value`, no map and no byte field, so there is no shape a sealed cell could arrive in. Four mechanisms, not a filter:

1. `domains::assert_no_sealed_column` checks every projected column against `centraid_ontology::registries::sealed_physical_columns` **at door construction**, so a domain that grew a sealed projection fails to open.
2. `SqliteDoor::open` re-checks each domain's **live index columns** against the same registry. FTS exclusion is one of the six sealed-column enforcement points (issue #293), and this keeps the DDL and the door from disagreeing about a file another build wrote.
3. **A folded column must be listed** (see below): `open` refuses an index with a column that is neither the base table's nor in `domains::FOLDED`, and `assert_no_sealed_column` holds every listed source to the registry.
4. **Locker is not a domain.** The powerbox reaches seven and Locker is not one of them, so a secret cannot become a link target by adding a probe. Asking is `SearchError::NotADomain`, never an empty page — an empty page reads as "no matches", which is a different claim about the vault.

`tests/door.rs` plants a secret in every sealed column the registry names — sealed by `crates/vault::custody` itself as the member key's `lk1:` cell, never a hand-typed prefix — proves each cell is real ciphertext bound to its own row, and asserts that no target from any domain carries the plaintext OR the ciphertext. The planted set is compared against `sealed_physical_columns` filtered to the tables a new vault has (the frozen v0 registry still names the connector credential rung five dropped), so a sealed column added to the model and not planted fails rather than being skipped.

## What an index holds: the entity's own text and what is folded into it

One probe per domain answers, so Home stays at seven. An index holds the base row's text columns and **columns folded in from other tables** (rung thirteen, [#1097](https://github.com/srikanth235/centraid/issues/1097)): a person's nickname, role, where they met, email and phone and memos; an event's place; a task's project; an expense's category, group, line items and memo. Triggers on the child tables re-index the parent, so a rename or an edit moves the hit, and a trashed parent stays out. A trashed profile's text and an expense's default `general` category are not folded, and a Locker memo reaches no index at all.

| Domain | Index column | Folded from |
| --- | --- | --- |
| people | `nickname`, `role`, `met` | `people_profile`, while it is not trashed |
| people | `channels` | `social_contact_channel` `value` and `normalized_value` |
| people | `memo` | `knowledge_annotation` on the party |
| agenda | `location` | `core_place.name` |
| tasks | `project` | `schedule_project.name` |
| tally | `category`, `group_name`, `items`, `memo` | the expense's category, `social_circle.name`, `tally_expense_line_item.description`, the expense's `knowledge_annotation` |
| notes, photos, docs | `body`, `title` | the decoded text and the asset's title (older than #1097) |

`domains::FOLDED` is the list of every such column with its source `(table, column)`. It is what the sealed check reads, because a fold is not a column of the base table and a check against the base table cannot see it. **A fold nobody listed does not open:** `SqliteDoor::open` fails with `IndexUnusable` naming the column.

**Folded columns weigh half, and the door says so with every query.** Each `Domain` carries `weights`, one per index column in the index's own order, the id first: 1.0 for what an index always had, 0.5 for a column rung thirteen folded in. The door passes them as FTS5's rank override, `AND <fts>.rank MATCH 'bm25(…)'`, so `ORDER BY <fts>.rank` and the `(rank, id)` keyset read the weighted score and a word in a title or a name outranks the same word in a project, a nickname or a memo. They are not stored in the index (`INSERT INTO fts(fts, rank) VALUES('rank', …)` is a row of data and `contracts/schema/vault-ddl.sql` carries none): a vault built by replaying the DDL and one the product founded rank alike, and `tests/door.rs` proves the order on both. `SqliteDoor::open` refuses an index whose column count is not its weights' length, because `bm25` takes them by position.

**Vocabulary.** Each of the seven indexes has a persistent `fts5vocab` table, `fts_<index>_vocab` (`term`, `doc`, `cnt`), created in rung thirteen because the read connection is `query_only`. Locker has none. Nothing in this crate reads them yet.

## The seven domains

| App | Entity | Label | Subtitle |
| --- | --- | --- | --- |
| notes | `knowledge.note` | `title` | the decoded body, capped at 200 chars |
| people | `core.party` | `display_name` | — (falls back to the app) |
| agenda | `core.event` | `summary` | `dtstart` |
| tasks | `schedule.task` | `title` | `due_at` |
| tally | `tally.expense` | `description` | `spent_on` |
| photos | `core.content_item` | the index's `title` (#996 R20(b)) | — |
| docs | `core.document` | `title` | — |

A row with no label **is not a target**: an unlabelled link is one a member cannot recognise. That, and the caller's `excluded_ids` (Notes passes its journal set, #834 R-journal), are SQL predicates rather than post-filters, because the kit's page is the window plus one probe row and dropping rows after the probe was counted makes `next` lie in both directions.

## Owner hand-off — the consent pipeline

A consented search walks four walls before its statement, and **this door walks none of them yet**: the base entity's read decision; the read decision of every entity whose canonical text the index folds in (matching a note body _is_ reading `core.content_item`); a grant field mask that hides an indexed column failing the search **closed**; and an authority receipt for the decision either way. It is written down here rather than stubbed, because a stub that looks like a consent check is worse than an absence a reader can see. Wiring it is `crates/vault`'s paged-door work: the door takes a `Principal` already, so the change is an implementation of `Search`, not a change to its callers.
