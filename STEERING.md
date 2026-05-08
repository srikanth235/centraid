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
| steer-4fb6a682da3-1778247224-1 | 4fb6a682-da3e-420f-aff2-2c82496271a8 |  | correction | classifier | rejected framing; clarified shared design system is the goal for both apps | feat: centralize design system in @centraid/design-tokens |
