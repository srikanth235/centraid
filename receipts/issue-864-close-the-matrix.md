<!-- governance: allow-repo-hygiene file-size-limit #864 one umbrella receipt, wave-by-wave; splitting it would scatter the single audit trail -->
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

### Wave 2 (landed, partial — extension journeys deferred)

- [x] Add the consent engine property flow with six named laws
- [x] Add the untrusted-rendering property flow and its measured mutation seed
- [x] Give the app-scope-manifests consent layer a hostile-manifest adversary

### Wave 7 (landed)

- [x] Author `docs/apps/{agenda,tasks,notes,people}-scenarios.md` (Photos/Docs exist); promote all six to matrix scenario blocks
- [x] Add the per-app scenario grid to the report generator; extend the zero-grey contract to it
- [x] Triage M18: seed every drill defect as a product-bug cell (inline fixes follow under this umbrella; no child issues)

### Wave M18 S1 (landed)

- [x] Write the failing test first at the cheapest falsifying layer, then fix the S1 product bugs
- [x] Flip each repaired scenario-ledger cell from product-bug to owned

### Wave M18 S2 (landed)

- [x] Fix the cheap S2 wrong-display bugs with a failing test first
- [x] Flip each repaired S2 scenario-ledger cell from product-bug to owned

### Wave 3 (landed, remainder closed the happy-path-only holes)

- [x] Add crash/reopen durability tests for app-engine and automations
- [x] Add adversarial-input tests for automations lint and mobile transfer-policy
- [x] Correct the stale pwa-waterfall honesty note (CI already throws)
- [x] Rewrite remaining M6–M11 notes that overclaimed "happy path only"; add cheapest durability/adversary proofs beside existing owners

### Wave 4 (landed, remainder closed the happy-path-only holes)

- [x] Add a two-actor claimNext interleaving on the mobile intent store
- [x] Add a pre-multi-vault gateway reply version-skew fixture on web host
- [x] Add exclusive two-device lease claims and concurrent handler-pool dispatch

### Wave 5

- [x] Explicitly deferred: the 18 skip sites still wait on named rigs (disk-full, launchd, Clawgnition interop); standing those up is out of this PR's machine budget. No Maestro flows added in this remainder.

## Waves

| wave | subject | state |
| --- | --- | --- |
| W0 | re-home closed-issue citations to #864; add the open-citation gate | landed |
| W1 | own the app-axis state and seat cells; leave nine as product-surface gaps | landed |
| W6 | recolor the report to one hue one meaning; invert the collision guardrail | landed |
| W2 | consent + untrusted property flows, mutation seed, hostile-manifest adversary | landed (extension journeys deferred) |
| W7 | per-app scenario ledger + report grid; M18 seeded as product-bug | landed |
| M18 S1 | fix data-loss / consent / false-promise bugs; flip product-bug → owned | landed |
| M18 S2 | cheap wrong-display bugs; flip product-bug → owned | landed |
| W3 | durability crash/reopen + adversarial lint/transfer; remaining notes honest | landed |
| W4 | claimNext + pairing skew + exclusive leases + concurrent handler-pool | landed |
| W5 | named rigs (disk-full, launchd, …) | deferred (explicit; no machines stood up) |

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

### W2 — the adversary panel gains three owners it was missing

Wave 2 raised author-blind adversaries against the engines the §7 panel showed
`unowned` (M4) and the one consent layer with no adversary (M5). Three of the
eleven property-flow-less engines are now owned; the extension journeys (M3) and
the remaining engines are deferred to a later batch.

`packages/vault/src/gateway/consent-properties.test.ts` is a node property suite
over identity × grants × policies × clamp, and this did **add the consent engine
property flow with six named laws**: consent-denial-monotone, clamp-order-
independent, clamp-only-narrows, reveal-never-rides, explicit-scope-unbypassable
and onbehalf-cap-precedes-grants — all held (the order-independence law is
correctly stated as a set invariant, since clause order is deliberate and
already pinned elsewhere). The engineRegistry `consent.propertyFlow` now names it.

