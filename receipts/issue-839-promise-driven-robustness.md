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

- [x] Mutation seeds extended over the blueprint app layer and mobile logic
- [x] Scope-denial sweep generated from the 37 app.json manifests
- [x] Egress-dispatch law; policy-cascade property suite
- [x] Fuzz runner + committed crasher corpus, wired to a nightly lane

Wave 3 — prove the joins (G1, G2, G3, G11, G12):

- [x] Join rig: one gateway + N in-process seats; grant verbs in the seeded
  simulator; revocation propagation and parked lifecycle owned
- [x] Version-skew lane; time zoo under the fake clock

Wave 4 — own the devices (G8):

- [x] Maestro roster extended beyond photos; device-only claims named

Wave 5 — close the contract (G13, G15, G16):

- [x] Report v2: verdict strip, attention queue, grids B–G, consent ledger
- [x] Derived lane lists; zero-grey everywhere; RTL+CJK gallery lane
- [x] Docs pass (TESTING.md, decisions.md, glossary)

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

**W2-3 — fuzz runner, crasher corpus, nightly lane (G10).** `scripts/fuzz/`:
a dependency-light mutation fuzzer (mulberry32-seeded; eight byte strategies
plus crossover and a structure-aware JSON pass) over six parser/codec targets
— protocol-handshake, tunnel-wire, cbsf-directory, wal-keys, fts-match, and
the fts gateway/replica mirror. Work is measured in iterations, never wall
clock: two runs at the same seed produce byte-identical summaries (proven in
the replay suite). Targets import built `dist/*.js` by absolute path (the
design-gallery precedent); `packages/client` alone is emit-declaration-only,
so its source is imported through a TS resolve hook. 42 committed corpus
seeds; unseen behaviour signatures promote inputs into a live corpus (capped
512). Findings partition through `scripts/fuzz/known-findings.json`: a
registered class is reported non-fatally, an unregistered class fails the
lane with the base64 repro. `scripts/fuzz/replay.test.mjs` (14 tests) pins
every committed crasher to its exact class and message and asserts a
de-registered class runs clean — the can-never-return lock. Nightly wiring:
new `fuzz-parsers` job in `e2e.yml` (plus a `fuzz` dispatch suite option),
evidence artifact `nightly-evidence-fuzz`, all enforced by
`validate-nightly-wiring.mjs` (job present, artifact named, both scripts run,
artifact path unflattened). Roughly 112M executions across four hunt seeds
surfaced three genuine product findings, registered open under #839 with
product code untouched: `wal.closer-roundtrip-rejected` (`CLOSER_KEY_RE`
admits `closed-000000000000` but `walGroupCloserKey` throws on the parsed
result — the codec halves disagree; the segment parser has the end-offset
guard, the closer parser does not), and `fts-mirror.decision` /
`fts-mirror.expression` (the client replica's token grammar diverges from the
gateway's: mark-only queries are refused online but searched offline, and
`don't` tokenizes to one prefix phrase online but two offline, so ranking and
the 16-token bound apply to different token streams per plane).

