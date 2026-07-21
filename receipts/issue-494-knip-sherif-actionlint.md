# issue-494 — tune knip; add sherif + actionlint gates

`knip` was effectively useless (every `src` file was an entry, so it found zero
dead code, buried under 34 config hints, 177 false `@centraid/test-kit` lines,
and 649 export/type false positives). This retunes it into a trustworthy
files + dependency hygiene tool and adds two fast monorepo gates: **sherif**
(package.json hygiene) and **actionlint** (workflow linting).

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-5ac9baf3-ae7-1784640805-1 | claude-code | 5ac9baf3-ae74-4663-8f3f-7858b340fc66 | #494 | claude-opus-4-8 | 20 | 22557 | 3829478 | 15265 | 37842 | 2.4374 | 716 | 2345842 | 79887323 | 490491 | chore(tooling): tune knip; add sherif + actionlint gates (#494)knip made every s |
| claude-code-5ac9baf3-ae7-1784641158-1 | claude-code | 5ac9baf3-ae74-4663-8f3f-7858b340fc66 | #494 | claude-opus-4-8 | 15 | 24204 | 3199767 | 11055 | 35274 | 2.0276 | 731 | 2370046 | 83087090 | 501546 | chore(tooling): tune knip; add sherif + actionlint gates (#494)knip made every s |
| claude-code-5ac9baf3-ae7-1784641206-1 | claude-code | 5ac9baf3-ae74-4663-8f3f-7858b340fc66 | #494 | claude-opus-4-8 | 6 | 3144 | 1082187 | 2220 | 5370 | 0.6163 | 737 | 2373190 | 84169277 | 503766 | chore(tooling): tune knip; add sherif + actionlint gates (#494)knip made every s |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Checklist

- [x] knip is scoped to real entrypoints and emits zero configuration hints, surfacing real dead code instead of noise.
- [x] sherif runs as lint:packages in check:pr and CI, and reports no issues.
- [x] actionlint lints the workflows in CI via a pinned container at shellcheck error severity.
- [x] The three sherif findings are fixed: blueprints react aligned to 19.1.0 and mobile @types/jpeg-js moved to devDependencies.

## What changed

**`knip.json`** — knip is scoped to real entrypoints and emits zero
configuration hints, surfacing real dead code instead of noise. The root
workspace now owns only `scripts/` + workflows (it previously claimed every
package); each workspace declares real entrypoints, including the path-loaded
`worker_threads` runners, CLI bins, and the sqlite worker that knip cannot
auto-trace; the Rust/config-only workspaces (`data-plane`, `tsconfig`) are
ignored; `@centraid/test-kit` (an internal test util imported by 13 workspaces)
is ignored; and the export/member issue types are excluded by default because a
public-API monorepo makes them ~90% false positives. The report went from ~650
noisy findings to 2 dead-file candidates + the real dependency-hygiene list.
knip stays **on-demand** (`bun run knip`), not a gate.

**`package.json`** — sherif runs as lint:packages in check:pr and CI, and
reports no issues. Adds `sherif` (devDependency), the `lint:packages` (sherif)
and `lint:actions` (actionlint) scripts, and inserts `lint:packages` into the
`check:pr` gate. `bun.lock` updated for the sherif dependency.

**`.github/workflows/ci.yml`** — actionlint lints the workflows in CI via a
pinned container at shellcheck error severity. It uses
`docker://rhysd/actionlint:1.7.12` with `SHELLCHECK_OPTS: --severity=error`, so
pre-existing style/info nits don't fail the build while real shell bugs do, and
the `static` job also runs `bun run lint:packages` (sherif).

**`apps/mobile/package.json` + `packages/blueprints/package.json`** — the three
sherif findings are fixed: blueprints react aligned to 19.1.0 and mobile
@types/jpeg-js moved to devDependencies. `react-dom` was aligned alongside
`react`.

**`AGENTS.md`** — the pre-push gate note now lists sherif in the `check:pr`
mirror and documents actionlint as a CI-only gate plus the on-demand knip
deep-export mode.

## Decisions

- **Excluded knip's export/type dimensions by default.** With packages exposing
  public API via barrels + deep-path imports, `unused exports`/`types` were
  ~90% false positives (649). Files + dependency hygiene is the reliable signal;
  a deep export cleanup is available on-demand via `--include exports,types`.
- **actionlint gates in CI only, not `check:pr`.** It needs an external binary
  (Go); requiring it for every local push is friction, and workflow YAML rarely
  changes. The pinned container enforces it in CI; `lint:actions` is there for
  anyone who installs the binary.