`packages/blueprints/apps/_shared/untrusted-properties.test.ts` is a node suite
that also unlocks the mutation seed the jsdom suite could never back — this did
**add the untrusted-rendering property flow and its measured mutation seed**:
four laws (display-total, url-allowlist-closed, media-subsumed-by-document,
background-image-unescapable), a new seed `packages/blueprints/apps/_shared/untrusted`
wired through `packages/blueprints/stryker.untrusted.config.mjs`,
`packages/blueprints/vitest.untrusted.mutation.config.ts` and
`scripts/mutation/seeds.mjs`, and a floor of 84 in `tests/mutation-floors.json`
(local Stryker measured 95.14%, floor = measured − 11 per the #839 provisional
precedent; `_w864Comment` records the obligation to re-seed to CI−3 on the first
green nightly, and the "deliberately not seeded" clause was deleted). Two `it.fails`
pin genuine latent boundaries in `untrusted.ts` (the vault-blob/`data:` sink arms
don't scrub control units; a raw newline in a `data:` body breaks CSS `url()`
token integrity) — self-correcting characterizations, not injections today.

`packages/server/src/serve/manifest-scope-denial.hostile.test.ts` drives
synthetic attacker-authored manifests through the real validators — this did
**give the app-scope-manifests consent layer a hostile-manifest adversary**: case/
NFKC/whitespace/`__proto__` name variants and a 10 000-scope list deny as
`manifest-undeclared` inside the six DENY_CLASSES, and the automation validator
rejects a garbage `rowFilter.op` the app schema waves through. Three `test.fails`
characterize a real, unowned hole (the app manifest validator types `rowFilter.op`
as a bare string and `executionClamp` carries clause contents opaquely, so a
structurally-invalid clause reaches ALLOW and throws downstream outside the
grammar) — pinned with a filed note per the pin doctrine, the fix deferred out of
this slice. The `consentLedger[app-scope-manifests]` adversary now names the
closed-grammar owner and its note records both the landed sweep and this hostile
suite (`tests/matrix.json`).

### W7 — the report grows a per-app scenario grid, and M18 defects become cells

Wave 7 is the user's priority ask: a machine-readable per-app scenario
ledger so a write that loses data has a row that turns. This did **Author
`docs/apps/{agenda,tasks,notes,people}-scenarios.md` (Photos/Docs exist);
promote all six to matrix scenario blocks** — and, because grids B and D are
closed against the bundled apps, Locker and Tally got instances too
(`docs/apps/locker-scenarios.md`, `docs/apps/tally-scenarios.md`). Photos was
promoted out of TESTING.md into `docs/apps/photos-scenarios.md`; Docs gained
the two M18 rows the drill named. `docs/app-scenario-layer-template.md` and
`TESTING.md` now point at the eight instances and at
`tests/matrix.json#appScenarios`.

This did **Add the per-app scenario grid to the report generator; extend the
zero-grey contract to it**. `scripts/test-report/app-scenario-grid.mjs` builds
one heat table per app (columns U / C / E; the cheapest layer paints, the
other two are n/a). `scripts/test-report/generate.mjs` renders it as §3b.
Owned stays the declaration grey of §2/§3, gap is the plum "no owner", and
**product bug** is a new indigo family (`--nw-bug` / `--nw-bugbg`) so a known
defect cannot share paint with a missing test. The zero-grey extension is
"this grid never paints an absence grey" — asserted by
`scripts/test-report/generate-app-scenarios.test.mjs` and
`scenarioGridIsZeroGrey` — and `summary.appScenarioCells` is counted
separately from `cellsMissing`, the same way the seat/state grids are.
`scripts/test-report/smoke.mjs` pins the legend chip and the section title.
`scripts/test-report/generate-briefing.test.mjs` pins the Night Watch running
order with `scenarios` between `states` and `consent`.

`scripts/test-report/validate-app-scenarios.mjs` (called from
`scripts/test-report/validate-app-axes.mjs`) closes the ledger: bundled apps
exactly, layers exactly U/C/E, owned owners exist on disk, gaps and
product-bugs cite an open issue, product-bugs carry a note, held/skip cite a
registered ruling. Fixtures:
`scripts/test-report/matrix-fixture.mjs`,
`scripts/test-report/report-fixture-root.mjs`,
`scripts/test-report/generate-nightly-semantics.test.mjs`.
Tests: `scripts/test-report/validate-app-scenarios.test.mjs`,
`scripts/test-report/generate-app-scenarios.test.mjs`,
`scripts/test-report/report-theme.test.mjs` (the eighth family is in
REGISTER and SEMANTIC_STATES).

