# Multi-agent norms (G2–G3)

Centraid is often worked by several coding agents in parallel. These norms protect the maintainer's machine and each other's results.

## Root-agent orchestration (umbrella issues)

An umbrella issue is worked by one **root agent** that owns the plan; sub-agents execute slices. The plan is not a task list — it carries the invariants that plain dispatch loses:

- **Slice by ownership, not by size.** A slice is a set of files/subsystems no other in-flight slice touches. Two slices that must edit the same file are one slice, or are serialized — never raced.
- **Order is part of the plan.** Dependencies between slices (schema before consumers, rename before references, policy before sweep) are sequenced by the root; a sub-agent never starts a slice whose inputs have not landed.
- **Sub-agents get the slice contract, not the whole plan**: goal, in-scope/out-of-scope files, the invariants they must not break, and the verification evidence the receipt needs. They report results; they do not re-plan.
- **The root integrates.** After each slice lands, the root re-checks the seams — cross-slice links, anchors, contracts, and tests spanning slices — before dispatching dependents. Correctness failures live at the seams, and only the root sees them.
- The worker/verifier split, isolation defaults, and iteration caps below apply to every sub-agent.

### A slice exits on its lanes' gates, not on its own files

Adopted by [#883](https://github.com/srikanth235/centraid/issues/883), from the [#834](https://github.com/srikanth235/centraid/issues/834) lesson. A slice's exit condition is the **repo-wide gate for every lane its tree participates in** — at minimum the root `bun run lint` and the whole `test` suite of the package it edits — never the subset of files it happened to touch. A sub-agent that runs only its own files' tests hands the root a green report over a red repo, and the failure then surfaces at the integration sweep, several slices away from the change that caused it. **Repo-wide reds surface inside the slice that caused them.** This is the exit condition, not an extra step: G2's "do not run the full suite in parallel" governs sibling agents' saves, not a slice's own exit.

## G2 — Parallel work norms

### Do not run the full suite when agents run in parallel

- Prefer **single-file** / package-filtered tests: `bunx vitest run path/to/file.test.ts` via repo conventions, or `turbo run test --filter=@centraid/<pkg>`.
- Use **bail** on first failure for local loops.
- Full monorepo verification is **CI** (`bun run check:pr` before _your_ push is still required for the agent who owns the PR — not every sibling agent on every save).

### Trust another agent's reported green

If a sibling agent reports tests green for a path you did not touch, **do not re-run their suite "to be sure"** unless you have evidence of flake or conflict. Re-runs thrash CPU and invalidates their timing.

### Never restart shared long-running services without permission

Applies to: shared `centraid-gateway` daemons, Metro, Docker pairing harness networks, databases under a shared `dataDir`, and any service another agent registered in launch config.

- Stop/restart only services **you** started in **your** worktree/ports.
- If you need a port someone else holds, ask or pick another port — do not kill by pid grepping.

### Isolation defaults

| Resource | Rule |
| --- | --- |
| Git worktree | One agent primary owner; no force-push to shared branches without agreement |
| `dataDir` / vault | Per-agent directories |
| Ports | Unique per agent |
| `main` / shared PR branch | Coordinate merges; one agent runs final `check:pr` |

## G3 — Canned supervision patterns

Recurring babysitting loops. Keep exit conditions explicit and **cap iterations**.

### Drive a PR to green

1. Run `bun run check:pr` (or the failing CI job's local equivalent).
2. Fix the **first** root cause class (format → lint → types → tests).
3. Re-run the failed gate, not necessarily the universe.
4. **Exit** when green, or after **N=5** fix iterations — stop and report blockers.
5. Never widen scope into unrelated refactors inside a "make CI green" loop.

### Worker / verifier split

| Role | Does | Stops when |
| --- | --- | --- |
| **Worker** | Implements the issue slice, keeps diff focused | Checklist item done or blocked |
| **Verifier** | Runs tests, reviews against constitution/docs, does not rewrite product intent | Green + receipt updated, or finds a concrete defect |

Verifier must not "improve" design mid-flight without an issue comment. Worker must not mark done without the verification evidence the receipt asks for.

### Iteration caps

| Loop | Cap | Then |
| --- | --- | --- |
| CI fix cycle | 5 | Escalate to maintainer with logs |
| Flaky re-run | 1 retry for infra; **0** "retry until green" for product tests | File flake as bug (E1 policy: flaky tests are bugs) |
| Review nits | 2 rounds | Batch remaining nits |

## Related

- [dev-environment.md](dev-environment.md)
- [TESTING.md](../TESTING.md)
- [coding-standards.md](coding-standards.md)