- **shellcheck at `--severity=error`, not default.** The 6 pre-existing nits in
  `e2e.yml`/`release-desktop.yml` are info/warning/style; gating on errors lands
  the tool green now without a workflow-editing detour, and can be tightened
  later.
- **Aligned blueprints react down to 19.1.0** (the majority across the 4 other
  workspaces) rather than bumping everyone up to 19.2.7 — the conservative
  direction, and blueprints' react is a build-time devDependency.

## Out of scope

- Burning down knip's remaining real findings (unused deps like `zod`, the 2
  dead mobile files) — surfaced for follow-up, not fixed here.
- Adding knip as a CI gate — it still reports real findings that would block, so
  it stays on-demand until that list is cleared.

## Verification

knip is clean (0 config hints) and reports only real findings:

```sh
bun run knip
```

sherif passes:

```sh
bunx sherif
```

actionlint passes on all workflows at error severity (CI uses the pinned
container; locally with the binary + shellcheck on PATH):

```sh
find .github/workflows -type f -name '*.yml' -print0 \
  | SHELLCHECK_OPTS="--severity=error" xargs -0 actionlint
```

## Steering

**PASS.** No human-steering events (interrupts or corrections) in this session. The work proceeded sequentially per the issue specification without mid-task redirect or correction.

## Audit

**PASS.**

**What changed** faithfully describes the staged diff:

1. **knip.json** — Retooled to scope the root workspace to `scripts/` + workflows, added real entrypoints for each workspace (CLI bins, worker runners, sqlite-worker), ignored Rust/config workspaces (`data-plane`, `tsconfig`), ignored internal test-kit, and excluded export/type dimensions by default. Confirmed staged diff shows complete rework of entrypoints, addition of `ignoreDependencies`, `ignoreWorkspaces`, `ignoreBinaries`, `ignore`, and `exclude` fields.

2. **package.json** — Added `lint:packages` (sherif) and `lint:actions` (actionlint) scripts; inserted `lint:packages` into `check:pr`; added `sherif@^1.13.0` devDependency; bun.lock updated. Confirmed staged diff shows all these changes.

3. **.github/workflows/ci.yml** — Added `bun run lint:packages` (sherif) and `docker://rhysd/actionlint:1.7.12` steps to the `static` job with `SHELLCHECK_OPTS: --severity=error`. Confirmed staged diff shows both additions with inline comments.

4. **apps/mobile/package.json** — Moved `@types/jpeg-js` from dependencies to devDependencies (one of the three sherif findings). Confirmed staged diff shows the move.

5. **packages/blueprints/package.json** — Downgraded `react` and `react-dom` from 19.2.7 to 19.1.0 (the conservative direction, one of three sherif findings). Confirmed staged diff shows both downgrades.

6. **AGENTS.md** — Updated the pre-push gate note to document `lint:packages` (sherif) in the `check:pr` mirror, `actionlint` as a CI-only gate (needs external binary), and on-demand `knip` with `--include exports,types` for deep export cleanup. Confirmed staged diff shows expanded gate documentation.

**Checklist realization:**

- [x] **knip is scoped to real entrypoints and emits zero configuration hints.** Staged knip.json shows real entry points (`src/index.ts`, CLI bins, runner paths) per workspace, ignoreBinaries list (actionlint, python3), ignoreDependencies (@centraid/test-kit), exclude list (exports, types, etc.). This scoping + exclude configuration addresses the root cause (every src/ file was an entry, every export triggered false positives).

- [x] **sherif runs as lint:packages in check:pr and CI, and reports no issues.** Staged package.json adds `lint:packages` script and inserts it into `check:pr`; staged ci.yml runs `bun run lint:packages` in the static job. The three sherif findings (react version drift, @types/jpeg-js placement) are fixed in staged diffs.

- [x] **actionlint lints the workflows in CI via a pinned container at shellcheck error severity.** Staged ci.yml shows the docker://rhysd/actionlint:1.7.12 step with SHELLCHECK_OPTS: --severity=error. The severity gate allows pre-existing nits to land clean while catching real shell bugs.

- [x] **The three sherif findings are fixed: blueprints react aligned to 19.1.0 and mobile @types/jpeg-js moved to devDependencies.** Staged blueprints/package.json shows react 19.2.7→19.1.0 + react-dom 19.2.7→19.1.0; staged mobile/package.json shows @types/jpeg-js moved to devDependencies. Both fixes are present.

**Checklist mirrors issue #494:** Issue #494 scope specifies knip scoping, sherif wiring, actionlint CI gating, fixing the 3 sherif findings, and updating AGENTS.md. All four checklist items correspond to issue scope; all are realized in staged diff. Out-of-scope knip findings (unused deps, dead mobile files) are correctly omitted.
