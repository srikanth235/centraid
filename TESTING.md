# Testing strategy

The goal is **maximal _meaningful_ coverage** — confidence that the engine works
and the critical user journeys work — given that **coding agents author both the
code and the tests**. This document is the durable record of those decisions and
the conventions every agent (or human) must follow when writing tests here. It
captures [#212](https://github.com/srikanth235/centraid/issues/212); the
migration it describes lands incrementally in follow-up PRs.

## Guiding principle: quantity is free, trust is the bottleneck

When agents write the tests, _writing_ them is no longer the constraint. The
constraints shift to the things that don't get cheaper:

- **Meaningfulness** — agents produce passing-but-vacuous tests as readily as
  real ones (over-mocked, asserting incidentals, testing implementation not
  behaviour). A wrong test is cheap to write and expensive to trust.
- **Loopability** — an agent must run a test, read a clear pass/fail, and iterate
  unattended. Flake, slowness, and murky output poison that loop more than they
  hurt humans.
- **Maintainability** — volume × brittleness = a brittle mountain.

So the strategy optimises for one thing: **make it cheap to write meaningful
tests, and structurally hard to ship meaningless ones.** Same posture as the
lint/type-coverage hardening in
[#210](https://github.com/srikanth235/centraid/issues/210) — objective
guardrails over good intentions.

## Decisions

### 1. Single runner: vitest

Adopt [vitest](https://vitest.dev) as _the_ test runner across the repo and
migrate the existing `node:test` files (`tsx --test`) off it.

- **Why one runner:** you cannot target "maximal meaningful coverage" if backend
  and frontend report coverage differently. vitest gives **one coverage tool
  (v8) across the whole repo**, one mental model, watch mode, real matchers, and
  `jsdom` for the desktop renderer. It matches the openclaw lineage (vitest +
  jsdom + coverage-v8).
- **Worker-thread tests:** the handler-runner spawns Worker threads. Point those
  tests at the **built `dist` worker**, not the `tsx`/`.ts` loader fallback —
  this exercises the real production artifact and removes the fragile
  loader-propagation dependency. `turbo run test` already builds first (the
  `test` task `dependsOn` `build`; see #210), so the artifact is fresh.
- **Migrate as a contained, verifiable task:** green-before → green-after,
  **package by package**. No behaviour change in the same commit as a runner
  swap.

### 2. Coverage shape — saturate what matters, smoke the rest

"Maximal meaningful" is **not** one repo-wide percentage. It is per-layer intent:

- **Backend engine** (`app-engine`, `gateway`, `automation`, `agent-runtime`,
  `blueprints`) → **go deep.** This is the product, it is already testable (real
  sqlite, real workers, DI stubs), and it is where bugs hurt. Roughly 80% of the
  meaningful coverage lives here. Gate with a real floor once seeded.
- **Desktop renderer** (`apps/desktop`) → **extract logic, then test it; smoke
  the shell.** A DOM-entangled god-file cannot be meaningfully unit-tested.
  Extract pure logic — render-data, state, formatting, gateway-client — into
  modules and cover those richly; the thin DOM glue is covered by an e2e smoke,
  not units. This doubles as the god-file split.
- **Mobile** (`apps/mobile`, Expo/RN) → vitest for **logic**; Maestro for
  **screens**. No RN component-test framework (see _Out of scope_).
- **Shared** (`design-tokens`) → low priority.

### 3. Per-surface tooling

| Surface                    | Unit / logic                       | Real app (e2e)         |
| -------------------------- | ---------------------------------- | ---------------------- |
| Backend / shared packages  | vitest                             | —                      |
| Electron (desktop)         | vitest + jsdom (extracted logic)   | Playwright `_electron` |
| Expo (mobile)              | vitest (logic only)                | Maestro                |

### 4. Thin, high-value e2e

- **Playwright `_electron`** — app boots + one core journey (clone/create app →
  renders → run it). Scripted invariants that must never flake live under
  `apps/desktop/tests/e2e/`.
- **Maestro** — 3–5 critical mobile journeys (the MCP is already wired; see
  `tests/agent-e2e-mobile/`).
- Keep the count **small**; run them **nightly + on-demand**, _not_ blocking
  every PR. Their cost is runtime and flake — which agents don't fix — so they
  must not sit in the inner loop.
- Add `data-testid` / accessibility ids **as code is written** so selectors are
  stable from the start.

### 5. Keeping agent tests meaningful

Mutation testing is the eventual gold standard but is **deferred** (see _Out of
scope_). Until then, the substitutes — in priority order:

1. **The test convention below** (the main lever) — a short, enforced set of
   rules so every agent writes tests the same, meaningful way.
2. **Coverage diff to target work** — point agents at uncovered lines/branches.
   Finds real gaps without rewarding vacuous tests.
3. **Golden examples** — a few hand-checked exemplary tests per layer for agents
   to imitate. The backend tests already model the convention; promote the best
   as goldens.
4. **Adversarial review pass** — one agent asks of each test: _"could the code be
   wrong and this test still pass?"_ If yes, the test is vacuous.

## The test convention

Every test in this repo follows these rules. They are objective enough for an
agent to self-check and for review to enforce.

- **Behaviour over implementation.** Assert observable outcomes — return values,
  persisted state, emitted events — never that a private helper ran or a mock was
  called. If the refactor is behaviour-preserving, the test must still pass.
- **Real deps; fake only at the edges.** Use the real sqlite, real workers, real
  modules. Fake only what is non-deterministic or external: clock, network, fs
  randomness. The backend already does this; keep it the default.
- **One behaviour per test.** A test names a single behaviour and asserts it. No
  grab-bag tests that drift into asserting incidentals.
- **Assert outcomes, not mock calls.** `expect(result).toEqual(...)`, not
  `expect(mock).toHaveBeenCalled()`. A `toHaveBeenCalled` assertion is a smell —
  justify it or replace it with an outcome assertion.
- **Deterministic.** No real time (`Date.now()`/timers — inject or fake), no real
  randomness, no network. No committed `.only`. A test must pass on every run.
- **Clear failure output.** A failing test must say _what_ broke without a
  debugger. Prefer specific matchers and meaningful expected values over
  `toBeTruthy()`.

When in doubt, apply the adversarial check: _could the code be wrong and this
test still pass?_ If yes, the test is not yet meaningful.

## Coverage posture / gating

- Track coverage **repo-wide** via vitest v8 from day one.
- **Gate** the engine packages (`app-engine`, `gateway`, `automation`,
  `agent-runtime`, `blueprints`) on a **line + branch floor once seeded** — start
  by _tracking_, then _ratchet_. The floor only ever moves up.
- **Renderer / mobile:** track, do **not** gate line coverage. Their meaningful
  coverage is logic-units plus e2e journeys, not a renderer line percentage.
- Never gate coverage on trivial getters or chase 100%.

## Resolved decisions

These were open in #212 and are resolved here as the default position. They are
ratifiable in review — adjust the numbers, not the shape.

1. **Engine coverage floor.** Seed first (one migration pass per engine package),
   then gate at the seeded floor and **ratchet up**, never down. Target band
   once seeded: **80% line / 70% branch** on engine packages. Track-only until
   the floor is seeded so the gate reflects reality, not aspiration.
2. **Where Playwright + Maestro run.** **Nightly + on-demand** (scheduled
   workflow plus manual dispatch / label), never per-PR. Maestro runs on **local
   simulators** in the nightly job to start; **Maestro Cloud is deferred** until
   the flake budget justifies the spend.
3. **Where the convention lives.** The canonical convention is **this document**
   — single source of truth, linked from [AGENTS.md](AGENTS.md). A `/test-coverage`
   skill may later _wrap_ this doc (so agents can invoke it), but the doc stays
   authoritative; the skill must never fork the rules.
4. **Migration sequencing.** **Package by package, behind new work**, not all at
   once. Order by value: **engine packages first**, desktop after the renderer
   logic is extracted, mobile last. Each migration is green-before → green-after
   for that package only.

## Deliberately out of scope / deferred

- **Mutation testing** — the eventual gold standard; revisit later, engine
  packages only.
- **jest-expo / RN component tests** — Maestro covers mobile UI; vitest fights
  the RN / Metro / native-module toolchain for no benefit.
- **Renderer DOM unit tests** — extract logic and test that instead.
- Chasing 100% coverage; gating e2e per-PR; coverage on trivial getters.

## Related

- [#210](https://github.com/srikanth235/centraid/issues/210) — lint /
  type-coverage hardening (brought tests into typecheck and type-aware lint; same
  "objective guardrails for agent-generated artifacts" philosophy).
- [tests/agent-e2e/README.md](tests/agent-e2e/README.md) — the exploratory,
  agent-driven e2e layer that complements scripted Playwright.
