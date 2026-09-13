# `centraid-search` — the FTS door

Text search is a question the **vault** answers, not one an app answers by
pulling a table. The FTS5 shadow tables are the vault's (one per text-bearing
entity, kept in step by triggers the baseline installs); this crate owns every
`MATCH` statement in the workspace, and the app kit's read grammar has no
`MATCH` production at all — which is what makes "an app cannot search by hand" a
fact rather than a convention.

Ported from `packages/vault/src/gateway/search.ts` and
`packages/blueprints/apps/notes/link-targets-table.ts` for
[#1020](https://github.com/srikanth235/centraid/issues/1020), ruling
**D-1020-N1**.

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

* **Every read is a window.** `SearchRequest::page` is the kit's
  `PageRequest`: `limit` is required and there is no default. One assembler for
  the paging law, so a search page and a drive page continue the same way
  (D-1020-N1a).
* **A window continues by keyset**, over `(rank, id)`. FTS5's `rank` is bm25
  negated, so ascending is best-first — the order v0 keeps and calls "vault
  order is rank order".
* **A denial is a value.** `Answer::Denied` is a state a surface renders. An
  `Err` is for a question that cannot be answered at all.
* **A bound reports the size it reaches.** `Answer::window` is the caller's
  limit after both clamps (`MAX_MATCH_ROWS` here, `MAX_PAGE_ROWS` in the kit),
  never the number that was asked for (D-1020-D3-12).

## Secret-free by construction

A result is a `Target`: five strings and a snippet, every one read from a column
named in `domains::DOMAINS`. There is no `Value`, no map and no byte field, so
there is no shape a sealed cell could arrive in. Three mechanisms, not a filter:

1. `domains::assert_no_sealed_column` checks every projected column against
   `centraid_ontology::registries::sealed_physical_columns` **at door
   construction**, so a domain that grew a sealed projection fails to open.
2. `SqliteDoor::open` re-checks each domain's **live index columns** against the
   same registry. v0 throws at DDL-build time for an FTS spec naming a sealed
   column (issue #293) — FTS exclusion is one of the six sealed-column
   enforcement points — and this keeps the DDL and the door from disagreeing
   about a file another build wrote.
3. **Locker is not a domain.** The powerbox reaches seven and Locker is not one
   of them, so a secret cannot become a link target by adding a probe. Asking is
   `SearchError::NotADomain`, never an empty page — an empty page reads as "no
   matches", which is a different claim about the vault.

`tests/door.rs` plants a marker in every sealed column this model has, proves the
plant is real, and asserts no target from any domain carries it.

## The seven domains

| App | Entity | Label | Subtitle |
|---|---|---|---|
| notes | `knowledge.note` | `title` | the decoded body, capped at 200 chars |
| people | `core.party` | `display_name` | — (falls back to the app) |
| agenda | `core.event` | `summary` | `dtstart` |
| tasks | `schedule.task` | `title` | `due_at` |
| tally | `tally.expense` | `description` | `spent_on` |
| photos | `core.content_item` | the index's `title` (#996 R20(b)) | — |
| docs | `core.document` | `title` | — |

A row with no label **is not a target**: an unlabelled link is one a member
cannot recognise. That, and the caller's `excluded_ids` (Notes passes its
journal set, #834 R-journal), are SQL predicates rather than post-filters,
because the kit's page is the window plus one probe row and dropping rows after
the probe was counted makes `next` lie in both directions.

## Owner hand-off — the consent pipeline

v0's `searchEntity` walks four walls before its statement, and **this door walks
none of them yet**: the base entity's read decision; the read decision of every
entity whose canonical text the index folds in (matching a note body *is*
reading `core.content_item`); a grant field mask that hides an indexed column
failing the search **closed**; and an authority receipt for the decision either
way. It is written down here rather than stubbed, because a stub that looks like
a consent check is worse than an absence a reader can see. Wiring it is
`crates/vault`'s paged-door work: the door takes a `Principal` already, so the
change is an implementation of `Search`, not a change to its callers.
