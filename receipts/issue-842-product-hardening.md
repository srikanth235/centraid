# Issue #842 — product hardening: the other mechanisms

GitHub issue: [#842](https://github.com/srikanth235/centraid/issues/842)

Umbrella issue worked by orchestration ([docs/multi-agent.md](../docs/multi-agent.md)):
one receipt, no child issues; slices are sub-agents and commit waves under this
umbrella, landing on the same branch (and the same PR) as #839 by owner
instruction. Nine workstreams W0–W8. Items whose completion depends on an
external actor (money, enrollment, third-party accounts, multi-day wall clock)
land their code side here and are recorded in the blocked-external register
below rather than being claimed done.

## Checklist

W0 — re-arm what's already built:

- [x] W0.1 `test:suite-wall-clock` wired into a lane that actually runs it
- [x] W0.2 repo-wide diff-coverage `approvedDeviation` (#639) removed
- [x] W0.3 `PendingRestartJourney.test.tsx` collects; collection-error tripwire
- [x] W0.4 photos flows in the e2e-flows roster; roster discovered, not enumerated
- [x] W0.5 `sendToFirstToken` measured and ceilinged; `projected` metrics seeded
- [x] W0.6 SonarCloud wired or claim retired; dormant-bits sweep

W1 — the bytes survive:

- [x] W1.1 Seeded crash-consistency lane over every registered fault point
- [x] W1.2 `centraid doctor` (CLI verb + surface) + scheduled scrub
- [x] W1.3 Automated restore drill (in-product + CI)
- [x] W1.4 Backup-format archaeology corpus
- [x] W1.5 Schema-migration corpus

W2 — hostile input:

- [x] W2.1 Differential guard testing (three peer path guards agree)
- [x] W2.2 Prompt-injection corpus against the agent loop (fake ACP)
- [x] W2.3 Hostile-peer protocol harness
- [x] W2.4 DAST lane (nightly)

W3 — time, network, disorder:

- [ ] W3.1 Network chaos on the tunnel plane
- [ ] W3.2 Composition-level chaos
- [ ] W3.3 Clock-skew + calendar-edge injection
- [ ] W3.4 Long-run soak rig (weekly)
- [ ] W3.5 Renderer leak testing

W4 — load and limits:

- [ ] W4.1 Composite-load rig
- [ ] W4.2 Stress-to-failure

W5 — compatibility and lifecycle:

- [x] W5.1 WebKit project in web e2e
- [x] W5.2 Windows/macOS path-gated CI jobs
- [x] W5.3 Released-binary skew lane
- [x] W5.4 Install/upgrade lifecycle lane

W6 — ship-time custody:

- [ ] W6.1 Apple notarization + signature-verified auto-update
- [ ] W6.2 Signed images, SBOM, provenance
- [ ] W6.3 CI egress control + dependency-behaviour layer

W7 — the running process:

- [ ] W7.1 Sandbox model runtime + handler workers
- [ ] W7.2 Rust-side lanes (cargo-audit/deny; unsafe-edge pass)

W8 — the field, and the spec:

- [ ] W8.1 Crash/anomaly ledger + redacted diagnostics bundle
- [ ] W8.2 Mobile resource evidence ledger seeded
- [ ] W8.3 External reviews scheduled; formal-model note

## What changed

### Wave A — re-arm the dormant gates (W0) + PR-cheap hostile input (W2.1, W2.2)

**W0.1 — suite wall-clock now enforced.** `test:suite-wall-clock` existed with a
tighten-only ceiling but no lane ran it. Wired into CI `verify` in the step
immediately after `bun run coverage` writes `artifacts/test-results/vitest.json`,
and into `check:full` locally. The step asserts the artifact exists first: the
script's own "not measured → exit 0" is right on a laptop and wrong in the
enforcing lane, where a missing report means wiring rot, not a met budget. The
ceiling (1,620,000 ms, seeded 2026-07-31) is left untouched — the first CI
`verify` on this branch is its real re-measurement; a red there is staleness, not
a regression.

**W0.2 — the #639 diff-coverage waiver is gone.** #639 (the Oxfmt toolchain
migration) merged as PR #642; its `approvedDeviation` in
`tests/diff-coverage-deviation.json`, whose own text said "must be removed when
#639 merges", is removed (replaced by a `_comment` recording that no waiver is in
force). The 80% changed-line gate now bites this branch again — proven by the
loader: with the key absent, `approvedDeviation` stays null and the gate returns
`ok:false` below 80%. Two cautions carried to the final `check:pr`: the only local
coverage artifact is a partial run (most packages never executed), so no honest
diff-coverage number exists until CI runs the full instrumented suite; and
`isInstrumentableSource` counts `*.test-fixtures.ts` and `test-kit/vitest.ts` as
product lines, so test-infrastructure changes land in the 80% denominator — a
ruling to make at the gate, not a floor to lower here.

