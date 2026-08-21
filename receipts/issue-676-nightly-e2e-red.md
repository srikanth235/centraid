# Issue #676 — Nightly e2e lane red continuously

## Checklist

Issue #676 is auto-filed by `e2e.yml` and carries no checklist of its own, so
there was nothing to mirror. The list below is posted verbatim on the issue as
[comment 5365646673](https://github.com/srikanth235/centraid/issues/676#issuecomment-5365646673)
so the two records line up. Grounded on the 2026-08-20 nightly (run
`32339238817`), plus `restore-year3`, which is a job in `e2e.yml` but is not in
the auto-filed job-results list.

- [x] `pairing-lifecycle` — loopback harness pointed at a package that no longer exists
- [x] `pairing-ticket-hygiene` — same cause as `pairing-lifecycle`
- [x] `web-e2e` — cold shell over its request ceiling, app-open probe measuring a gutted app, warm-shell flake
- [x] `restore-year3` — durable fixture cache reused across a schema change (job exists in `e2e.yml`; not reported in the job-results list)
- [x] `quality-performance-scale` — consumed the failing web evidence; no change of its own
- [x] `test:ratchet` green on `main` again (spent flow-rename marker, failing on every branch)
- [x] `ratchet-floors` actually reads the ledger it compares (truncated `approvedDeviation` extraction)
- [ ] `mobile-e2e-ios` — NOT fixed; needs macOS/Xcode to observe, and the pre-onboarding compatibility wall may be reporting a real capability mismatch
- [ ] `mobile-e2e-android` — NOT fixed; needs a KVM-accelerated emulator, same wall
- [ ] `test-health-report` — dependent job; its zero-grey contract cannot pass while the four `mobile:*` cells have no evidence

## What changed

- **`tests/agent-e2e-pairing/lib/harness.mjs`** — `GATEWAY_CLI` pointed at
  `packages/gateway/dist/cli/cli.js`. That package no longer exists; the
  `centraid-gateway` bin ships from `packages/server`. The file's own sibling
  imports (`dist/cli/key-store.js`, `landlord-auth.js`, `paths.js`) and
  `lib/docker-harness.mjs`'s `GATEWAY_CLI_REL` were already renamed — this one
  constant was missed, which is exactly why `pairing-cross-network-relay` (the
  docker harness) stayed green while both loopback jobs went red on 08-17.
  The miss is silent by construction: `ensureBuilt` only checks whether the file
  is present, so a wrong path re-runs the scoped build, still does not find it,
  and the daemon dies later with `MODULE_NOT_FOUND`. Both flows verified passing.

- **`apps/web/tests/e2e/perf-budgets.ts` (`shell.maxRequests` 17 → 18)** — the
  cold shell has been making 18 same-origin requests against a ceiling of 17.
  The 18th is the `pdfjs-dist/.../pdf.worker.min.mjs?url` module: `?url` compiles
  to a body of one 35-character string, so the static imports in
  `packages/client/src/device-enrichment-compute.ts` and
  `packages/blueprints/apps/docs/pdf-text.ts` pin it into the static graph of
  every chunk reaching them, including `boot`, and Vite emits it as its own
  chunk. Making both imports lazy DOES remove the request — and breaks the
  desktop offline journey (`pending-overlay.spec.ts` renders "No vault access
  yet." after an offline Electron reload), because it splits the offline-critical
  boot graph. Established by bisection against a pristine `origin/main`
  worktree: main passes the journey, both-lazy fails it, and `docs/pdf-text.ts`
  lazy ALONE passes while leaving the shell at 18 — so the request that has to
  go is the one whose removal breaks offline. Offline correctness is a product
  promise; one 411-byte request is not. Both source files are therefore left at
  `main` byte-for-byte and the ceiling moves instead, disclosed in
  `approvedDeviation`. TIGHTEN back to 17 with a bundling change that keeps the
  worker-URL module out of `boot` WITHOUT splitting that graph.

- **`apps/web/tests/e2e/perf-waterfall.spec.ts`** — the app-open subject moves
  Tasks → Docs. #831 removed the Agenda/Notes/Tally/Tasks interfaces wholesale
  pending a redesign (their `Root` paints one empty element), so this probe was
  measuring a hollow route: 7_346 encoded bytes against a 70_000 `minEncodedBytes`
  floor. The floor did its job; the subject was the bug. #831 had already
  retargeted the desktop and web offline journeys onto Docs for this reason and
  did not reach this spec.

- **`apps/web/tests/e2e/perf-waterfall.spec.ts` (warm shell)** —
  `establishSession()` reloaded and only THEN waited for
  `navigator.serviceWorker.controller`, so the reload the warm measurement reads
  raced SW activation. Hashed assets survived an uncontrolled load on the browser
  HTTP cache at 0 wire bytes, which hid it; the sqlite worker script did not, and
  came back over the wire at 67_300 B — driving `maxWarmToColdByteRatio` to
  0.1505 against its 0.15 ceiling roughly one run in four. The wait now happens
  BEFORE the reload and the timeline settles after it, as the cold path already
  did. Measured 0.0 on 18 consecutive runs afterwards.

- **`apps/web/tests/e2e/perf-budgets.ts`** — three ceilings re-seeded onto the
  new subject, each disclosed in `approvedDeviation`:
  `appOpen.cold.maxEncodedBytes` 120_000 → 240_000 (measured 216_625),
  `appOpen.cold.maxTotalRequests` 30 → 36 (measured 20-28 over 10 runs; the old
  30 sat two above an observed 28 and would have flaked),
  `appOpen.warm.maxTotalRequests` 14 → 24 (measured 10-16). `minEncodedBytes`
  is deliberately NOT raised to match the heavier subject.

- **`packages/test-kit/src/year3-vault.ts`,
  `tests/helpers/year3-schema-fingerprint.ts`,
  `tests/scale/restore-10gib.scale.test.ts`,
  `tests/scale/large-vault.scale.test.ts`,
  `tests/scale/photos-timeline.scale.test.ts`** —
  `restore-year3` failed nightly with `no such table: main.enrich_policy_rule`
  out of `openVaultDb`. The year-3 fixture cache key hashed the fixture's SHAPE
  and a hand-maintained `YEAR3_FIXTURE_VERSION`, neither of which moves when the
  fresh-schema rung gains a table — and `actions/cache` restored the same
  pre-`enrich_policy_rule` fixture into every run. `materializeYear3Fixture` now
  takes a `schemaFingerprint`; the three scale rigs pass one derived from the
  migration ladder. `@centraid/test-kit` must not depend on `@centraid/vault`,
  so the helper lives on the caller's side of that edge.

- **`scripts/test-report/ratchet-floors.mjs`** — `approvedDeviation` was
  extracted with ``['"`][^'"`]+['"`]``, which stops at the first inner quote.
  `perf-budgets.ts` quotes a command in backticks in its second sentence, so
  only a 1,653-character prefix was ever compared and every later entry was
  invisible. That fails in the dangerous direction: appending a rationale is the
  documented way to waive a widening, and an author who did exactly that was
  still rejected because base and head truncated identically. Extraction is now
  a named, exported, unit-tested function that reads the whole literal.

- **`tests/matrix.json`** — dropped the spent
  `replacesMinimumTestsFlow: "web-pending-overlay"` marker from
  `web-offline-pending-row`. `diffMinimumTests` resolves the predecessor in the
  MERGE BASE, so the key is only satisfiable in the change set that performs the
  rename; once #831 landed, the predecessor was gone from base too and the marker
  reported `flow replacement names unknown predecessor` on every run. Confirmed
  failing on a pristine `origin/main` worktree, so this was breaking
  `test:ratchet` for every branch, not just this one. Base and head both hold the
  flow at `minimumTests: 1`, so nothing is lowered; the rationale is preserved.

- **`packages/test-kit/src/year3-fixture-cache-key.test.ts`,
  `scripts/test-report/ratchet-floors.test.mjs`** — regression tests for the two
  silent-failure bugs above: a fingerprinted fixture key must never collide with
  an unfingerprinted one (or the first run after the fix adopts the very fixture
  that was breaking the nightly), and appending to a ledger must change what the
  ratchet compares.

- **`tests/quality/classification-ratchet.json`** — the `tests/matrix.json`
  fingerprint re-pinned for the marker drop above, with the `approvedDeviation`
  that `scripts/check-quality-knobs.mjs` requires. The deviation text is quoted
  verbatim in `## Decisions`, which is where that gate reads it from. Qualities,
  `demonstratedRed` and every `minimumTests` floor are untouched.

- **`receipts/issue-831-clear-four-app-interfaces.md`** — gained the
  `## Out of scope` section it was missing, and the checklist crosswalk that
  section unlocked. `receipt-per-issue` checks every receipt in the tree, not
  only the change set's own, so #831's omission failed the gate on this branch
  (and on every other branch since it landed); the crosswalk is skipped while
  any required section is absent, so restoring the section exposed six further
  violations underneath it. The added `## Out of scope` restates boundaries #831
  already drew in its `## Decisions` — the replacement interfaces, everything
  below the app surface, the `datetimepicker` native-state removal, and the two
  journeys it could not execute. The added crosswalk quotes each of #831's
  checked items and points at the paragraph of its own `## What changed` that
  already evidences it. Neither addition asserts anything new about #831's work.
  Flagged here rather than fixed silently because it is a change to another
  issue's record — and because it needs a `governance: allow-doc-integrity`
  waiver in the commit body: `doc-integrity` freezes a receipt once it is on the
  default branch, so the two directives disagree about this file and
  `receipt-per-issue` cannot be satisfied without the waiver. See `## Decisions`.

- **`tests/skips.json`** — regenerated with
  `node scripts/test-report/skip-inventory.mjs --write`, the remedy the gate
  itself prints. Two inventoried skip sites drifted because this change set
  added lines above them (`perf-waterfall.spec.ts#1` 817 → 861,
  `restore-10gib.scale.test.ts#1` 114 → 115). The regeneration also re-sorts one
  pre-existing entry (`live-automation-failover.test.ts#1`) into key order —
  tool output, not a hand edit, and no skip is added, removed or re-reasoned.
  The count stays 25 against a budget of 25.

- **`CHANGELOG.md`** — one `Fixed` entry per repaired lane under #676: the
  pairing harness path, the year-3 fixture cache key, the two `test:ratchet`
  breakages, the re-seeded web app-open probe, and the disclosed 17 → 18
  cold-shell ceiling.

### Checklist crosswalk

Each checked item, quoted from `## Checklist`, against the bullet above that
carries its evidence.

- `pairing-lifecycle` — loopback harness pointed at a package that no longer exists
  → the `tests/agent-e2e-pairing/lib/harness.mjs` bullet; both flows replayed in
  `## Verification`.
- `pairing-ticket-hygiene` — same cause as `pairing-lifecycle`
  → same bullet, same constant; the two jobs run the same harness.
- `web-e2e` — cold shell over its request ceiling, app-open probe measuring a gutted app, warm-shell flake
  → the three `perf-budgets.ts` / `perf-waterfall.spec.ts` bullets, one per
  symptom.
- `restore-year3` — durable fixture cache reused across a schema change (job exists in `e2e.yml`; not reported in the job-results list)
  → the `year3-vault.ts` / `year3-schema-fingerprint.ts` / `tests/scale/*` bullet.
- `quality-performance-scale` — consumed the failing web evidence; no change of its own
  → no bullet by design: the lane reads the web and scale evidence the two
  bullets above repair. Its own configuration is untouched.
- `test:ratchet` green on `main` again (spent flow-rename marker, failing on every branch)
  → the `tests/matrix.json` bullet, plus the fingerprint re-pin in
  `tests/quality/classification-ratchet.json`.
- `ratchet-floors` actually reads the ledger it compares (truncated `approvedDeviation` extraction)
  → the `scripts/test-report/ratchet-floors.mjs` bullet and its unit tests.

## User impact

No product code changes in this change set: every file it touches is a test
harness, a budget ledger, a governance fixture or a doc. The shipped shell,
the Docs app and the PDF text path are byte-for-byte `main`.

First-run: unchanged. Onboarding, pairing and the first cold shell paint exactly
as before — the 18-request cold shell described above is what `main` already
ships, not a new cost this change introduces.

Evidence that the re-seeded app-open budgets describe a real, mounting app:
`artifacts/e2e/ui-impact/web-app-open-docs.png` (emitted by
`apps/web/tests/e2e/perf-waterfall.spec.ts` on the cold Docs open).

## Decisions

- Re-point the app-open probe at Docs rather than lower `minEncodedBytes` to fit
  a gutted Tasks. The floor is an anti-vacuity check and it fired correctly; the
  fix for "the subject has no interface left" is a different subject, which is
  what #831 itself did for the offline journeys.
- Bind the year-3 fixture cache to a schema fingerprint instead of bumping
  `YEAR3_FIXTURE_VERSION`. A bump clears the cache once and leaves the next
  schema change to rediscover the same failure the same way.
- Keep `appOpen.cold.minEncodedBytes` at 70_000 even though Docs measures
  216_625. Raising a floor from an unverified local number is how this rig starts
  flaking — #800 recorded a local/CI spread of 112_759 vs 80_561 on this exact
  metric. 70_000 stays load-bearing against Docs; tighten once CI publishes a
  Docs number.
- Fix the `approvedDeviation` extractor rather than prepend this entry to the
  front of the ledger to get the waiver seen. Prepending would have worked and
  left the gate broken for the next author.
- Widen `appOpen.cold.maxTotalRequests` to 36 rather than the 32 that measurement
  alone suggests, matching the ~25% headroom the previous number used. Its stated
  job is catching an open that fires round-trips by the dozen, which 36 still does.
- Move `shell.maxRequests` 17 → 18 rather than keep the lazy-import fix that
  removed the 18th request. That fix was written first and looked clean; CI's
  `desktop-e2e` refuted it. `pending-overlay.spec.ts` is the offline promise —
  reload an Electron shell with no gateway and the vault still opens — and the
  lazy import breaks it by splitting the boot graph the offline reload depends
  on. A budget number is a claim about cost; the offline journey is a claim about
  correctness, and correctness wins. The ceiling was never describing `main`
  truthfully in the first place: `main` also makes 18 requests, which is why the
  web lane was red. Recorded with the counterfactual so the next author does not
  re-derive it: `docs/pdf-text.ts` lazy ALONE keeps the journey green and leaves
  the shell at 18, so the removable request is exactly the one that breaks
  offline.
- Take the `doc-integrity` waiver on `receipts/issue-831-clear-four-app-interfaces.md`
  rather than leave `receipt-per-issue` red. The two directives genuinely
  disagree here: `receipt-per-issue` demands a `## Out of scope` section that
  receipt does not have, and `doc-integrity` freezes the file because it is
  already on the default branch. Nothing in the change set can satisfy both,
  and the failure is not this branch's — it has been failing governance for
  every branch since #831 landed, the same shape of pre-existing breakage as
  the `test:ratchet` marker above. The alternatives were worse: a
  `governance: allow-receipt-per-issue` waiver on that receipt also requires
  editing the frozen file, and leaving it red leaves the repo's own gate broken
  for the next author. The waiver is path-scoped, carries its reason, and is
  auditable with `git log --grep=allow-doc-integrity`. What the edit adds is
  strictly additive and strictly derivative: a section restating boundaries
  #831 already drew, and a crosswalk quoting #831's own checklist against
  #831's own prose. No sentence of the original record is altered or removed.
- Fix `receipt-per-issue`'s complaint about #831 rather than route around it,
  even though the receipt belongs to someone else's issue. A gate that fails
  identically on every branch teaches authors to ignore it, which is how the
  `approvedDeviation` truncation above survived unnoticed.
- Quality-knob deviation (verbatim, as `tests/quality/classification-ratchet.json`
  carries it):

#676 re-pins the `tests/matrix.json` fingerprint in `tests/quality/classification-ratchet.json` after dropping the spent `replacesMinimumTestsFlow: "web-pending-overlay"` marker from `web-offline-pending-row`. That key is only resolvable in the change set that performs the rename, so once #831 landed it failed `test:ratchet` on every branch including a pristine main. Qualities, demonstratedRed and every `minimumTests` floor are untouched; base and head both hold the flow at 1.

## Out of scope

- **`mobile-e2e-ios` and `mobile-e2e-android` remain red.** They have been
  failing every night since before this issue's first comment and are separately
  triaged in the 2026-08-15 comment: `ReplicaCompatibilityGate` renders the
  compatibility wall over the pre-onboarding pairing screen, so every Maestro
  flow fails at its first assertion. A branch with a candidate fix exists
  (`codex/ios-nightly-e2e`) and is described there as plausible but unproven.
  Not attempted here: both lanes need macOS/Xcode and a KVM-accelerated Android
  emulator to observe, and the pre-onboarding wall could equally be a REAL
  gateway-capability mismatch that the wall is correctly reporting — suppressing
  it blind would hide the defect rather than fix it. The 08-20 iOS run also failed
  in `Build and install the mobile development app`, a native-build failure
  distinct from the flow failures, whose log is not reachable from this
  environment.
- `test-health-report` is a dependent job. Its zero-grey contract cannot pass
  while `mobile:journey`, `mobile:offline`, `mobile:performance` and
  `mobile:scalability` have no evidence, so it stays red until the mobile lanes
  do — the pairing, web and quality cells it was also failing on are fixed here.
- Re-baselining the Photos mobile suite budget (676-821s measured against a 480s
  budget, noted in the 08-15 triage) — unreachable until mobile flows run at all.

## Verification

The two pairing flows, the web lane and the ratchets were replayed locally; the
scale lane's fix is covered by unit test plus the reasoning in `## What changed`
(a 10 GiB restore does not fit this container). `mobile-e2e-*` is unreachable
here — see `## Out of scope`.

Playwright's pinned browser build is absent from this container and
`cdn.playwright.dev` is blocked by the proxy, so the web commands below run
against a symlink shadow of the installed build; on CI they run unmodified.

```sh
# Pairing — the two loopback lanes that went red on 08-17. The flow file for
# the `pairing-lifecycle` job is named device-pairing-lifecycle.mjs; the job
# name and the file name differ (see e2e.yml).
node tests/agent-e2e-pairing/flows/device-pairing-lifecycle.mjs  # PASS in 34220ms
node tests/agent-e2e-pairing/flows/pairing-ticket-hygiene.mjs    # PASS in 8239ms

# Web e2e — the shell/app-open waterfall and the rest of the lane
bun run build                                   # required: a stale dist drops the
                                                # precompress sidecars and the
                                                # transfer number reads ~1.7 MB
bun run --cwd apps/web e2e                      # 26 passed
#   shell  cold: requests=18 transfer=447517B   (ceiling 18)
#   shell  warm: requests=20 transfer=0B        (ratio 0.0, ceiling 0.15)
#   app    cold: encoded=216609B requests=27    (ceilings 240000 / 36;
#                                                20-28 observed over 10 runs)
#   app    warm: encoded=0B requests=11         (ceiling 24)
# The warm-shell race that flaked ~1 run in 4 measured 0.0 on 18 consecutive runs
# after moving the service-worker-controller wait ahead of the reload.

# Desktop e2e — the offline journey that refuted the lazy-import fix.
# Needs a display, a session bus and a secrets keyring, exactly as the lane
# gives it (.github/workflows/lane-client-e2e.yml).
xvfb-run --auto-servernum dbus-run-session -- bash -c '
  rm -rf ~/.local/share/keyrings
  printf "\n" | gnome-keyring-daemon --replace --components=secrets --unlock --foreground &
  sleep 2
  bun run --cwd apps/desktop test:e2e
'                                               # 59 passed, 1 flaky
# The flaky one is pending-overlay.spec.ts: attempt 1 timed out waiting for the
# renamed row, attempt 2 passed. Not this change's — nothing here touches
# desktop runtime code, and with the lazy import in place it failed BOTH
# attempts, deterministically, on the same assertion.

# Ratchets and governance gates
node scripts/test-report/ratchet-floors.mjs     # ok (no decreases vs origin/main)
bun run test:ratchet                            # ok
node scripts/check-quality-knobs.mjs            # ok
node scripts/validate-ui-receipt.mjs            # ok
bun run format:check && bun run lint            # clean
bun run check:push                              # green

# Unit tests for the two silent-failure bugs
bunx vitest run --root packages/test-kit src/year3-fixture-cache-key.test.ts  # 4 passed
bun run --cwd packages/test-kit typecheck                                     # clean
bun run test:ratchet:unit                       # 21 files, 318 passed
#   (the lane that owns scripts/test-report/ratchet-floors.test.mjs; the four
#    new extractApprovedDeviationLiteral cases run here)
```

## Audit

Fresh-context sub-agent attestation (governance directive `receipt-per-issue`). The auditor was handed only the diff, this receipt, and issue #676, and instructed to default to REFUTED when uncertain.

- (1) '## What changed' faithfully describes the diff — PASS. Every changed path in `git diff origin/main --name-only` is now named verbatim in `## What changed` (checked mechanically), the sole exception being this receipt itself. Every quoted number matches: `shell.maxRequests` 17 → 18, `appOpen.cold.maxEncodedBytes` 120_000 → 240_000 (measured 216_625), `appOpen.cold.maxTotalRequests` 30 → 36, `appOpen.warm.maxTotalRequests` 14 → 24, `minEncodedBytes` held at 70_000, the 7_346 B hollow-Tasks reading, the 67_300 B / 0.1505 warm-shell race, and the 1,653-character `approvedDeviation` prefix (reproduced exactly by running the old ``['"`][^'"`]+['"`]`` pattern against the head file). An exhaustive numeric diff of `apps/web/tests/e2e/perf-budgets.ts` against `origin/main` finds exactly four moved values, all loosenings, all four disclosed in `approvedDeviation`; no ceiling moved silently, and `node scripts/check-quality-knobs.mjs` and `node scripts/test-report/ratchet-floors.mjs` were both re-run here and pass. Two statements this auditor would have flagged are now corrected in the source: the `approvedDeviation` sentence listing `cold.maxTotalRequests 30` as UNCHANGED is scoped to the same-origin block and followed by "The two all-origin maxTotalRequests keys DO move", and the `maxEncodedBytes` comment no longer credits #676 with keeping PDF.js dynamic — `main` already loads `pdfjs-dist/legacy/build/pdf.mjs` behind `import()` at `pdf-text.ts:85`. The revert claim holds: `packages/client/src/device-enrichment-compute.ts` and `packages/blueprints/apps/docs/pdf-text.ts` are modified relative to `HEAD` but absent from `git diff origin/main` — written, then reverted to `main` byte-for-byte, exactly as stated — and both still carry the static `pdf.worker.min.mjs?url` import on `main`. The `tests/skips.json` bullet is exact (identical key set to base, no entry content changed, only the two line moves it names, 25 against `_budget` 25); the `tests/quality/classification-ratchet.json` bullet is exact (only `approvedDeviation` and the `tests/matrix.json` fingerprint differ from base, `matrixGovernanceFingerprint` unchanged, no `qualities`/`demonstratedRed` key touched, deviation quoted verbatim inside `## Decisions`); and the rewritten `receipts/issue-831-clear-four-app-interfaces.md` bullet is accurate down to its causal claim — `check.sh` gates the crosswalk behind `has_all_sections`, so the missing `## Out of scope` really did mask the six uncited items.
- (2) Each '- [x]' item is realized in the diff — PASS. Pairing (now two rows, one cause): `tests/agent-e2e-pairing/lib/harness.mjs` `GATEWAY_CLI` moves `packages/gateway` → `packages/server`, while `docker-harness.mjs` and the sibling `dist/cli/*` imports were already correct in base — which is why only the two loopback jobs went red. Web: `perf-budgets.ts` 17 → 18, `perf-waterfall.spec.ts` `APP_ID`/`APP_NAME` `tasks`/`Tasks` → `docs`/`Docs`, and the `navigator.serviceWorker.controller` poll relocated ahead of `page.reload()` with a trailing `settleResourceTimeline`. `restore-year3`: `materializeYear3Fixture`/`year3FixtureCacheKey` gain `schemaFingerprint`, new `tests/helpers/year3-schema-fingerprint.ts` hashes both migration ladders, and all three scale rigs pass it. `test:ratchet`: the spent `replacesMinimumTestsFlow` key dropped with `minimumTests: 1` unchanged on both sides, plus the fingerprint re-pin. `ratchet-floors`: `extractApprovedDeviationLiteral` exported and unit-tested. `quality-performance-scale` claims "no change of its own" and correctly has none. The `### Checklist crosswalk` quotes all seven checked items verbatim and each pointer lands on a real bullet. Two `## Verification` numbers were re-executed here and match exactly: `bun run test:ratchet:unit` → 21 files / 318 passed, and the test-kit fixture-key suite → 4 passed. The pairing commands now cite the real flow file, `device-pairing-lifecycle.mjs` — confirmed on disk and as the script `.github/workflows/e2e.yml` runs for the `pairing-lifecycle` job; no `pairing-lifecycle.mjs` exists. The desktop-e2e run (59 passed, 1 flaky) could not be re-executed in this container for want of Electron and a display; the receipt discloses that flake and its attribution rather than rounding it to green. The three unchecked rows are correctly left `- [ ]`.
- (3) The '## Checklist' mirrors the issue's checklist — PASS. Issue #676 is auto-filed and had no checklist when this audit first ran; the working checklist is now posted as [comment 5365646673](https://github.com/srikanth235/centraid/issues/676#issuecomment-5365646673) and the receipt's ten rows are byte-identical to the comment's ten rows (diffed, no differences). It reconciles in both directions against the 2026-08-20 nightly (run `32339238817`): every failing job in that run has a row — `web-e2e`, `pairing-lifecycle`, `pairing-ticket-hygiene`, `quality-performance-scale`, `mobile-e2e-ios`, `mobile-e2e-android` and the previously missing `test-health-report` — and every row that is not in the auto-filed job-results list carries the qualifier that explains why, including `restore-year3`, which is genuinely a job in `.github/workflows/e2e.yml` (line 792) that the `nightly-failure-issue` step does not report. `desktop-e2e` was green and is explicitly named as not a fix target.

Verdict: PASS

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-21 | claude-code | afbf2631-6d85-5208-9ef1-2dffbdccf1fe |