**W2-1 — mutation seeds over the blueprint app layer and the phone (G9).**
`scripts/mutation/seeds.mjs` grows 16→24 seeds: tasks, notes, agenda, the
`_shared` engines (pending-overlay, selection, triage, search-scaffold), and
`apps/mobile` (src/lib pure logic). Three new suites (171 tests): notes and
agenda `logic.ts` had no tests at all (now 82.74 / 89.87 file scores);
pending-overlay measured 48.23 against its existing suite — below the
absolute-weakness line — and `pending-overlay-law.test.ts` (54 branch cases
over every export) took it to 96.79. Every floor added is PROVISIONAL-LOCAL
at (local − 11), the local/CI gap #656 measured applied in the pessimistic
direction, with the re-seed instruction recorded in
`tests/mutation-floors.json#_w2Comment`. Two structural discoveries recorded
there: Stryker's vitest runner dry-runs a jsdom project as "No tests were
executed" (so `_shared/untrusted.ts` cannot be seeded until a node-side
suite exists; the new suites were built node-side over a three-property DOM
stub), and mutation sandboxes cannot resolve the `../design/src` alias (bare
specifier → dist required, documented per config). Deliberately out, with
reasons in each config: const tables zeroed by `ignoreStatic`, mobile
`notification-model`/`phone-link-parse` (their own suites never execute
24 of 98 mutants — flagged follow-up), rendering, real-gateway queries. A
fixer pass then split the over-ceiling suites (notes 1128 lines → three
files, pending-overlay 730 → two, agenda likewise) and replaced all 42
`toHaveBeenCalled*` assertions with recording fakes asserting accumulated
outcome state — hygiene ratchet back at its untouched 795 budget, no
mutation score dropped (notes +0.44). Root integration: four
`engineRegistry` rows (triage, search, pendingOverlay, selection) gained
their `mutationSeed` column; the split files joined the seeds' watch lists;
agenda's mutate set widened to `format.ts` once W3-C's suite existed
(re-measured 79.30 against the unchanged 74 floor).

### Wave 3 — prove the joins (landed so far)

**W3-A — grant verbs in the seeded commons simulator (G1, G2, G3).** The
mulberry32 simulator gains a grant plane: ten new actions against real
product code — `createShareGrant` (+ idempotent replay), `fulfillShareGrant`,
origin edits, audience tampering, binding churn, `revokeShareGrant`
(+ replay → already-revoked), `propagateShareGrantRevocation`, real parking
via a `requires_confirmation` command through `gateway.invoke`, settlement
via `gateway.confirm` through the `gateway.ts:1579` branch, and
consent-grant revocation sweeping parked payloads. One new long seed
(839_001: 320 actions, four seats, grant verbs ~37% of steps) per the
lengthen-don't-multiply budget doctrine; existing seeds draw byte-identical
programs. Invariants: revocation severs (fulfillment refuses revoked grants
at every reach), parked payloads settle and never unpark, the fulfillment
state machine takes only legal transitions, and the G-view projection
doctrine (the audience holds exactly the origin's album, tampering healed
and counted non-vacuously, exactly one origin row). Determinism proven
in-process and across processes. **Product defect found — D1, a
revocation-severance hole (`fulfillment.ts:315-334`/`:420-435`): an
unreachable-seat pass overwrites a `delivered` row with `syncing`, and
propagation then reads syncing as never-delivered and settles `removed`
while deleting nothing — the owner's vault reports removed, the audience
keeps the whole projection forever.** Pinned as a `test.fails` case that
turns red the day the defect is fixed, plus a precondition-scoped pin in the
random schedule; any severance breach outside that exact precondition stays
a hard failure. docs/decisions.md's "best-effort, hard delete" G-revoke
ruling gets its supersession note in the Wave 5 docs pass.

