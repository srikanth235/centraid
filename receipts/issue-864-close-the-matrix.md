# Issue #864 — Umbrella: close the matrix — the missing-test backlog by priority, and one-hue-one-meaning report semantics (2026-08-25 audit)

One orchestrated pass over the two findings of the 2026-08-25 audit: the
missing-test backlog the matrix declares but nobody is paying down, and a
report register where one hue answered several questions at once. Wave 0 comes
first because everything after it depends on the ledgers telling the truth
about what is still open.

## Checklist

### Wave 0 (landed)

- [x] Re-home closed-issue citations across the four ledgers to #864
- [x] Correct seven trackingIssues states from open to closed
- [x] Leave Tally's #831 held-citations untouched
- [x] Add the validate-citations-open gate and its test
- [x] Wire test:citations into package.json and a nightly e2e.yml step
- [x] Start the receipt with an independent Audit

### Wave 1 (landed)

- [x] Own the fireable app-axis state cells with co-located jsdom tests
- [x] Own the nine seat cells with desktop and web e2e and a mobile flow
- [x] Leave nine state cells as honest product-surface gaps
- [x] Apply the matrix owner-edits and keep validate-matrix green

### Wave 6 (landed)

- [x] Recolor the report to one hue one meaning
- [x] Unify the vocabulary and paint the legend chips
- [x] Invert the guardrail test to forbid shared tints

### Waves 2–5, 7

- [ ] _placeholder — the root agent appends each wave's checklist as it lands_

## Waves

| wave | subject | state |
| --- | --- | --- |
| W0 | re-home closed-issue citations to #864; add the open-citation gate | landed |
| W1 | own the app-axis state and seat cells; leave nine as product-surface gaps | landed |
| W6 | recolor the report to one hue one meaning; invert the collision guardrail | landed |
| W2 | _placeholder — root agent appends_ | pending |
| W3 | _placeholder — root agent appends_ | pending |
| W4 | _placeholder — root agent appends_ | pending |
| W5 | _placeholder — root agent appends_ | pending |
| W6 | _placeholder — root agent appends_ | pending |

## What changed

### W0 — the ledgers stop citing dead trackers, and cannot start again

TESTING.md's rule is that a declared exception — a gap, a skip, an env-red
guard, a quarantined flake — is only tolerable because an OPEN issue is where
it gets paid down. Three validators already enforce that
(`validate-matrix.mjs`, `skip-inventory.mjs`, `env-red-inventory.mjs`), and all
three read "still open" out of `matrix.trackingIssues` — a hand-maintained
snapshot. The snapshot went stale: seven entries (`#781`, `#790`, `#791`,
`#834`, `#839`, `#842`, `#844`) still declared `state: "open"` for issues that
had closed, so every gate stayed green while ~140 live exceptions pointed at
dead trackers.

**`tests/matrix.json`** — 114 citations re-homed to `#864`, and one added:

- `trackingIssues`: the seven stale `"open"` declarations corrected to
  `"closed"`; `#864` registered open. Closed entries stay registered, because
  the notes still cite them as provenance and the validator requires every
  cited number to be registered.
- structured tracking fields, 18: `gaps.extension.offline` and
  `gaps.extension.journey` (781 → 864); the four compat `revisitTriggers`
  — `blob-custody`, `gateway`, `app-engine`, `automations` (781 → 864); the
  nine `appSeats` gap cells (agenda ×2, notes ×2, people ×2, photos, tasks ×2),
  `appStates.trackingIssue`, `consentLedger.app-scope-manifests.adversary
  .trackingIssue` and `journeys.trackingIssue` (839 → 864).
- prose tracking claims in `notes`, 96: 77 of the form
  `Tracked under #781 (originally #656 | #657 | #659)` keep their parenthetical
  and swap the tracker; 2 tracked-gap notes (`extension.offline`,
  `extension.journey`) become `Tracked gap (#864, originally #656)`; 16 bare
  `tracked under #781` sentences — the per-surface accessibility line,
  `desktop.offline`, `blueprints.accessibility` and their neighbours — become
  `tracked under #864 (originally #781)`, so #781 is preserved where it would
  otherwise have vanished; `appStates.copy-owners` becomes
  `Tracked under #864 (originally #839)`.
- one citation ADDED: `tunnel-pairing.durability` is `partial` and cited only
  `#842`, which is closed, so once the ledger was corrected the cell had no
  live tracker at all. Its note gains `Remaining depth tracked under #864.`