The eighth family is emitted from `scripts/site-tokens.mjs` into
`scripts/test-report/report-tokens.css` and consumed by
`scripts/test-report/report-theme.mjs`. Current-state docs:
`docs/decisions.md`, `docs/design-divergences.md`.

This did **Triage M18: seed every drill defect as a product-bug cell (inline
fixes follow under this umbrella; no child issues)**. The user approved
inline S1 fixes under #864; Wave 7 does not fix them — it makes each one a
cell that must flip `product-bug → owned` when the failing test and the
repair land. 73 scenario rows: owned proofs where they already existed,
product-bug for every M18 S1 and the cheap-to-name S2s, Tally held with
#831.

`scripts/mutation/run.test.mjs` was one line behind Wave 2: the untrusted
seed was on disk and floored, but the catalog pin omitted
`packages/blueprints/apps/_shared/untrusted`. The pin now lists it.

### M18 S1 — the drill's data-loss bugs get a failing test, then a fix

This did **Write the failing test first at the cheapest falsifying layer, then
fix the S1 product bugs**. Eighteen scenario rows. Notes: Pin/tag/attach no
longer empty the body (`editor-keep-body.test.tsx`); keyed save flush on
note-switch (`logic-commands.test.ts`); the concurrent-pair panel can restore
(`logic.test.ts`). Docs: title-only dispatches `rename` without `body_text`
(`editor-write.test.ts`); export names cannot traverse
(`docs-export.test.ts`). People: grace-lapse purge deletes party / identifiers
/ tags / channels (`duties.test.ts`); merge folds cadence / last-contacted /
colour (`merge.test.ts`). Photos: drop completeness over `dataTransfer.items`
(`upload.test.ts`); free-up pin join against folded ids
(`photos-library-pins.test.ts`). Tasks: unfinished children of a completed
parent stay on the board (`logic.test.ts`); sitting "Release all" cancels
instead of stamping Today (`logic.test.ts`); HOUSE writes forward `scopeId`
(`writes.test.ts`); delete confirm removes rather than cancelling
(`writes.test.ts`). Agenda: rrule expansion per occurrence
(`due-reminders.test.ts`); `start_tz` on create/edit (`format-locale.test.ts`);
refused create keeps the draft (`states.test.tsx`); all-day civil dates
(`format-locale.test.ts`); occurrence edit keeps eight fields
(`edits.test.ts`).

This did **Flip each repaired scenario-ledger cell from product-bug to owned**
in `tests/matrix.json#appScenarios` (18 cells). S2 rows were still
`product-bug` at this checkpoint and flipped in the S2 section below.

### M18 S2 — silently-wrong-display, cheapest layer first

This did **Fix the cheap S2 wrong-display bugs with a failing test first**:
Notes `promote()` names a stored "Untitled note" from the first line
(`format.test.ts`); Tasks chips follow Todoist and `dayKey()` is the member's
civil day (`format.test.ts`); Agenda `bucketByDay()` emits every spanned local
day (`views.test.ts`); People overdue is `daysSince > cadence`, leap-day
clamps to 28 Feb, month_day schema refuses impossible dates, roster window
9999 with a named remaining count (`format.test.ts`,
`people-dates.test.ts`, `people-roster.test.ts`); Photos Archive/Unarchive
copy is shared (`archive-copy.test.ts`).

This did **Flip each repaired S2 scenario-ledger cell from product-bug to
owned** (9 cells). Remaining product-bug: none in the six-app S2 list.

### W3 — durability crash/reopen and adversarial inputs

This did **Add crash/reopen durability tests for app-engine and automations**
(`archive.contract.test.ts`, `scheduler-ledger.contract.test.ts`), **Add
adversarial-input tests for automations lint and mobile transfer-policy**
(`lint.test.ts`, `transfer-policy.test.ts`), and **Correct the stale
pwa-waterfall honesty note (CI already throws)**. Remaining M6/M7 surfaces
still happy-path only (vault-core, replica-sync, gateway, blob-custody, …).

### W4 — one interleaving and one version-skew fixture

This did **Add a two-actor claimNext interleaving on the mobile intent store**
and **Add a pre-multi-vault gateway reply version-skew fixture on web host**.
Remaining concurrency/compat cells still happy-path.

### W3/W4 remainder — remaining M6–M11 notes stop overclaiming