**W3-B — protocol join lane + version-skew wall (G11, G12).**
`packages/server/src/serve/protocol-join-lane.test.ts`: one `serve()`
daemon, N mounted vaults, one iroh tunnel client per seat (its own
EndpointId, its own enrolled owner), every assertion over real QUIC. Four
laws: a grant crosses mounted vaults and only the addressed seat receives it
(bystanders empty, cross-vault reads refused `vault_not_enrolled`, three
concurrent share gestures mint exactly one grant); revocation severs rather
than pauses (a later edit reaches a newly-added seat while the severed seat
stays empty, and removal takes both the document and content-item
projections to zero); a parked payload survives a transport reconnect, then
settles once and never unparks (denied stays denied on an approve-retry,
task count unchanged); and the update wall — judging every synthetic
protocol version 0…N+2 against the live gateway yields exactly one accepted
point, the documented refusal string verbatim on both sides, no fallback
mode, with min==current pinned so a window widening must be deliberate.
Nightly home: own `protocol-join` job at `CENTRAID_JOIN_SEATS=5` (the PR
path runs the same file at its 3-seat floor), artifact
`nightly-evidence-join`, enforced by validate-nightly-wiring with an
eight-perturbation bite proof. The flagged `gateway.ts:1579` crash window
came back clean on the reachable path — `readDurableParkedDenial` replays
the journal receipt, pinned with the file:line named; a true kill in the
journal-to-settlement gap needs the kill harness (#842 W1 territory).
`buildTestGateway` was evaluated and not adopted (listener-free, so
unreachable by tunnel; still zero callers — retirement candidate for the
docs pass). Root integration: `test:join` alias in package.json;
`fuzz-parsers` added to the nightly-failure-issue needs for consistency
with `protocol-join`; the two Maestro suites joined
`requiredFlowScripts` (a committed roster e2e.yml never invokes must fail
the gate); artifact-name matching boundary-anchored so a superstring
rename can no longer pass.

**W3-C — time zoo (G12).** 113 tests across five files, all under the fake
clock with zone bands read off the runtime's own tzdata, never assumed:
`packages/server/src/automation/fire/time-zoo-cron.test.ts` and
`time-zoo-calendar.test.ts` (cron/cursor DST gap-skips and overlap-fires-once
per docs/cron-timezone.md, leap day including the Gregorian century rule, ISO
week-53 via window tiling), `packages/core/src/time/time-zoo-recurrence.test.ts`
and `time-zoo-zone-crossing.test.ts` (recurrence DST laws, leap-day clamping,
and zone-crossing collapse: cutting a range at viewer-zone midnights or at 24
seeded arbitrary instants reproduces the whole-range series exactly, from
viewer zones including +05:45 and Chatham +12:45-with-DST), and
`packages/blueprints/apps/agenda/format-locale.test.ts` (the host-locale
surface pinned under named locales — en-US 12-hour vs en-GB/de-DE/ja-JP
24-hour, NNBSP-normalised so pins are about locale decisions, not ICU
versions). The zoo spans America/New_York, Europe/Dublin (negative DST),
Australia/Lord_Howe (30-minute shift), and a fixed-offset control. The one
product edit: agenda `format.ts` formatters gained an optional trailing
`locale?: Intl.LocalesArgument` defaulting to today's exact behaviour (12
call sites verified single-arg; `f(x) === f(x, undefined)` pinned). **Product
defect found and pinned, not fixed:** a continuously-running gateway fires a
cron automation TWICE across a DST fall-back — the wall-clock dedupe in
`cron-cursor.ts:61` is call-local and the persisted cursor stores only a ms
position, so the two absolute minutes sharing one wall clock land in separate
one-minute tick windows; docs/cron-timezone.md:36 says once. Pinned in
`time-zoo-cron.test.ts` with the defect named against #839; the recurrence
side obeys the doctrine exactly everywhere.

### Wave 4 — own the devices (landed so far)