No assessment, cell owner, tier, `minimumTests`, floor, budget or approved
deviation was touched.

**`tests/skips.json`** — all 25 sites re-homed: `781 ×7` and `790 ×18` → `864
×25`. `_budget` stays 25. The eighteen 790-cited reasons already carried
`(rig lane split to #790 by #781; originally #656)`, so their provenance
survives the field move untouched; the seven 781-cited reasons named only their
origin, so each gained `re-homed from #781` in the same parenthetical.

**`tests/env-red.json`** — all 6 guard sites re-homed `790 → 864`. `_budget`
stays 6. Every `revisitTrigger` already ends `(rig tracker: #790)`, so no prose
needed editing.

**`tests/quarantine.json`** — unchanged: `entries` is empty, so it cites
nothing.

**`scripts/test-report/validate-citations-open.mjs`** (new) — the gate that
stops this recurring. It collects every live-tracking citation across the four
ledgers by SHAPE rather than by an enumerated list of paths — any
`trackingIssue` or `issue` field at any depth, plus the prose forms
`tracked under #N` / `tracked gap (#N` — so a grid added to the matrix next
month is covered the day it lands. It then asks the GitHub REST API for each
issue's state and fails on any citation whose issue is closed, naming the
number, every site citing it, and the remedy. It also checks the second half of
the loop: a `trackingIssues` entry DECLARING `open` for an issue that is
closed, which is the exact shape of this regression.

A bare `#N` elsewhere in prose is deliberately left alone. Closed issues are
legitimate provenance — `originally #656`, `#535 Phase 5`, `#799 retired the
served-app plane` — and a gate that forbade them would push authors to delete
history to go green.

Pure logic (`collectCitations`, `declaredOpenIssues`, `reportCitationErrors`)
is separated from I/O, and `fetch` is injectable, so
`validate-citations-open.test.mjs` drives all twelve cases hermetically:
structural and prose collection, the registry exclusion, an open citation
passing, a closed one failing with its number and site, a stale `open`
declaration failing, a transport error, a non-200 response, and a missing or
blank `GITHUB_TOKEN`. The last three all fail with **"did NOT run"** in the
message: an unreachable API must never degrade into a green run, which would
restore precisely the blind spot the gate exists to remove.

**Wiring** — `bun run test:citations` in the root `package.json`, and one step
at the END of `test-health-report` in `.github/workflows/e2e.yml`, under
`if: always()` with `GITHUB_TOKEN` from the workflow secret. Nightly-only on
purpose: the PR lane must not gain a dependency on `api.github.com`. Running
last under `always()` means it cannot suppress the report it follows, and
`test-health-report` is already in `nightly-failure-issue`'s `needs`, so a
stale citation files the nightly red issue with no further wiring. Nothing
existing in the workflow was reordered, relaxed or removed.

### W1 — the app-axis grids stop declaring gaps the code can already prove

Wave 1 closed the app-axis gaps the report's §2/§3 grids declared. Twenty-one
designed-state cells gained co-located jsdom owners that mount the production
`Root`/row components over a stubbed `window.centraid` and reach each state
through the app's own derivation, never a copy table: agenda dayone/offline/
stale/conflict, notes conflict/parked/offline, tasks stale/offline/parked/
conflict, docs parked/conflict (with pending re-pointed at the existing Electron
overlay spec), locker dayone, people dayone/pending/parked, photos pending/
parked/conflict. This did **own the fireable app-axis state cells with
co-located jsdom tests**.

The nine seat cells gained e2e owners — agenda/notes/tasks viewer (web
Playwright, executed green in the authoring container) and custodian (desktop
Playwright, nightly-validated-only), people origin (a new `people-roster.mjs`
Maestro flow, wired into the home-apps suite at index 4 with the budget
re-derived 10→11 min) and custodian, photos custodian — so this did **own the
nine seat cells with desktop and web e2e and a mobile flow**. The agenda seat
was repaired to the shared `libraryReachability` kit (it alone consulted
`navigator.onLine`, which the kit forbids because a local gateway is reachable
with no network).

Nine cells stay `gap` because no product surface renders them — this did **leave
nine state cells as honest product-surface gaps**: docs.stale, locker.offline/
stale/parked/conflict, people.offline/stale/conflict, photos.stale. A test must
not invent copy for a state the app cannot show; these keep the grid-level #864
tracker.