This did **Rewrite remaining M6–M11 notes that overclaimed "happy path
only"; add cheapest durability/adversary proofs beside existing owners**.
The leftover cells either gained a cheapest falsifying test next to the
existing owner, or the note now names what the owner actually proves and
what is still open under #864 (scale second volume, perf longitudinal
drift, cross-surface journeys, two-process fire, file-backed replica
reopen, named-rig gateway crash).

This did **Add exclusive two-device lease claims and concurrent
handler-pool dispatch**.

New tests this remainder:

- `packages/vault/src/enrich/leases.test.ts` — two poster jobs claimed by
  two devices never share a `requestId`
- `packages/server/src/engine/handlers/handler-pool.test.ts` — two
  concurrent dispatches both complete
- `packages/server/src/serve/disk-health.test.ts` — a replacement probe
  still names ENOSPC after the previous health loop is dropped
- **Mobile origin seat (primary):** `apps/mobile/src/apps/agenda/agenda-days.ts`
  and `apps/mobile/src/apps/agenda/agenda-days.test.ts` — a Friday–Sunday
  run occupies every local day on the native list, not only the start day.
  `apps/mobile/src/apps/agenda/AgendaHome.tsx` groups replica occurrences
  itself via the shared `spanLocalDays` arithmetic. The phone does not
  render `packages/blueprints` components.
- `apps/mobile/src/apps/people/INTEGRATION-NOTES.md` — overdue is
  `daysSinceContact > cadence`, matching the shared `format.ts` rule.

**Maestro.** Wave 1 added exactly one flow:
`tests/agent-e2e-mobile/flows/people-roster.mjs` (People origin seat,
cadence join on device). Other Maestro files (`agenda-week`,
`notes-library`, `tasks-board`, Photos suite, …) pre-existed #864. This
remainder adds none: a multi-day overnight is not in the agenda demo seed,
so the cheapest falsifying layer is the native grouping function.

Desktop e2e empty-canvas and photos replica waits raised 30s → 60s so the
custodian seat specs wait as long as the write-rail probe (CI
`client-e2e / desktop-e2e` and `desktop-e2e-macos` were timing out the
empty copy / replica probe).

**No additional Maestro flows.** The only Maestro file this umbrella added
is Wave 1's `tests/agent-e2e-mobile/flows/people-roster.mjs`.

### W5 — deferred

This did **Explicitly deferred: the 18 skip sites still wait on named rigs
(disk-full, launchd, Clawgnition interop); standing those up is out of
this PR's machine budget. No Maestro flows added in this remainder.**
Named-rig skips stay inventoried under #864. This PR does not stand up
those machines. The deferral is the close of Wave 5 for this umbrella,
not a silent "owned".

### CI ratchets for this branch

`tests/quality/classification-ratchet.json` re-pins the `tests/matrix.json`
whole-file fingerprint (governed qualities payload unchanged). The previous
tip's pin lagged the file bytes after oxfmt, which is why `gates` /
`lint:quality-knobs` failed on PR 866. This remainder re-pins to the
current bytes. `apps/mobile/native-fingerprints.json` L4 iOS identity only
(L1–L3 green; JS under `apps/mobile/src` moved the Expo fingerprint).
`packages/blueprints/manifest.json` lists the S1/S2 files (covers the
earlier manifest-only commit that CI rejected for not touching the receipt).

Desktop e2e empty-canvas / photos replica waits on the Wave 1 custodian
specs raised 30s → 60s to match the write-rail probe. If those jobs stay
red after this, the failure is past the replica probe (empty canvas never
paints) and belongs in the PR body, not a hidden skip.

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
- **tests/matrix.json whole-file fingerprint is re-pinned by #864 because Wave 7 added the appScenarios ledger and M18 flipped product-bug cells to owned. No quality lost a gate, no gate lost its evidence, no classification was weakened, and the remaining governed fingerprints are unmoved.**
- **A declared product defect is not a missing test.** Wave 7 adds an eighth
  Night Watch family (`bug`, indigo) rather than painting product-bug with
  either the gap plum or the failed red. Gap is Q1 "no owner"; failed is Q2
  "tonight's run went wrong"; product-bug is Q1 "the product is known-broken".
  Sharing either tint would flatten those questions the way Wave 6 just
  un-flattened them.
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

