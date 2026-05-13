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
| steer-8c0d92ed5ba-1778586498-1 | 8c0d92ed-5bad-4504-8478-2400eebdca56 | #17 | correction | classifier | rejected mock gateway; use real local gateway instead | test(agent-e2e): scaffold agent-driven e2e harness + root test orchestration (#… |
| steer-175b1014652-1778601831-1 | 175b1014-652d-492d-9f12-bdab3af9560f | #22 | correction | classifier | Pushed back on overly dark theme background, asked to soften it | feat(desktop): soften dark theme + drop hero "New app" button (#22) |
| steer-83b94449006-1778664748-1 | 83b94449-0064-44a5-8b88-a27e20b4c0f3 | #26 | interrupt | structural |  | feat(desktop): port Bold/Atmospheric redesign (#26) |
| steer-83b94449006-1778664748-2 | 83b94449-0064-44a5-8b88-a27e20b4c0f3 | #26 | correction | lexical | wait this is what I'm seeing | feat(desktop): port Bold/Atmospheric redesign (#26) |
| steer-83b94449006-1778664748-3 | 83b94449-0064-44a5-8b88-a27e20b4c0f3 | #26 | interrupt | structural |  | feat(desktop): port Bold/Atmospheric redesign (#26) |
| steer-83b94449006-1778664748-4 | 83b94449-0064-44a5-8b88-a27e20b4c0f3 | #26 | interrupt | structural |  | feat(desktop): port Bold/Atmospheric redesign (#26) |
| steer-83b94449006-1778664748-5 | 83b94449-0064-44a5-8b88-a27e20b4c0f3 | #26 | interrupt | structural |  | feat(desktop): port Bold/Atmospheric redesign (#26) |
| steer-83b94449006-1778665787-1 | 83b94449-0064-44a5-8b88-a27e20b4c0f3 | #26 | interrupt | structural |  | feat(desktop): port Bold/Atmospheric redesign (#26) |
