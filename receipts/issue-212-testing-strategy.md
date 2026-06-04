# issue-212 — Testing strategy doc

GitHub issue: [#212](https://github.com/srikanth235/centraid/issues/212)

Issue #212 is explicitly a strategy outline — "it captures the decisions, not an
implementation checklist." The faithful, contained deliverable is therefore the
durable record of those decisions, not the migration itself (vitest swap,
Playwright/Maestro wiring, renderer logic-extraction), which the issue defers to
incremental follow-up PRs. This receipt covers landing that record as
[TESTING.md](../TESTING.md) and wiring it into the doc map, plus resolving the
four open decisions with a ratifiable default position.

## Checklist

- [x] Author TESTING.md capturing the #212 decisions
- [x] Codify the test convention
- [x] Resolve the four open decisions with defaults
- [x] Wire TESTING.md into the doc map

## What changed

### Author TESTING.md capturing the #212 decisions

New root [TESTING.md](../TESTING.md) records the strategy verbatim from #212: the
guiding principle (quantity is free, trust is the bottleneck), and the six
decisions — single runner vitest (migrate off `tsx --test` / `node:test`, point
worker-thread tests at the built `dist` worker), per-layer coverage shape (engine
deep, renderer extract-then-test, mobile logic+Maestro, shared low-priority),
per-surface tooling table, thin high-value e2e (Playwright `_electron` + Maestro,
nightly/on-demand not per-PR), keeping agent tests meaningful, and the coverage
posture / gating (track repo-wide, gate engine on a seeded line+branch floor,
track-don't-gate renderer/mobile).

### Codify the test convention

TESTING.md carries a standalone "The test convention" section — behaviour over
implementation, real deps fake only at the edges, one behaviour per test, assert
outcomes not mock calls, deterministic, clear failure output — phrased as
objective rules an agent can self-check and a reviewer can enforce, closing on
the adversarial check ("could the code be wrong and this test still pass?").

### Resolve the four open decisions with defaults

The "Resolved decisions" section settles #212's four open questions as a
ratifiable default: engine coverage floor (seed then ratchet, 80% line / 70%
branch band, track-only until seeded), where Playwright + Maestro run (nightly +
on-demand, local simulators first, Maestro Cloud deferred), where the convention
lives (this doc is canonical; a `/test-coverage` skill may later wrap but not
fork it), and migration sequencing (package by package behind new work, engine
first, desktop after logic extraction, mobile last).

### Wire TESTING.md into the doc map

[AGENTS.md](../AGENTS.md) gains a "Tests follow TESTING.md" bullet under
Conventions and a TESTING.md entry under "Where to look", so the doc is
discoverable from the repo's durable-doc index the same way QUALITY.md and
ARCHITECTURE.md are. QUALITY.md tracks the strategy adoption under `## Open`.

## Out of scope

- **The migration itself** — swapping the runner to vitest, the worker-thread
  `dist` retarget, v8 coverage wiring, Playwright `_electron` boot test, Maestro
  flows, and the renderer logic-extraction/god-file split. #212 explicitly defers
  these to incremental, package-by-package follow-up PRs; folding them in would
  contradict the issue's own framing and the repo's commit-division discipline.
- **Mutation testing**, **jest-expo / RN component tests**, and **renderer DOM
  unit tests** — deferred by #212 and recorded as such in TESTING.md.
- **Creating the `/test-coverage` skill** — TESTING.md is the canonical source;
  the skill that wraps it is a separate, later piece of work.

## Verification

- `TESTING.md` authored at repo root capturing the #212 decisions, the test
  convention, the four resolved open decisions, and the coverage posture; under
  the 500-line file cap.
- `AGENTS.md` links TESTING.md from both Conventions and "Where to look"; doc map
  renders with no broken relative links.
- No code or build changes — doc-only PR; nothing to typecheck or run.