**W4-A — Maestro roster + device-only claims (G8).** Five new home-journey
flows in `tests/agent-e2e-mobile/flows/` — `docs-drive` (pop-not-push
navigation proven via `assertNotVisible`), `agenda-week` (Day→Schedule
read-window widening), `notes-library` (the row/body two-read join),
`tasks-board` (attention grouping + nested subtask under its dated parent),
`locker-gate` (withheld Home count and the refusing gate re-asserted across a
real process restart; Locker ships no seed by design, so the grid is seeded
via docs) — plus `run-home-apps-suite.mjs` (one fresh pairing, four
paired-state reuses, 10-minute first-land ceiling recorded in
`flows/home-apps-budget.md` with a tighten-only instruction). Every asserted
string is verified against `apps/mobile` source (selector evidence in the
slice report); no tally flow (held, #831). All five registered in
`scripts/lint-e2e-flows.mjs` (7→12 files, 66→101 steps) and dry-validated by
executing each flow against a stub harness that YAML-parses every emitted
chunk and rejects unknown Maestro commands — a rig proven non-vacuous by
sabotage. On-device demonstration is pending the first CI run. README gains
"The committed roster" and "Device-only claims" — the latter written so each
row drops into the matrix verbatim in Wave 5, and naming the device-only
gaps nothing owns yet (granted/limited camera-roll permission, share sheet
both directions, biometrics — Maestro has no iOS biometric control —
notification delivery). **Pre-existing break found and repaired at the root:
`HOME_READY_MARKER` asserted "Home ready", a label #789 deleted when
HomeStatusLine's copy became the dynamic origin-health sentence — every
pairing flow was waiting on a string the app no longer renders. Repointed to
the Home band's stable accessibility label with the caveat recorded that it
is a render signal, not a settled signal.** Confirmed stale (reported, not
fixed, pre-existing): 7 of 9 surface markers in `native-v0-resilience.mjs`
have zero source hits post-#789/#831, and the unregistered
`photos-permissions.mjs` carries a vacuous bare-"Home" assertion the linter
would catch if the six photos flows were registered — both queued for the
dormant-gate re-arm pass (#842 W0).

### Wave 5 — close the contract (landed so far)

**W5-B — grid wiring.** Grid B: the five Wave 4 device flows promoted to
owners of the agenda/docs/notes/tasks/locker origin cells (11 owned / 9
tracked gaps / 4 skips; every gap carries the open umbrella). Grid D
deliberately unchanged: locker.denied and photos.denied are already owned by
default-CI app-boot suites, and a cell has one owner — swapping in a
nightly-only device flow would trade proof away, not add it. Three new
registered flows — `enrich-policy-cascade-properties` (16 properties),
`manifest-scope-denial-sweep` (18 declared sites expanding to ~90 cases; the
floor is the static count the validator sees), `commons-grant-plane-simulation`
(the scope-commons precedent extended to the grant plane) — filling
policy-cascade, refusal-grammar, and sharing-grants `propertyFlow` columns.
`consent` stays null honestly (its second source file is untouched by the
sweep; one flow never serves two rows). Root additions on top:
`recurrence-properties` registered (14 fast-check properties that existed
unregistered in `packages/core/src/time/`) filling `recurrence.propertyFlow`
— adversary columns now 8 of 19 — and the mutation seed-census unit test
(`scripts/mutation/run.test.mjs`) updated to the 24-seed truth with a
config-name pattern admitting hyphenated seeds.

**W5-D — docs pass.** TESTING.md absorbs the new machinery as current state:
the 24-seed mutation census, new sections for the non-engine seeds (with the
jsdom-Stryker limitation and the provisional-local floor doctrine), the fuzz
lane (why replay is nightly-only: five of six targets import built dist),
the protocol join lane and its four laws, the time zoo, and the home-app
device journeys; the `buildTestGateway` drift corrected to disk truth
(listener-free, zero callers, retirement candidate). docs/decisions.md gains
the dated ruling block "Adversary lanes and provisional evidence (#839)" —
A-floors (the provisional-local exception and why it is pessimistic),
A-replay (the nightly placement of the crasher lock), A-held (`held` as a
first-class cell status citing the closed ruling that held it), A-pinned
(the pin doctrine, enumerating the standing pins) — and the G-revoke ruling
is qualified in place by defect D1, not superseded. docs/cron-timezone.md
gains a known-divergence note under DST policy (the law stands; the
double-fire pin flips when fixed). docs/glossary.md gains the adversary-lane
vocabulary (fuzz lane, join lane, time zoo, device-only claim,
provisional-local floor, pin, grant plane).

**W5-A — report v2.** The nightly report opens with a briefing: a verdict
strip (`shippable | degraded | red | no-evidence`, graded from the same cell
states the detail shelf renders, with delta vs the last durable night), an
attention queue ranked S1–S4 from the matrix's own `assessment` axis (a
`solid` cell going red outranks everything; pinned fuzz findings rank S4;
"newly" is gated on non-empty history so a first run cannot fake 135
regressions), and the missing grids: E (join laws — 4 scripted from the
protocol join lane + 5 simulation from the commons sim), F (adversary panel —
24 mutation seeds × floors, 6 fuzz targets × corpus/crashers/known-findings,
propertyFlow column showing 8 owned / 11 engines honestly holeless), G
(journeys — 3 suites / 16 flows with budget-vs-enforced pinned to each
runner's `BUDGET_MS`), and the consent-ledger render. New matrix blocks
`joinLaws[9]` and `journeys` are derivation-locked by
`validate-report-registries.mjs` (a law's `testName` must exist in its owner
and the owner's `test(` count must equal the laws claimed; suite flow lists
must equal each runner's `FLOWS` and their union must equal the flows
directory on disk; budgets must equal the runners'). `historyPoint` extends
additively (`verdict`, `appSeatCells`, `appStateCells`, `adversaryCounts`).
S1/S2 entries flow into `summary.attentionQueue` and the existing
auto-filed nightly issue via `report-cell-delta.mjs`. Root verified: report
unit suite 28 files / 422 tests (was 23/338, none lost), validate-matrix and
smoke green, and the budget-drift lock replicated red-then-green by hand.
Six journeys run outside any aggregate budget and render as a visible
`standalone` gap; `report-cell-delta.mjs` still has no unit test (debt for
the final pass).

**W5-C — RTL+CJK gallery fidelity lane.** `design:gallery` now renders the
same `#ui-preview` surface under `dir="rtl"`/`lang="ar"` and again with the
copy swapped to Japanese, and judges invariants rather than pixels
(`scripts/design-gallery-fidelity.mjs`, 34 paired pass/sabotage unit tests
wired into `scripts:test`): asymmetric boxes must mirror, no computed
physical `text-align`, the numeric register must carry its `direction:
ltr`/`unicode-bidi: isolate` pair, a layout container must not carry it, a
live bidi probe proves the isolate is what holds a date in calendar order
(the un-isolated control, under Arabic pressure, demonstrably flips), CJK
copy must reach the one sans stack with its mandatory fallbacks, and no
type triple may move between renders. Root integration fixed the slice's
browser-blind spot: Chromium's UA stylesheet computes `unicode-bidi:
isolate` on every plain block element, so the register is identified by the
isolate+pinned-ltr **pair** (container judge, ancestor cover, probe source
picker), and a bare hyphenated ASCII date has no reordering pressure even
in an RTL paragraph (UAX#9 W4), so the probe's control carries the Arabic
word while the isolated clone carries the register's honest date-only
content. The lane ran green in a real browser after fixing its two real
findings in `packages/client/src/react/ui/AppCard.module.css` (`text-align:
left` → `start`; `.iconDot` `right: -3px` → `inset-inline-end`) — both
were demonstrated red first. Not registered in docs/design-divergences.md:
that register is for sanctioned departures, and these were defects.
Recorded for the bug-issue pass (outside the gallery's rendered surface, so
the lane cannot see them): six numeric-register leaves missing the
direction/bidi pair (`states.module.css` `.workingCounts`/`.versionAt`/
`.outOfRoomFigures`, `GridBlock.module.css` `.badge`/`.absent`/`.sealed`),
AppCard's rows-layout physical rules (`:341,346,357` under
`[data-layout="rows"]`), and `PanelBlock.module.css`'s block-level
`.factNote` inside a mono fact.

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
- **The fuzz replay lock runs nightly, not on the PR path.** The crasher
  replay suite imports built dist artifacts, which the PR gate list does not
  guarantee; it runs in the `fuzz-parsers` nightly job (`if: always()`)
  beside the hunt itself. Same posture as mutation floors: adversarial
  regression locks live in the nightly lane, and validate-nightly-wiring
  makes their presence structural.

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