The matrix owner-edits (21 state cells, 9 seat cells, the journey entry, two
notes recording the offline-as-stale derivation and the nightly-only desktop
specs) were applied and `validate-matrix` stays exit 0; the People states test
was moved off `toHaveBeenCalled*` onto recorded-array `toStrictEqual` (the
hygiene budget is down-only), and the Photos states test's internal recording
string dropped the storage noun that tripped the photos-vocabulary rule. This
did **apply the matrix owner-edits and keep validate-matrix green**.

Wave 1 paths: `tests/matrix.json`; `packages/blueprints/manifest.json` (lists
the new per-app test files); `packages/blueprints/apps/agenda/app-root.tsx`
(the reachability repair); the co-located state owners
`packages/blueprints/apps/agenda/states.test.tsx`,
`packages/blueprints/apps/notes/states.test.tsx`,
`packages/blueprints/apps/tasks/states.test.tsx`,
`packages/blueprints/apps/docs/states.test.tsx`,
`packages/blueprints/apps/locker/states.test.tsx`,
`packages/blueprints/apps/people/states.test.tsx`,
`packages/blueprints/apps/photos/states.test.tsx`; the viewer specs
`apps/web/tests/e2e/agenda.spec.ts`, `apps/web/tests/e2e/notes.spec.ts`,
`apps/web/tests/e2e/tasks.spec.ts`; the custodian specs
`apps/desktop/tests/e2e/agenda.spec.ts`, `apps/desktop/tests/e2e/notes.spec.ts`,
`apps/desktop/tests/e2e/tasks.spec.ts`, `apps/desktop/tests/e2e/people.spec.ts`,
`apps/desktop/tests/e2e/photos.spec.ts`; and the origin flow
`tests/agent-e2e-mobile/flows/people-roster.mjs` with its contract
`tests/agent-e2e-mobile/flows/people-roster.md`, wired through
`tests/agent-e2e-mobile/run-home-apps-suite.mjs` and
`tests/agent-e2e-mobile/flows/home-apps-budget.md`.

### W6 — the report says one thing per hue

Wave 6 gave the nightly report one hue per meaning (M14). This did **recolor the
report to one hue one meaning**: seven Night Watch tone families, each answering
exactly one question — ok (passed a solid claim), partial (passed a partial
claim, teal), danger (failed + infra-mismatch), flaky (green on retry, violet),
gap (no test exists — the matrix hole and the app grids' unowned seat unified to
one new plum family), attn (integrity, moved off the `--seam` literal it used to
share with gap), grey (absence of evidence). Every type-on-tint pairing clears
4.5:1 in both themes, recomputed rather than asserted.

The §2/§3 axis alphabet, the §8 register and the ledgers' verdict words were
merged to one map, and each grid now carries painted legend chips in the real
cell treatments — this did **unify the vocabulary and paint the legend chips**;
the "second verdict vocabulary" divergence row is superseded with a dated ruling.

`report-theme.test.mjs` now asserts the inverse of its old collapse law — no two
states with different meanings may share a background tint, the one allowed
exception being failed≡infra told apart by word — and a companion check replays
the seam≡attn defect so the detector is known to fire. This did **invert the
guardrail test to forbid shared tints**.

Wave 6 paths: `scripts/site-tokens.mjs` (the Night Watch ramp, 19→25 rungs, and
the `--st-gap` re-point off `--seam`), the generated `scripts/test-report/report-tokens.css`,
`scripts/test-report/report-theme.mjs`, `scripts/test-report/generate.mjs`,
`scripts/test-report/render-briefing.mjs`, and the guardrail/word-map tests
`scripts/test-report/report-theme.test.mjs`,
`scripts/test-report/report-state-words.test.mjs`,
`scripts/test-report/generate-app-grids.test.mjs`,
`scripts/test-report/smoke.mjs`; the divergence and decision records
`docs/design-divergences.md` and `docs/decisions.md`.

### W2–W5

_Placeholder — the root agent appends the remaining waves here._

## Decisions