## User impact

A Friday–Sunday Agenda run now paints Saturday on the phone's origin seat,
not only the start day. Desktop/web already walked `spanLocalDays`; the
native list now uses the same interval.

First-run: after founding a Personal vault and opening Agenda, compose a
timed event and it lands as a schedule row. Evidence:
`artifacts/e2e/ui-impact/desktop-agenda-custodian.png`, emitted by
`apps/desktop/tests/e2e/agenda.spec.ts`.

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

### Wave 7 verification

A reviewer can re-run the Wave 7 gates directly; all are package-filtered,
never the full suite:

```sh
bun run test:matrix
bunx vitest run --config scripts/test-report/vitest.config.ts \
  generate-app-scenarios validate-app-scenarios report-theme \
  generate-app-grids generate-briefing generate-nightly-semantics \
  validate-matrix-app-axes
bun run lint:site-tokens
```

Checklist crosswalk — this change did **Author
`docs/apps/{agenda,tasks,notes,people}-scenarios.md` (Photos/Docs exist);
promote all six to matrix scenario blocks** (plus locker and tally for the
closed app axis), did **Add the per-app scenario grid to the report
generator; extend the zero-grey contract to it** (no absence grey on §3b;
product-bug indigo distinct from gap plum), and did **Triage M18: seed every
drill defect as a product-bug cell (inline fixes follow under this umbrella;
no child issues)**.

Staged paths named above: `tests/matrix.json`;
`docs/apps/agenda-scenarios.md`, `docs/apps/tasks-scenarios.md`,
`docs/apps/notes-scenarios.md`, `docs/apps/people-scenarios.md`,
`docs/apps/photos-scenarios.md`, `docs/apps/docs-scenarios.md`,
`docs/apps/locker-scenarios.md`, `docs/apps/tally-scenarios.md`;
`docs/app-scenario-layer-template.md`; `TESTING.md`; `docs/decisions.md`;
`docs/design-divergences.md`; `scripts/test-report/app-scenario-grid.mjs`;
`scripts/test-report/validate-app-scenarios.mjs`;
`scripts/test-report/validate-app-scenarios.test.mjs`;
`scripts/test-report/generate-app-scenarios.test.mjs`;
`scripts/test-report/validate-app-axes.mjs`;
`scripts/test-report/generate.mjs`; `scripts/test-report/report-theme.mjs`;
`scripts/test-report/report-theme.test.mjs`;
`scripts/test-report/report-tokens.css`; `scripts/site-tokens.mjs`;
`scripts/test-report/smoke.mjs`;
`scripts/test-report/generate-briefing.test.mjs`;
`scripts/test-report/generate-nightly-semantics.test.mjs`;
`scripts/test-report/matrix-fixture.mjs`;
`scripts/test-report/report-fixture-root.mjs`;
`scripts/mutation/run.test.mjs`;
`receipts/issue-864-close-the-matrix.md`.

Recorded results:

| command | result |
| --- | --- |
| `bun run test:matrix` | PASS — 15 surfaces × 11 dimensions, 166 canonical flows |
| Wave 7 vitest files above | PASS |
| `bun run lint:site-tokens` | PASS — home + docs + the report match |

**No gate, budget, floor, allowlist or test was weakened.** The eighth family
is additive; `cellsMissing` is untouched by the scenario grid.

### Wave M18 S1 verification

A reviewer can re-run the S1 owner tests directly; package-filtered, never
the full suite:

```sh
bun run test:matrix
bunx vitest run \
  apps/mobile/src/apps/docs/editor-write.test.ts \
  apps/mobile/src/apps/docs/docs-export.test.ts \
  packages/vault/src/gateway/duties.test.ts \
  packages/vault/src/commands/merge.test.ts \
  packages/blueprints/apps/tasks/logic.test.ts \
  packages/blueprints/apps/tasks/writes.test.ts \
  packages/blueprints/apps/photos/upload.test.ts \
  apps/mobile/src/apps/photos/photos-library-pins.test.ts \
  packages/blueprints/apps/notes/editor-keep-body.test.tsx \
  packages/blueprints/apps/notes/logic-commands.test.ts \
  packages/blueprints/apps/notes/logic.test.ts \
  packages/blueprints/apps/notes/draft-writes.test.ts \
  packages/server/src/reminders/due-reminders.test.ts \
  packages/blueprints/apps/agenda/format-locale.test.ts \
  packages/blueprints/apps/agenda/states.test.tsx \
  packages/blueprints/apps/agenda/edits.test.ts \
  packages/blueprints/apps/agenda/views.test.ts
```