**W0.3 — the silently-absent Tally test, and a tripwire so the class fails loud.**
`PendingRestartJourney.test.tsx` was already deleted (in #831, with the Tally
native cover it asserted); it owned no matrix cell, so no floor left with it.
Reproduced from history: the real fault was a preset gap — the
`externalize-node-sqlite` resolve plugin shipped on the jsdom preset only, but the
transform environment is chosen per-file (`@vitest-environment` docblock) while
plugins are chosen per-project, so a jsdom-docblock file in a node project went
through Vite's client environment with no externalizer. Fixed in
`packages/test-kit/src/vitest.ts` (plugin on both presets), pinned by
`node-sqlite-driver.jsdom.test.ts`. New `scripts/ci/collection-tripwire.mjs`
(+ 9-case unit suite + two real vitest-report fixtures) fails on the exact
"failed file, zero assertions" shape a load-time throw produces, so a suite can no
longer go absent past the counting gates; wired into `scripts:test` and the CI
`verify` lane (`--require-report`).

**W0.4 — the e2e-flow roster is discovered, not enumerated.** `lint-e2e-flows.mjs`
carried a hand-written `FILES` list that omitted all five `photos-*.mjs` flows;
replaced with disk discovery over the flows + lib dirs (with an empty, commented
exclusion set), so a new journey is linted the moment it exists — 12→23 files, and
`volume-proof.mjs` turned out to be a second unlinted escapee. The linter then
found the queued #839 defect itself: `photos-permissions.mjs:32` asserted the
always-true "Home" (both a tab label and a band capsule label), and was the last
flow still waiting on the dead `"Home ready"` marker #789 removed. Fixed to
exercise the takeover→Home path against `HOME_READY_MARKER`; a baseless
`input-observed` marker (a rule that never existed) removed from `photos-search`.

**W0.5 — `sendToFirstToken` measured, not guessed.** It was `unmeasured` with no
ceiling (gating nothing). A stub already existed (`fake-acp-harness.mjs`); the new
`scripts/perf/send-to-first-token.mjs` drives a real `runAcpTurn` against it and
times send→first `assistant.delta`, measured at p95 53 ms idle / 123 ms contended,
ceiling seeded at 400 ms (~3.3× worst, sized against contention because a CI runner
is the contended case), CI-wired after `build`. The entry's `probe` states the
honesty boundary: it fences the gateway-side span (spawn + handshake + dispatch +
stream translation), not the HTTP/SSE route, clients, or a real provider's TTFT.
No `projected` metrics exist in the file (the brief was stale on that). See the
blocked register for `reconnectToFresh` and the route/client half.

