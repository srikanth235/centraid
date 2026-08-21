# Issue #839 — promise-driven robustness: close the gap between designed states and proven states

GitHub issue: [#839](https://github.com/srikanth235/centraid/issues/839)

Umbrella issue worked by orchestration ([docs/multi-agent.md](../docs/multi-agent.md)):
one receipt, no child issues; slices are sub-agents and commit waves under this
umbrella. Sixteen gaps (G1–G16) across six waves. Every floor in this receipt
was ratcheted from a measured run, never asserted; no gate was weakened to go
green.

## Checklist

Wave 0 — encode the shape (G6, G7, G14, G16):

- [x] Every `app.json` declares a `states` block (designed + excluded) over the
  seven canonical designed states; the manifest validator enforces it as a
  closed partition
- [x] Coverage floors: tasks/agenda/notes graduated out of the blueprint blend,
  blend re-seeded from a measured run, first `apps/mobile` floors (pure-logic
  scope) — no number decreases
- [x] `tests/matrix.json` gains seats, appSeats (Grid B), appStates (Grid D),
  engineRegistry, and consentLedger blocks; `validate-matrix.mjs` enforces
  them; report renders Grid B/D skeletons

Wave 1 — name the flows (G6, G7):

- [x] App admission contract stated for all eight apps
- [x] Every designed state has a named owner per seat, or a tracked gap
- [x] Tally rows grey-with-citation (#831), never silently absent

Wave 2 — raise the adversaries (G4, G5, G9, G10):

- [ ] Mutation seeds extended over the blueprint app layer and mobile logic
- [ ] Scope-denial sweep generated from the 37 app.json manifests
- [ ] Egress-dispatch law; policy-cascade property suite
- [ ] Fuzz runner + committed crasher corpus, wired to a nightly lane

Wave 3 — prove the joins (G1, G2, G3, G11, G12):

- [ ] Join rig: one gateway + N in-process seats; grant verbs in the seeded
  simulator; revocation propagation and parked lifecycle owned
- [ ] Version-skew lane; time zoo under the fake clock

Wave 4 — own the devices (G8):

- [ ] Maestro roster extended beyond photos; device-only claims named

Wave 5 — close the contract (G13, G15, G16):

- [ ] Report v2: verdict strip, attention queue, grids B–G, consent ledger
- [ ] Derived lane lists; zero-grey everywhere; RTL+CJK gallery lane
- [ ] Docs pass (TESTING.md, decisions.md, glossary)

## What changed

### Wave 0 — encode the shape

**W0-B — designed-state blocks in the app manifests.** Each of the eight
`packages/blueprints/apps/*/app.json` gains a `states` block (sibling of
`seats`): `designed` enumerates which of the seven canonical designed states
(`dayone, pending, offline, stale, conflict, parked, denied`) the app claims;
`excluded` is reserved for structural unrepresentability and requires a reason
and citation per entry. `packages/server/src/engine/registry/manifest.ts` gains
`CANONICAL_DESIGNED_STATES`, the schema for the block
(`additionalProperties: false`), and a closed-partition cross-check: every
canonical state sits in exactly one of designed/excluded.
`packages/blueprints/scripts/build-manifest.mjs` folds the block into the
gallery `manifest.json` beside seats. New suite
`packages/blueprints/src/app-states.test.ts` (27 tests) round-trips every app
through the real validator; `manifest.test.ts` gains ten cases.

**W0-A — coverage floors (G14).** `tests/coverage-floors.json`: the blueprint
blend key is replaced by `{_shared,docs,locker,people,tally}` at 41/33;
tasks (37/25), agenda (40/30), notes (39/27) graduate to their own scopes;
`apps/mobile/src/lib/**` (56/48) and `apps/mobile/src/**/*-model.ts` (86/72)
are the first mobile floors. All seeded ~2 points under a 2026-08-21 measured
run whose path-filtered method can only under-measure (cross-checked within
0.2pt of the full-run number recorded on #839). The `approvedDeviation`
paragraph records the method and the blend-key replacement waiver. TESTING.md
Layer 5 and the floors table updated; the stale "mobile is deliberately
ungated" comment in `vitest.config.ts` rescoped to screens.

**W0-C — matrix schema v2 + report grid skeletons (G6, G7, G16).**
`tests/matrix.json` gains five blocks between `appEngines` and `flows`:
`seats` (3 rows citing the seat-doctrine anchors), `appSeats` (Grid B, 8×3 =
24 cells: `owned{owner,tier}` | `gap{trackingIssue}` | `skip{reason,citation}`),
`appStates` (Grid D, 8×7 = 56 cells mirroring every `app.json#states` block in
both directions), `engineRegistry` (19 engines with source anchors; null
`propertyFlow`/`mutationSeed` is a visible adversary gap for Wave 2), and
`consentLedger` (the 8 permission layers; `app-scope-manifests` is the tracked
adversary hole, gap G4). `validate-matrix.mjs` grew `validateAppAxes`: app axes
must equal the `app.json` glob set, every app owes every cell, owned needs an
existing path, gap needs a registered open issue, skip needs a followable
citation (real doc anchor or registered issue), engine sources/flows/seeds are
cross-checked against the flow list and `scripts/mutation/seeds.mjs`, and the
Grid D column set must equal the manifest state partition.
`tests/matrix.schema.json` mirrors it for editors. `generate.mjs` renders both
grids directly after the app × engine grid with a neutral declared/unowned/
excluded alphabet — deliberately not graded green — and adds
`summary.appSeatCells`/`appStateCells`; no new exits, `cellsMissing` proven
identical (135) before and after, `historyPoint` whitelist untouched until
Wave 5. Real owners wired where they provably exist: photos origin/viewer
journeys, tasks dayone/denied, notes dayone/conflict/denied, agenda
parked/denied; tally rows are skips citing #831; locker viewer skip cites the
seat profile's `disabledOn`. The synthetic-root harnesses in
`generate.test.mjs` and `generate-nightly-semantics.test.mjs` copy
`scripts/mutation/` into the fixture root since the validator now imports the
seed catalog.

**Wave 0 audit fixes.** A fresh-context audit (PASS on all three slices,
sabotage-tested) surfaced fixes, applied by a fixer slice: the app-axes
validation lifted into `scripts/test-report/validate-app-axes.mjs` (with
`matrix-fixture.mjs`, `report-fixture-root.mjs`, and split suites
`validate-matrix-app-axes.test.mjs` / `generate-app-grids.test.mjs`) so every
file sits under the 625-line hygiene ceiling; `appStates.notes.conflict`
demoted to gap (conflict is unbuilt everywhere — a copy test cannot own it)
with a `copy-owners` note scoping what copy-level owners prove; the Grid B
legend reworded from "journey" to "proof" and its skip count labeled
held/excluded; missing-`reason` exclusion rejections tested in
`manifest.test.ts`; the dead exclusion loop in `app-states.test.ts` replaced
by the pin alone; blend provenance re-measured (44.12/36.31 five-tree,
42.94/33.95 eight-tree) with the exact reproduction command recorded — no
numeric floor changed; `docs/blueprint-seats.md` gains a Designed states
subsection and `docs/traps/coverage-run-filters.md` records the `--project`
coverage footgun.

### Wave 1 — name the flows

`docs/blueprint-seats.md` gains `## App admission contract` — six named claims
(valid manifest, engine conformance, states owned/tracked, seats
owned/tracked/refused, pending projection per action, placement declared or
structurally absent), each citing its gate; it delimits itself from
TESTING.md's same-named evidence-ladder section (shell half vs evidence half).
`docs/glossary.md` gains designed state, canonical designed states, admission
contract, engine registry, consent ledger. Grid B promotions (verified
per-seat journeys): docs.custodian, docs.viewer, locker.custodian,
people.viewer. Grid D goes 5→19 owned (app-boot suites for agenda
pending/parked/denied, docs dayone/offline/denied, locker pending/denied,
notes pending/stale/denied, people.denied, photos dayone/offline/denied,
tasks.pending via driven pending projections); every refusal recorded with
reasons (source-text greps and component-isolation specs are below the owned
bar; conflict is unbuilt everywhere). Tally's seven Grid D cells become
`{status:"held", citation:"#831"}` — a new cell status enforced by
`validate-app-axes.mjs` (citation must be a registered issue), mirrored in
`tests/matrix.schema.json`, rendered grey with the citation badge, counted
with skips, zero-grey contract proven unmoved.

### Wave 2 — raise the adversaries (landed so far)

**W2-2 — scope-denial sweep, egress-dispatch law, policy-cascade properties.**
`packages/server/src/serve/manifest-scope-denial.sweep.test.ts` (90 tests):
all 37 app.json manifests through the real validators into the real
`evaluateConsent` under a deliberately maximal grant, asserting the closed
six-class ConsentDeny grammar verbatim, with a clamp oracle biconditional
(refuses ⟺ not covered) and 300-run fast-check fuzzing of malformed scope
entries (deny, never throw). Placed in packages/server (not vault) because
vault must never depend on app-engine — rationale in the file header.
`packages/server/src/provider-egress-dispatch.test.ts` (6 tests):
`[law:provider-egress-dispatch]`, registered in the matrix laws block —
provider SDK specifiers, provider host literals, and host-path HTTP clients
banned across packages/server/src/{acp,enrich,engine,routes,serve} +
apps/{desktop,web,extension}/src (659 files, per-root sanity floors), with the
positive dispatch road asserted and sabotage self-tests; current tree clean.
`packages/server/src/automation/fire/enrich-resolve.property.test.ts`
(16 tests): last-non-null-write per field, ceiling never raised by any rule
chain, fail-closed on unreadable tiers, order-insensitivity exactly where the
contract claims it. Root integration: `scripts/lint-law-registry.mjs` gains
`.stryker-tmp` in SKIP_DIRS (Stryker sandboxes copied law-owning suites and
produced false duplicate-owner findings).

## Out of scope

- Fixing the pre-existing product defects the new adversaries surface — those
  become their own issues, linked from the report's auto-filed lane (Wave 5).
- The N−1 client artifact for version skew: the protocol window is a single
  point today (v3 = min 3), so the skew lane can only assert the update wall;
  producing a pinned-old-client artifact is a release-pipeline change.
- Unparking: parked payloads settle (`settleDurableParkedPayload`), they do
  not unpark; the rig tests the lifecycle that exists.

## Decisions

- **Floors from filtered runs are legal when the filter can only
  under-measure.** A positional-path vitest coverage run keeps the repo root
  as the untested-file expansion root, so all denominators stay whole;
  cross-package suites can only add coverage. Never filter with `--project`
  for coverage: it collapses the roots and silently over-measures.
- **The blend-key replacement is a scope rename, not a weakening**: every tree
  the old key governed is still floored, and every floor over those trees
  rises.
- **Two mobile keys, not one brace**: `lib/**` and `**/*-model.ts` are 30
  points apart; blending them would waste the view-model surface's strength.
  They deliberately overlap on one file; vitest gives each key its own
  coverage map.
- **#831 is closed, and a skip may cite it.** The validator requires skip
  citations to be *registered* issues (open or closed) — a held interface
  cites the ruling that held it — while gap cells require an **open** issue.
- **Grid B starts thinner than reality**: docs and locker already have real
  per-seat journeys; they stay `gap` in Wave 0 by design and Wave 1 promotes
  them.
- The check pipeline itself is not restructured by this issue: new artifacts
  register with the gates that already exist (validate-matrix,
  validate-nightly-wiring, lint-e2e-flows, mutation floors). The one genuinely
  new gate home is the Wave 2 fuzz runner's nightly lane.

## Verification

Filled per wave; the final gate run happens once after all waves:

```
bun run check:pr
```

Wave 0 (interim, per slice):

```
bun run test:ratchet          # ok — blend replacement waived by changed approvedDeviation
node scripts/test-report/validate-matrix.mjs   # exit 0
bun run test:report:smoke     # ok
```

## Audit

Fresh-context audit sub-agents run per wave; the verdicts land here with the
final wave. (Pending — Wave 0 audit runs when W0-C completes.)

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->