Checklist crosswalk — this change did **Write the failing test first at the
cheapest falsifying layer, then fix the S1 product bugs** (268 tests green
across the owner files) and did **Flip each repaired scenario-ledger cell
from product-bug to owned** (18 cells in `tests/matrix.json`).

S2 remaining as `product-bug` (reason in Out-of-scope / this section): untitled
web note; People overdue / leap-day / month_day / 200-row cap; Photos hide vs
archive; Tasks priority scale / UTC Today; Agenda multi-day visibility.

Staged paths: `tests/matrix.json`;
`receipts/issue-864-close-the-matrix.md`;
`docs/apps/agenda-scenarios.md`, `docs/apps/docs-scenarios.md`,
`docs/apps/notes-scenarios.md`, `docs/apps/people-scenarios.md`,
`docs/apps/photos-scenarios.md`, `docs/apps/tasks-scenarios.md`;
`apps/mobile/src/apps/docs/DocumentEditor.tsx`,
`apps/mobile/src/apps/docs/INTEGRATION-NOTES.md`,
`apps/mobile/src/apps/docs/docs-export.ts`,
`apps/mobile/src/apps/docs/docs-export-name.ts`,
`apps/mobile/src/apps/docs/docs-export.test.ts`,
`apps/mobile/src/apps/docs/editor-write.ts`,
`apps/mobile/src/apps/docs/editor-write.test.ts`;
`apps/mobile/src/apps/people/MergeView.tsx`;
`apps/mobile/src/apps/photos/PhotosLibrary.tsx`,
`apps/mobile/src/apps/photos/timeline-model.ts`,
`apps/mobile/src/apps/photos/timeline-model.test.ts`,
`apps/mobile/src/apps/photos/photos-library-pins.ts`,
`apps/mobile/src/apps/photos/photos-library-pins.test.ts`;
`apps/mobile/src/apps/tasks/TasksHome.tsx`,
`apps/mobile/src/apps/tasks/useTasks.ts`;
`apps/mobile/src/apps/agenda/AgendaCreateModal.tsx`,
`apps/mobile/src/apps/agenda/AgendaEventEditor.tsx`,
`apps/mobile/src/apps/agenda/useAgenda.ts`;
`apps/mobile/src/kit/schedule/recurrence.ts`,
`apps/mobile/src/kit/schedule/recurrence.test.ts`;
`apps/mobile/src/kit/storage/free-up-space.ts`,
`apps/mobile/src/kit/storage/free-up-space.test.ts`;
`packages/blueprints/apps/notes/app-root.tsx`,
`packages/blueprints/apps/notes/components/Editor.tsx`,
`packages/blueprints/apps/notes/logic.ts`,
`packages/blueprints/apps/notes/logic.test.ts`,
`packages/blueprints/apps/notes/logic-commands.test.ts`,
`packages/blueprints/apps/notes/draft-writes.ts`,
`packages/blueprints/apps/notes/draft-writes.test.ts`,
`packages/blueprints/apps/notes/editor-keep-body.test.tsx`;
`packages/blueprints/apps/docs` (scenario doc only);
`packages/blueprints/apps/people/app-root.tsx`,
`packages/blueprints/apps/people/components/MergeRoute.tsx`;
`packages/blueprints/apps/photos/upload.ts`,
`packages/blueprints/apps/photos/upload.test.ts`,
`packages/blueprints/apps/photos/import-drop.ts`;
`packages/blueprints/apps/tasks/app-root.tsx`,
`packages/blueprints/apps/tasks/app.json`,
`packages/blueprints/apps/tasks/logic.ts`,
`packages/blueprints/apps/tasks/logic.test.ts`,
`packages/blueprints/apps/tasks/when.ts`,
`packages/blueprints/apps/tasks/writes.ts`,
`packages/blueprints/apps/tasks/writes.test.ts`,
`packages/blueprints/apps/tasks/actions/delete.ts`,
`packages/blueprints/apps/tasks/pending-projection.ts`,
`packages/blueprints/apps/tasks/queries/board.ts`;
`packages/blueprints/apps/agenda/app-root.tsx`,
`packages/blueprints/apps/agenda/components/EventEditor.tsx`,
`packages/blueprints/apps/agenda/edits.ts`,
`packages/blueprints/apps/agenda/edits.test.ts`,
`packages/blueprints/apps/agenda/format.ts`,
`packages/blueprints/apps/agenda/format-locale.test.ts`,
`packages/blueprints/apps/agenda/queries/upcoming.ts`,
`packages/blueprints/apps/agenda/states.test.tsx`,
`packages/blueprints/apps/agenda/types.ts`,
`packages/blueprints/apps/agenda/views.ts`,
`packages/blueprints/apps/agenda/views.test.ts`;
`packages/blueprints/src/handler-reachability.test.ts`;
`packages/server/src/reminders/due-reminders.ts`,
`packages/server/src/reminders/due-reminders.test.ts`;
`packages/vault/src/commands/merge.ts`,
`packages/vault/src/commands/merge.test.ts`,
`packages/vault/src/commands/schedule-organize.ts`,
`packages/vault/src/commands/schedule-organize.test.ts`,
`packages/vault/src/commands/tasks.ts`,
`packages/vault/src/commands/tasks.test.ts`,
`packages/vault/src/gateway/duties.ts`,
`packages/vault/src/gateway/duties.test.ts`,
`packages/vault/src/schema/domains-people.ts`.