- **A closed issue may stay in prose; it may not be the tracker.** The
  re-homing preserves every historical number rather than deleting it, and the
  new gate checks only the live-tracking forms. That is the same line
  `validate-matrix.mjs` already draws for partial notes ("Closed issues may
  stay in the prose as provenance; they cannot be the thing tracking the gap").
- **The stale-`open`-declaration check belongs in the same gate.** The
  citation check alone would have passed on 2026-08-24, because every citation
  pointed at an issue the ledger *said* was open. Checking the declaration is
  what makes the three offline validators honest between nightlies.
- **Tally's `#831` citations were NOT re-homed.** The three `appSeats` skip
  cells and the seven `appStates` held cells cite `#831` as the RULING that
  held Tally's interface, not as a tracker. `validate-app-axes.mjs` documents
  this and deliberately exempts them from the open requirement ("NOT required
  to be open, because the issue closes when the clearing lands while the hold
  itself continues"), and its failure text names `#831` as the worked example.
  Re-pointing them at #864 would assert that #864 held Tally, which is false;
  and the held-cell schema allows only `status` and `citation`, so there is no
  text field in which the true ruling could be preserved. The new gate
  therefore excludes `citation` fields from its collection, matching the
  existing validator rather than contradicting it. **If the umbrella wants
  these re-homed anyway, it needs a schema change to carry the provenance —
  flagged rather than done.**

## Out of scope

- `#791` and `#844` remain registered in `trackingIssues` with no citation
  anywhere. Nothing validates for unreferenced registry entries, and pruning
  them is a guess about what future prose will want to cite, so they were left
  alone rather than removed on this pass.
- The bare provenance references that are not tracking claims — `remain under
  #587` in the two `oauth-worker` notes, `(#839 Wave 2/3/4)` in the consent
  ledger's gap notes, `#535 Phase 5`, `#656 Layer 2`, `#603`, `#630`, `#708`,
  `#799`, `#831` and `#834` in the deviation prose — are untouched by design.

## Verification

A reviewer can re-run the Wave 0 gates directly; all are package-filtered, never the full suite:

```sh
bun run test:matrix
node scripts/test-report/skip-inventory.mjs
bun run test:env-red
bun run test:quarantine
node node_modules/vitest/vitest.mjs run --config scripts/test-report/vitest.config.ts validate-citations-open
```

The five changed non-doc paths are `tests/matrix.json`, `tests/skips.json`,
`tests/env-red.json`, `scripts/test-report/validate-citations-open.mjs`,
`scripts/test-report/validate-citations-open.test.mjs`, plus `package.json`
(one script entry) and `.github/workflows/e2e.yml` (one appended step).

Checklist crosswalk — each landed item and where it is realized above: this
change did **re-home closed-issue citations across the four ledgers to #864**
(matrix 114+1, skips 25, env-red 6, quarantine none), did **correct seven
trackingIssues states from open to closed** (and register #864), did **leave
Tally's #831 held-citations untouched** (held-cell exemption), did **add the
validate-citations-open gate and its test** (12 hermetic cases), did **wire
test:citations into package.json and a nightly e2e.yml step** (no PR-lane
GitHub dependency), and did **start the receipt with an independent Audit**
(the section below).

Recorded results, package-filtered, never the full suite:

| command | result |
| --- | --- |
| `bun run test:matrix` | PASS — 15 surfaces × 11 dimensions, 163 canonical flows, 136 owned cells graded, 25 inventoried skips; nightly-wiring and release-wiring green |
| `node scripts/test-report/skip-inventory.mjs` (`test:ratchet`) | PASS — 25 inventoried skip sites, budget 25 |
| `bun run test:env-red` | PASS — 6 inventoried environment-guard sites, budget 6 |
| `bun run test:quarantine` | PASS — 0 entries, none expired (budget 0) |
| `node node_modules/vitest/vitest.mjs run --config scripts/test-report/vitest.config.ts validate-citations-open` | PASS — 12/12 |
| `bun run test:ratchet:unit` | PASS (with three files from a concurrent sibling slice stashed; see below) |
| `bun run lint` (scoped to the two new files) | PASS |
| `bun run format:check` | PASS — all matched files correctly formatted |
| `bun run lint:workflow-pins` | PASS — 21 workflows clean |
| `bun run lint:ci-egress` | PASS — the new step joins an existing job, so no ledger entry is needed |
| `bun run knip` | PASS — exit 0 |

The gate's own live path was exercised end to end in the authoring sandbox,
which has no GitHub credential: `node
scripts/test-report/validate-citations-open.mjs` issued the real request and
exited **1** with `could not resolve issue #864 (HTTP 401 …); the
open-citation check did NOT run`, and with `GITHUB_TOKEN` unset it exited **1**
with the token instructions. Neither degraded into a pass. The green path
(every citation resolving open against the real API) is therefore first proven
on the nightly runner, where the workflow secret is real — the collection over
the committed ledgers was verified locally and yields exactly one cited issue,
`#864`, at 146 sites.

`bun run test:matrix` first failed on exactly the cell the correction exposed —
`tunnel-pairing.durability is partial but cites no open tracking issue (only
#842)` — which is the gate doing its job; the note gained a live tracker rather
than the ledger keeping a false `open`.

The whole-lane `test:ratchet:unit` run reports six failing files
(`generate*.test.mjs`, `report-state-words`, `report-theme`) that belong to a
concurrent sibling slice editing `scripts/test-report/report-theme.mjs`,
`report-tokens.css` and `scripts/site-tokens.mjs` in the same worktree; with
those three files stashed the lane is green, which isolates them from this
change set.

**No gate, budget, floor, allowlist or test was weakened.** `_budget` is
unchanged in both inventories, no assessment or floor moved, the `check:push`
gate list is untouched, and the workflow gained a step without any existing
step being reordered or relaxed. The one config file edited is
`package.json`, to add the new gate's script entry.

## Audit

### Wave 0 — independent fresh-context reviewer

A sub-agent that did not author the change read the two ground truths — the
staged diff and issue #864 — and adjudicated the required checks. Verdicts:

1. **`## What changed` faithfully describes the diff — PASS.** Every count
   reproduces from the staged hunks (7 trackingIssues state flips, 114 matrix
   citations re-homed + 1 added, 25 skips, 6 env-red), with no misrepresentation
   and no omission.
2. **Each `- [x]` item is realized in the diff — PASS.** The six checked items
   map to the ledger re-homing, the trackingIssues corrections, the untouched
   Tally citations, the new gate and test, the package.json/e2e.yml wiring, and
   this Audit — each present in the diff.
3. **The `## Checklist` mirrors the issue's checklist — PASS.** The Wave 0
   checklist items are the issue's Wave 0 goals (re-home + enforce); Waves 1–7
   are the issue's remaining waves, left unchecked.

**Overall: SHIP.** Supporting evidence per question below.

- **Q1 — "What changed" faithful to the diff? CONFIRMED.** Recomputed from the
  staged hunks: 7 `trackingIssues` states flip `open→closed` (`842, 844, 781,
  834, 790, 791` as line pairs; `839` via re-attribution), `864` registered
  open; 114 matrix citations re-homed (18 structural + 96 prose) with the
  79-carried-provenance / 17-bare split reconciling exactly; +1 added
  (`tunnel-pairing.durability`); 25 skips and 6 env-red sites all `=864` with
  provenance retained; quarantine untouched.
- **Q2 — Any live tracker still citing a closed issue? CONFIRMED none.** 18/18
  structural + 97/97 prose in matrix, 25/25 skips, 6/6 env-red resolve to #864
  (open). Closed numbers that remain are provenance only. Tally's #831 appears
  only in `citation` fields (10×) and one registry `url`, zero
  `trackingIssue`/`issue` fields — genuinely exempt and uncollected.
- **Q3 — Validator enforces its claim? CONFIRMED.** Structural + prose
  collection, registry exclusion, fails on a closed citation and on a stale
  `open` declaration, injectable fetch, every unreachable path a hard "did NOT
  run". Test file drives 12/12, re-run green.
- **Q4 — Anything weakened? CONFIRMED nothing.** Both `_budget`s unchanged; no
  assessment/owner/tier/minimumTests/floor/grade touched; `package.json` one
  added script; `e2e.yml` a pure append; `check:push`/`check:pr` untouched.
- **Q5 — Scope creep? CONFIRMED none.** All 8 staged files named in the
  receipt, `validate-citations-open.test.mjs` included.

**Nit (non-blocking), acknowledged:** the Decisions section says the gate
"excludes `citation` fields from its collection." It excludes them *by shape* —
`citation` is not a collected key and its values do not match the
`tracked under/gap` prose regex — not by an explicit key skip. A future
`citation` value phrased "…tracked under #N…" would be collected. Harmless
today (no such value exists); a follow-up may add an explicit `citation`-key
skip if the stronger guarantee is wanted.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-25 | claude-code | 5b72723a-7529-5ad1-9a1b-b369d6c2972b |