**W0.6 — SonarCloud wired, dormant cruft swept.** `.github/workflows/sonarcloud.yml`
runs the orphaned `configure-sonarcloud.mjs` on push-to-main/weekly/dispatch,
token-gated (`HAS_SONAR_TOKEN` env indirection, every step skipped with an explicit
notice when the secret is absent), deliberately not a PR gate. Analysis stays
Autoscan — SonarCloud rejects a CI scanner while Automatic Analysis is on — so this
applies project config only; SECURITY.md and docs/toolchain.md updated to that
truth. Deleted as genuinely dead (grep-proven zero consumers): stray root
`probe-crypto.ts` (accidental in #684) and the eight `tests/mutation/stryker.*.mjs`
root pointers (indexed 8 of 24 seeds, read by nothing). Kept with a clarifying
header: `bot-pins.yml.example` (intentional #468 E6 scaffold). `knip.json` drops the
now-orphaned `@stryker-mutator/api` ignore.

**W2.1 — the three peer-target guards, tested for agreement.** A seeded fast-check
differential (`packages/tunnel/src/peer-target-differential.test.ts`) draws
adversarial targets (percent-escapes, dot-segments, confusables, null bytes,
overlong encodings) and asserts the JS `isPeerPlaneTarget`, the route-layer
composite, and a byte-faithful model of the Rust `peer_target_allowed` return the
same verdict; a committed golden + a byte-deterministic generated corpus bridge to
a Rust test that reads the same file (verified against the compiled function, 48
vectors, 0 mismatches). Two disagreements found and **pinned** (never fixed here,
per A-pinned): a bare peer-plane prefix plus a query/fragment is wrongly admitted
(the length test measures the whole target, not the path), and a lone surrogate is
admitted JS-side but unrepresentable in a Rust `&str`. No target the guard admits
resolves outside the peer plane — the confinement itself holds. Registered as the
`tunnel-pairing.security` adversarial-input flow.

**W2.2 — a prompt-injection corpus against the agent loop.** 14 committed hostile
payloads (injected ICS text, OCR'd document content, shared-commons rows carrying
instructions) run through real automation/conversation turns against the fake ACP
harness, asserting the structural defenses that confine a duped agent regardless of
whether it "complies": consent-scoped grants refuse out-of-grant reads,
confirm-gated destructive commands park for the owner, egress classes never widen
from content, no tool call names an entity outside the turn's grant. All four held
for every payload — no breach, so no pin. The corpus is grow-only (discovered from
disk), auto-run under `@centraid/server`. It owns the matrix flow
`agent-prompt-injection-red-team` on `agent-runtime.security`, and that cell's gap
note now records the adversarial-input half as covered (authorization cases remain
open under #781) — the lane is visible to the grid rather than green in the dark.
Its floor is 2, because `countDeclaredTests` reads declarations and the payload
sweep is one `test.each` over the corpus; the real floor is enforced in-band by the
census test, which asserts ≥10 payloads spanning every carrier and every invariant.

**Root integration.** The pre-existing oversize files two waves left behind —
`manifest-scope-denial.sweep.test.ts` (906L) and `scripts/fuzz/targets.mjs` (789L) —
were split under the 625 limit with behavior preserved (90 + 14 tests unchanged);
the sweep's single matrix flow (floor 18) became three flows on `gateway.security`
(4+10+4, floor unchanged) and the Refusal-grammar engine propertyFlow repoints to
the closed-grammar file. TESTING.md, docs/decisions.md (A-pinned += the two W2.1
pins), docs/toolchain.md, the e2e README/AGENTS, and knip.json updated to current
state.

### Wave C — chaos and load (W3–W4), supply chain (W6–W7), field (W8)

**W1.3 — the restore drill learns to judge the restored vault usable.** The
in-product drill already existed (`BackupService.runRestoreVerify`, #408 G9): it
takes a real backup through the real product path, restores it to a scratch dir and
runs `verifyRestoredPair`. What it could not do is notice a restore that opened
cleanly and was empty — `integrity_check` is a statement about b-tree pages, not
rows. `packages/server/src/backup/restore-drill.ts` adds the two laws that ask the
usability question, and rides the existing `policy.verifyEveryDays` cadence and the
existing `backup restore-verify` verb rather than adding a second clock the two
could disagree on. `restored-blob-coverage`: every blob sha the *restored* model
still claims must resolve as materialized CAS, as replicated to the durable remote
tier per the restored vault's own `blob_replica`, or as a lazy restore's
`skipBlob` — a sha in none of the three is a surviving row whose bytes are gone, and
is an error. Evidence is read from the restored vault only: a restore is judged by
what the restored bytes alone can prove. `restored-census`: zero parties is an error
(founding enrols the owner party, so no instant a snapshot could capture is
partyless — zero is an empty shell, not a stale vault), while a spine table
non-empty live and empty restored is a warning, because a legitimately stale
snapshot restores fewer rows *truthfully* and a drill that cries wolf gets ignored;
an unmounted plane warns naming that reason rather than passing silently. The CAS
sample is drawn with `seededRandom` keyed on `${vaultId}:${seq}`, so a failing drill
replays over the identical sample. The `cas-rehash` and `replica-journal` checks are
imported from W1.2's doctor library, not reimplemented — that import is what now
consumes the two exports knip had listed as unused. Errors join the run's `problems`
so the run throws and `lastRestoreVerifyError` persists (without which the health
probe recomputes from state and flips green at the next tick); warnings join the
degraded branch beside dangling receipts. Two red lanes prove it: sabotaging the
product to drop `drillErrors` shows **both provably broken vaults restore-verify
green without the drill**, and the empty-shell test sabotages the source into an
FK-clean state (cascade discovered from `PRAGMA foreign_key_check`, not hard-coded)
and asserts the thrown message matches `/EMPTY SHELL/` and *not*
`/integrity|fk violation|placebo|wal/` — that negative assertion is the proof the
drill, and nothing pre-existing, caught it. Only CI can sabotage a real vault and
demand the alarm, so both red lanes live there; the in-product drill only ever meets
a healthy store. Registered as `backup-restore-drill` (durability, integration,
floor 3) and `backup-restore-drill-grading` (correctness, unit, floor 8).

## Blocked-external register

Items whose completion requires an external actor or infrastructure not present
in this environment; the code side lands, the external half is named here.

- **`gateway.reconnectToFresh` experience budget (needs a rig, not an external
  actor).** Sync-staleness after reconnect at 50,000 replica rows is unmeasured;
  the existing `replica-bootstrap` scale rig times a windowed bootstrap, a
  different path. Unblock: a harness timing the change-stream resume path from
  disconnect to first correct frame, then seed `ceilingMs`. Left `unmeasured`
  with a loud probe (the sanctioned honest state), gating nothing rather than
  faking a number.
- **`desktop`/`web` `sendToFirstToken` (needs a rig).** The route + client half
  of the measured gateway metric needs the e2e mock gateway to serve a
  fixed-delay SSE turn plus a client-side first-token marker. Left `unmeasured`.

## Decisions

- **SonarCloud is Autoscan for analysis, token-gated CI for config only.**
  Automatic Analysis stays on (SonarCloud rejects a CI scanner while it is), so
  the wired workflow applies project configuration on push-to-main/weekly/dispatch
  and no-ops without `SONAR_TOKEN`. It is deliberately not a PR gate.
- **The collection-error tripwire is a first-class gate.** A file that throws at
  load registers zero tests and slips past every counting gate as "absent" rather
  than "red"; `test:collection-tripwire` makes that shape fail. Quarantining or
  deleting the offender hides the gap and is refused.
- **W2.1's two guard disagreements are pinned, not fixed** (A-pinned; also in
  [decisions.md](../docs/decisions.md)). The differential lane exists to keep them
  visible until the guards are corrected under their own change.
- **The #639 diff-coverage waiver removal re-arms the 80% gate against this
  branch.** Two open questions for the final `check:pr`, recorded rather than
  pre-decided: the real number needs CI's full instrumented run (the local
  artifact is partial), and `*.test-fixtures.ts` / `test-kit/vitest.ts` counting
  as covered product lines wants a ruling on fixture code in the denominator.

## Audit

(The single fresh-context audit covering #839 and #842 lands its verdicts
here at the end of all waves.)