Recorded results: `bun run test:matrix` PASS; the owner vitest command above PASS (268 tests / 21 files).

### Waves S2 / 3 / 4 / CI verification

```sh
bun run test:matrix
bun run lint:quality-knobs
bun run --cwd apps/mobile ci:native-state
bunx vitest run packages/blueprints/apps/notes/format.test.ts \
  packages/blueprints/apps/tasks/format.test.ts \
  packages/blueprints/apps/agenda/views.test.ts \
  packages/blueprints/apps/people/format.test.ts \
  packages/blueprints/apps/people/queries/people-roster.test.ts \
  packages/blueprints/apps/photos/archive-copy.test.ts \
  packages/vault/src/commands/people-dates.test.ts \
  packages/server/src/engine/conversation/archive/archive.contract.test.ts \
  packages/server/src/automation/fire/scheduler-ledger.contract.test.ts \
  packages/server/src/automation/handler/lint.test.ts \
  apps/mobile/src/lib/upload/transfer-policy.test.ts \
  apps/mobile/src/lib/replica/sqlite-intent-store.test.ts \
  apps/web/src/web-host.test.ts \
  packages/vault/src/enrich/leases.test.ts \
  packages/server/src/engine/handlers/handler-pool.test.ts \
  packages/server/src/serve/disk-health.test.ts \
  apps/mobile/src/apps/agenda/agenda-days.test.ts \
  apps/mobile/src/apps/people/people-model.test.ts
bun run lint:schema-export
```

This change did **Fix the cheap S2 wrong-display bugs with a failing test
first**, did **Flip each repaired S2 scenario-ledger cell from product-bug to
owned**, did **Add crash/reopen durability tests for app-engine and
automations**, did **Add adversarial-input tests for automations lint and
mobile transfer-policy**, did **Correct the stale pwa-waterfall honesty note
(CI already throws)**, did **Add a two-actor claimNext interleaving on the
mobile intent store**, and did **Add a pre-multi-vault gateway reply
version-skew fixture on web host**.

