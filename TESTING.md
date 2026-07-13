# Testing strategy

The goal is **maximal _meaningful_ coverage** — confidence that the engine works
and the critical user journeys work — given that **coding agents author both the
code and the tests**. This document is the durable record of those decisions and
the conventions every agent (or human) must follow when writing tests here. It
captures [#212](https://github.com/srikanth235/centraid/issues/212). The runner
migration and repo-wide v8 coverage described below are **in place**; the deeper
per-package work (richer coverage, renderer logic-extraction, the mobile/desktop
e2e journeys) proceeds behind new work.

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

[vitest](https://vitest.dev) is _the_ test runner across the repo; the
`node:test` / `tsx --test` setup has been migrated off. Each package has a
`vitest.config.ts` project; the root `vitest.config.ts` aggregates them and owns
the coverage config, so `bun run coverage` emits **one v8 report** for the whole
repo. Per-package `bun run test` (via turbo) runs that package's project alone.

- **Why one runner:** you cannot target "maximal meaningful coverage" if backend
  and frontend report coverage differently. vitest gives **one coverage tool
  (v8) across the whole repo**, one mental model, watch mode, real matchers, and
  `jsdom` for the desktop renderer. It matches the openclaw lineage (vitest +
  jsdom + coverage-v8).
- **Pool:** vitest 3's default pool is `forks` (real child processes), so
  `node:sqlite` and the worker-thread handler-runner behave exactly as they did
  under `node:test`.
- **Worker-thread tests:** the handler-runner spawns Worker threads at the
  **built `dist` worker**, not the `.ts` source — this exercises the real
  production artifact and removes the fragile loader-propagation dependency.
  `turbo run test` builds first (the `test` task `dependsOn` `build`; see #210)
  and CI runs `bun run build` before `bun run coverage`, so the artifact is
  fresh.
- **How the migration landed:** the swap was mechanical — `node:test` imports →
  `vitest`, `before`/`after` → `beforeAll`/`afterAll`, and `node:assert` kept
  as-is (it runs unchanged under vitest). So it landed atomically with
  green-before → green-after: **653 tests passing, unchanged**. Converting the
  remaining `assert.*` calls to vitest `expect` matchers is follow-up polish, not
  a blocker.

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
| Shared client / web PWA    | vitest + jsdom                     | Playwright Chromium    |
| Electron (desktop)         | vitest + jsdom (extracted logic)   | Playwright `_electron` |
| Expo (mobile)              | vitest (logic only)                | Maestro                |

### 4. Thin, high-value e2e

- **Playwright `_electron`** — app boots + one core journey (clone/create app →
  renders → run it). Scripted invariants that must never flake live under
  `apps/desktop/tests/e2e/`.
- **Playwright Chromium** — the production PWA boots against a real gateway,
  establishes its HttpOnly control session, previews/publishes an app, runs the
  injected SDK, and proves the app session cannot reach shell/admin routes.
  The durable smoke lives under `apps/web/tests/e2e/`.
- **Browser Iroh transport** — unit tests fake the WASM boundary while the
  tunnel integration suite proves the shared framing, device enrollment,
  revocation, and generated-app session-auth handoff against real Iroh endpoints.
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

- Coverage is tracked **repo-wide** via vitest v8 — `bun run coverage` (and CI's
  `bun run build && bun run coverage`).
- The engine packages are **gated** on per-package line + branch floors in the
  root `vitest.config.ts`. The floors sit a tight margin below the measured
  baseline so they catch regression without flaking, and **ratchet up**, never
  down. Current floors (measured → floor), ratcheted as coverage grows:

  | Package         | Lines (measured → floor) | Branches (measured → floor) |
  | --------------- | ------------------------ | --------------------------- |
  | `app-engine`    | 76.7% → 75%              | 74.8% → 73%                 |
  | `automation`    | 69.4% → 68%              | 75.2% → 74%                 |
  | `blueprints`    | 84.7% → 83%              | 75.8% → 74%                 |
  | `gateway`       | 76.4% → 75%              | 72.3% → 71%                 |
  | `agent-runtime` | 28.6% → 27%              | 85.2% → 84%                 |

  The global repo-wide line floor is **30%** (measured ~32%), an anti-regression
  guard across every included file (renderer/mobile included).

  `agent-runtime` lines are still the low outlier because most of it is
  process-spawning CLI/backend glue (the codex/claude drive loops, the automation
  host) whose meaningful coverage is the deferred e2e layer, not vacuous unit
  mocks; its pure surface (tool normalization, model-list parsing, the codex tool
  dispatch) is now covered. The floor is anti-regression; the 80% line / 70%
  branch target band (below) is what to keep ratcheting toward.
- **Renderer / mobile:** tracked, **not** gated on line coverage (no per-glob
  threshold). Their meaningful coverage is logic-units plus e2e journeys, not a
  renderer line percentage.
- Never gate coverage on trivial getters or chase 100%.

## Resolved decisions

These were open in #212 and are resolved here as the default position. They are
ratifiable in review — adjust the numbers, not the shape.

1. **Engine coverage floor.** Seeded at migration (table above) and **enforced**
   in CI now — the gate reflects reality, not aspiration. Ratchet the floors
   upward toward the target band of **80% line / 70% branch** as coverage grows;
   never lower them.
2. **Where Playwright + Maestro run.** **Nightly + on-demand** (scheduled
   workflow plus manual dispatch / label), never per-PR. Maestro runs on **local
   simulators** in the nightly job to start; **Maestro Cloud is deferred** until
   the flake budget justifies the spend.
3. **Where the convention lives.** The canonical convention is **this document**
   — single source of truth, linked from [AGENTS.md](AGENTS.md). A `/test-coverage`
   skill may later _wrap_ this doc (so agents can invoke it), but the doc stays
   authoritative; the skill must never fork the rules.
4. **Migration sequencing.** The runner swap was mechanical (imports only,
   `node:assert` kept), so it landed **atomically** with green-before →
   green-after rather than package-by-package — 653 tests, unchanged. The deeper
   per-package work that _does_ change tests (expect-matcher migration, coverage
   ratcheting, renderer logic-extraction, e2e journeys) proceeds **behind new
   work**, engine packages first.

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
