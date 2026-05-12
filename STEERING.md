<!-- STEERING.md — append-only human-steering ledger -->
<!-- governance: allow-plan-captured -->

# STEERING.md

Append-only ledger of human-steering events for agent-authored commits. Rows are
keyed by `steer-key`; the row → commit join uses the `commit |` column so the
ledger survives squash merges that strip the original commit history. Each
commit's summary trailers (`Steer-Count`, `Steer-Types`, `Steer-Tiers`) tally
the rows it adds.

**Do not** rewrite or reorder rows. This file is the durable record that the
`agent-steering-accounting` governance directive validates.

`type` ∈ `interrupt` | `correction` ·
`tier` ∈ `structural` | `classifier` | `lexical` (the lexical tier is a
silent fallback for when the runtime CLI is unreachable).

## Ledger

| steer-key | session | issue | type | tier | user-reason | commit |
| --- | --- | --- | --- | --- | --- | --- |
| steer-46305f58707-1778569590-1 | 46305f58-7075-4b6d-903b-9ecd33d41985 | #16 | correction | classifier | Questioned modifying pack-owned check.sh file | chore(governance): bootstrap governance-kit/core via init (#16) |
| steer-46305f58707-1778569590-2 | 46305f58-7075-4b6d-903b-9ecd33d41985 | #16 | correction | classifier | Asked to revert patch and use directive instead | chore(governance): bootstrap governance-kit/core via init (#16) |
