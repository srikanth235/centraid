# Multi-agent norms (G2–G3)

Centraid is often worked by several coding agents in parallel. These norms protect the maintainer's machine and each other's results.

## G2 — Parallel work norms

### Do not run the full suite when agents run in parallel

- Prefer **single-file** / package-filtered tests: `bunx vitest run path/to/file.test.ts` via repo conventions, or `turbo run test --filter=@centraid/<pkg>`.
- Use **bail** on first failure for local loops.
- Full monorepo verification is **CI** (`bun run check:pr` before *your* push is still required for the agent who owns the PR — not every sibling agent on every save).

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
