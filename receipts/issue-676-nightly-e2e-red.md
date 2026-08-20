# Issue #676 — Nightly e2e lane red continuously

## Checklist

- [x] `pairing-lifecycle` / `pairing-ticket-hygiene` — loopback harness pointed at a package that no longer exists
- [x] `web-e2e` — cold shell over its request ceiling, app-open probe measuring a gutted app, warm-shell flake
- [x] `restore-year3` — durable fixture cache reused across a schema change
- [x] `quality-performance-scale` — consumed the failing web evidence
- [x] `test:ratchet` green on main again (spent flow-rename marker)
- [x] `ratchet-floors` actually reads the ledger it compares
- [ ] `mobile-e2e-ios` / `mobile-e2e-android` — NOT fixed; see Out of scope

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

- **`packages/client/src/device-enrichment-compute.ts`,
  `packages/blueprints/apps/docs/pdf-text.ts`** — `pdfjs-dist/.../pdf.worker.min.mjs?url`
  was imported at module scope. `?url` compiles to a module whose entire body is
  one 35-character string, so a static import pinned it into the static graph of
  every chunk reaching those files — including `boot`. Vite emitted it as its own
  chunk and the cold shell spent a whole HTTP request on it before any PDF
  existed: 18 same-origin requests against a ceiling of 17. Both imports are now
  awaited alongside the PDF.js display build they belong to. Verified: `boot`
  no longer references the chunk and the cold shell measures exactly 17.

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
  `tests/helpers/year3-schema-fingerprint.ts`, `tests/scale/*.scale.test.ts`** —
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

## User impact

Nothing in the product's appearance or behaviour changes. The one runtime-visible
effect is a small win: the web shell no longer fetches the PDF.js worker-URL chunk
during boot, so a cold load makes 17 same-origin requests instead of 18. PDF text
extraction is unaffected — the worker URL now travels with the PDF.js chunk that
already loaded lazily, so it arrives exactly when a PDF is first parsed.

First-run: unchanged. Onboarding, pairing and the first cold shell paint exactly
as before; the removed request carried no pixels, only a 35-character string.

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
