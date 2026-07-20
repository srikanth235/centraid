# Multi-session refactor plans (A5)

Long-running decompositions and migrations live **in-repo** so they survive context resets and agent handoffs. Do not keep the plan only in chat.

## When to write a plan

- Work spans **more than one PR** or **more than one agent session**
- Safety argument is non-obvious (data migration, dual-write window, public protocol)
- You need a durable list of **rejected alternatives** so the next agent does not re-litigate them

Small single-PR cleanups do not need a plan file — a receipt is enough.

## Location and naming

```
docs/refactors/<short-slug>.md
```

Examples of plan-like docs already in tree (treat as examples; migrate here when actively executed):

- [docs/plans/gateway-low-end-and-rust-plane.md](../plans/gateway-low-end-and-rust-plane.md)
- [docs/plans/skills-package-plan.md](../plans/skills-package-plan.md)

`docs/plans/` remains valid for design/measurement records; **`docs/refactors/`** is for multi-session execution plans with a progress log.

## Required sections

```markdown
# <Title>

**Issue:** #<n>
**Status:** proposed | in-progress | done | abandoned
**Owner session:** <optional>

## Goal
One paragraph. What "done" means.

## Safety argument
Why intermediate states are safe (compatibility, rollback, feature flags, dual-run).
What will *not* happen (no silent dual writers, no epoch bump without handshake, …).

## Plan
Numbered steps or PR slices. Each step shippable alone if possible.

## Progress log
| Date | Step | PR/commit | Notes |
| --- | --- | --- | --- |
| YYYY-MM-DD | … | … | … |

## Rejected alternatives
| Idea | Why rejected |
| --- | --- |
| … | … |

## Out of scope
…
```

## Rules

1. Update the **progress log** in the same PR as the step.
2. Do not delete rejected alternatives — the next agent will re-propose them.
3. Link the plan from the issue receipt.
4. When done, set status to `done` and leave the file (history > deletion).

## Related

- [ARCHITECTURE.md](../../ARCHITECTURE.md)
- [decisions.md](../decisions.md)
- Receipts under `receipts/`