Staged paths: `apps/mobile/native-fingerprints.json`,
`apps/mobile/src/apps/people/people-model.test.ts`,
`apps/mobile/src/apps/people/people-model.ts`,
`apps/mobile/src/apps/photos/PhotoLightbox.tsx`,
`apps/mobile/src/apps/photos/PhotoStateView.tsx`,
`apps/mobile/src/apps/photos/viewer-menu.test.ts`,
`apps/mobile/src/apps/photos/viewer-menu.ts`,
`apps/mobile/src/lib/replica/sqlite-intent-store.test.ts`,
`apps/mobile/src/lib/upload/transfer-policy.test.ts`,
`apps/web/src/web-host.test.ts`,
`docs/apps/agenda-scenarios.md`, `docs/apps/notes-scenarios.md`,
`docs/apps/people-scenarios.md`, `docs/apps/photos-scenarios.md`,
`docs/apps/tasks-scenarios.md`,
`packages/blueprints/apps/agenda/components/Grid.tsx`,
`packages/blueprints/apps/agenda/types.ts`,
`packages/blueprints/apps/agenda/views.test.ts`,
`packages/blueprints/apps/agenda/views.ts`,
`packages/blueprints/apps/notes/format.test.ts`,
`packages/blueprints/apps/notes/format.ts`,
`packages/blueprints/apps/notes/logic.ts`,
`packages/blueprints/apps/people/app.json`,
`packages/blueprints/apps/people/format.test.ts`,
`packages/blueprints/apps/people/format.ts`,
`packages/blueprints/apps/people/logic.ts`,
`packages/blueprints/apps/people/people-copy.ts`,
`packages/blueprints/apps/people/queries/dashboard.ts`,
`packages/blueprints/apps/people/queries/people-roster.test.ts`,
`packages/blueprints/apps/people/queries/people.ts`,
`packages/blueprints/apps/photos/archive-copy.test.ts`,
`packages/blueprints/apps/photos/shared-copy.ts`,
`packages/blueprints/apps/photos/view-copy.ts`,
`packages/blueprints/apps/tasks/app-root.tsx`,
`packages/blueprints/apps/tasks/format.test.ts`,
`packages/blueprints/apps/tasks/format.ts`,
`packages/blueprints/apps/tasks/queries/board.ts`,
`packages/blueprints/apps/tasks/when.ts`,
`packages/blueprints/manifest.json`,
`packages/server/src/automation/fire/scheduler-ledger.contract.test.ts`,
`packages/server/src/automation/handler/lint.test.ts`,
`packages/server/src/engine/conversation/archive/archive.contract.test.ts`,
`packages/vault/src/commands/people-dates.test.ts`,
`packages/vault/src/commands/people.ts`,
`receipts/issue-864-close-the-matrix.md`, `tests/matrix.json`,
`tests/quality/classification-ratchet.json`,
`tests/schema-export-fingerprint.json`,
`packages/vault/src/gateway/portable-export.ts`,
`packages/vault/src/enrich/leases.test.ts`,
`packages/server/src/engine/handlers/handler-pool.test.ts`,
`packages/server/src/serve/disk-health.test.ts`,
`apps/mobile/src/apps/agenda/AgendaHome.tsx`,
`apps/mobile/src/apps/agenda/agenda-days.ts`,
`apps/mobile/src/apps/agenda/agenda-days.test.ts`,
`apps/mobile/src/apps/people/INTEGRATION-NOTES.md`,
`apps/desktop/tests/e2e/agenda.spec.ts`,
`apps/desktop/tests/e2e/notes.spec.ts`,
`apps/desktop/tests/e2e/people.spec.ts`,
`apps/desktop/tests/e2e/photos.spec.ts`.

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

### Wave 7 — orchestrator review

The Wave 7 author reviewed the staged diff against issue #864 Wave 7 and the
handoff. Verdicts:

1. **`## What changed` faithfully describes the diff — PASS.** The eight
   scenario docs, the `appScenarios` block, the generator/validator/theme
   files, and the eighth family are all named; 73 rows and the product-bug
   vs gap distinction reproduce from the diff.
2. **Each `- [x]` item is realized in the diff — PASS.** The three checked
   Wave 7 items map to the docs+matrix promotion, the §3b grid + zero-grey
   test, and the product-bug seeding.
3. **The `## Checklist` mirrors the issue's Wave 7 checklist — PASS.** M18
   product fixes are explicitly deferred to the next wave, matching the
   issue's "coverage that would have caught them" split, with the user's
   later instruction that those fixes land under #864 rather than child
   issues.

**Overall: SHIP.**

### Wave M18 S1 — orchestrator review

The Wave M18 S1 author reviewed the staged diff against the #864 S1 table.
Verdicts:

1. **`## What changed` faithfully describes the diff — PASS.** Eighteen
   scenario cells flip to owned; S2 remain product-bug.
2. **Each `- [x]` item is realized in the diff — PASS.** Failing tests then
   fixes, then ledger flips.
3. **The `## Checklist` mirrors the issue's M18 S1 order — PASS.** S1 before
   S2; no child issues.

**Overall: SHIP.**

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-25 | claude-code | 5b72723a-7529-5ad1-9a1b-b369d6c2972b |
