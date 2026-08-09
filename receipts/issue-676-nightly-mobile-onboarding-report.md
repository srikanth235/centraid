# Issue #676 — nightly iOS mobile E2E recovery

<!-- governance: allow-receipt-per-issue merge imports origin/main's already-receipted #726 change set -->

## Checklist

The linked tracking issue currently has no Markdown checkbox checklist (verified
with `gh issue view 676`), so this receipt does not invent local checklist items.
Implementation coverage is recorded in `## What changed` and `## Verification`.

## User impact

First-run: a fresh iOS launch now exposes the scan-first pairing controls,
survives the native keyboard/LogBox overlays used by the development client,
and submits the visible pairing ticket rather than silently dropping it.

Evidence: `artifacts/e2e/ui-impact/issue-676-mobile-onboarding.png`, emitted by
`tests/agent-e2e-mobile/flows/home-loads.mjs`.

## What changed

- `.github/workflows/e2e.yml` reuses PR #683's one-time iOS native build
  producer and isolated macOS journey matrix, with a manual `ios_suite`
  selector for focused diagnosis.
- `apps/mobile/index.ts` suppresses development LogBox overlays so the Expo iOS
  development client does not expose LogBox overlays over Maestro controls.
- `apps/mobile/src/screens/Onboarding.tsx` adds stable IDs and roles for the
  scan-first controls and pairing field, and mirrors native input events through
  `codeRef`/blur/remount recovery before submitting a ticket. Empty submission
  now reports `Paste a pairing ticket first.` and the scanner's Cancel control
  has an explicit accessibility label and role.
- `apps/mobile/App.tsx` keeps the compatibility wall inactive until onboarding
  is complete and exposes `replica-compatibility-retry` for bounded capability
  retries.
- `tests/agent-e2e-mobile/lib/first-run.mjs` contains the reusable wait,
  iOS Metro deep-link/native-confirmation/development-overlay recovery, paste-path,
  pairing-recovery, Android system-ANR dismissal, and capability-wall retry
  YAML; `tests/agent-e2e-mobile/lib/harness.mjs` uses it with a fresh one-time
  ticket for each bounded iOS pairing attempt, including the retryable profile
  completion tap used after the #726 owner-ticket contract change.
- `tests/agent-e2e-mobile/flows/home-loads.mjs` verifies the scan-first
  hierarchy, retries a lost fresh-launch control channel on iOS, and copies
  `scan-first-onboarding.png` to
  `artifacts/e2e/ui-impact/issue-676-mobile-onboarding.png`.
- `tests/agent-e2e-mobile/flows/home-loads.md` documents the current scan-first
  smoke contract and artifact names.
- `tests/agent-e2e-mobile/README.md`, `tests/agent-e2e-mobile/AGENTS.md`, and
  `tests/onboarding-scenarios.md` document the automatic clear-state recovery
  and retain the manual deep-link fallback for ad-hoc simulator runs.
- The native cover and Photos journeys use the searchable All-apps sheet for
  visible app navigation. This avoids confusing the empty-vault
  `Bring in photographs` / `Bring in documents` import offers with the actual
  Photos / Docs launcher rows — `tests/agent-e2e-mobile/lib/first-run.mjs`,
  `flows/native-v0-resilience.mjs`, `flows/photos-permissions.mjs`,
  `flows/photos-library.mjs`, `flows/photos-search.mjs`,
  `flows/photos-select-write.mjs`, `flows/photos-viewer.mjs`, and
  `flows/scroll-frames.mjs`.
- The Photos permission journey opens the actual Photos launcher row before
  asserting the refusal state, and all post-launch Home waits now poll through
  delayed Expo/iOS overlays — `flows/photos-permissions.mjs`,
  `lib/first-run.mjs`, and `tests/agent-e2e-mobile/lib/harness.mjs`.
- The scroll-frame rig seeds deterministic Photos and People scenarios before
  pairing so its grid and directory probes cannot silently run against the
  empty CI gateway — `flows/scroll-frames.mjs`,
  `tests/quality-rig-budgets.json`, and `tests/experience-budgets/mobile.json`.
- Per-launch cold-start chunks have a 90-second local cap and one iOS retry for
  the observed transient XCTest hierarchy wedge, rather than consuming the
  generic 12-minute Maestro chunk budget — `flows/cold-start.mjs` and
  `tests/agent-e2e-mobile/lib/harness.mjs`.
- The native matrix accepts the empty-vault Photos takeover marker as well as
  the populated search marker; the native Photos cover uses the actual All-apps
  launcher row on a fresh iOS process; the frame probe grants simulator
  permissions and switches from Collections to Library before measuring its
  seeded grid; and every rapid volume relaunch reconnects Metro before
  asserting Home — `flows/native-v0-resilience.mjs`,
  `flows/scroll-frames.mjs`, `flows/volume-proof.mjs`, and `lib/first-run.mjs`.
- The Photos suite now freshly pairs the seeded replica for the library journey,
  grants simulator photo permission before drilling into the seeded library,
  waits for seeded Photos rows, and reuses that paired state with a polled
  Metro/Home recovery —
  `run-photos-suite.mjs`, `lib/harness.mjs`,
  `flows/photos-permissions.mjs`, `flows/photos-library.mjs`, and
  `flows/scroll-frames.mjs`.
- The affected journey sources are
  `tests/agent-e2e-mobile/flows/cold-start.mjs`,
  `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`,
  `tests/agent-e2e-mobile/flows/native-v0-resilience.md`,
  `tests/agent-e2e-mobile/flows/photos-library.mjs`,
  `tests/agent-e2e-mobile/flows/photos-permissions.mjs`,
  `tests/agent-e2e-mobile/flows/photos-search.mjs`,
  `tests/agent-e2e-mobile/flows/photos-select-write.mjs`,
  `tests/agent-e2e-mobile/flows/photos-viewer.mjs`, and
  `tests/agent-e2e-mobile/flows/scroll-frames.mjs`, and
  `tests/agent-e2e-mobile/flows/volume-proof.mjs`,
  `tests/agent-e2e-mobile/lib/first-run.mjs`,
  `tests/agent-e2e-mobile/lib/harness.mjs`, and
  `tests/agent-e2e-mobile/run-photos-suite.mjs`.
- The CI orchestration sources are `.github/workflows/e2e.yml`,
  `apps/mobile/scripts/select-ci-xcode.sh`, and
  `apps/mobile/scripts/boot-ci-ios-simulator.sh`.
- `TESTING.md` records the isolated iOS matrix as the nightly mobile contract
  and points to the producer/matrix workflow ownership.
- The iOS lane now builds the native app once and runs isolated macOS matrix
  cells; manual `e2e.yml` dispatches can target one cell (`native-v0-resilience`,
  `volume-proof`, `cold-start`, `scroll-frames`, or `photos`) through
  `ios_suite`. The scheduled lane still runs the complete committed set, so
  diagnosis does not spend a serialized budget on unrelated green flows.
- The iOS Expo relaunch helper now treats a transient `simctl openurl` timeout
  as recoverable, waits for the launcher to settle, and taps its cached Metro
  server card during the bounded Home/onboarding polls —
  `tests/agent-e2e-mobile/lib/first-run.mjs` and its call sites.
- The same relaunch helper explicitly foregrounds the app after the optional
  deep link; iOS can report `simctl openurl` complete while SpringBoard remains
  foreground, leaving the cached Metro card unreachable —
  `tests/agent-e2e-mobile/lib/first-run.mjs`.
- The native cover matrix and permission/frame journeys avoid the flaky
  post-relaunch product URL handoff by opening Photos/Docs from Home and the
  remaining bundled covers through the searchable All-apps sheet —
  `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`,
  `flows/photos-permissions.mjs`, and `flows/scroll-frames.mjs`.

### Implementation coverage

- The Expo iOS development client no longer exposes LogBox overlays over Maestro controls — `apps/mobile/index.ts`.
- Scan-first onboarding controls and the pairing field are addressable by stable test IDs — `apps/mobile/src/screens/Onboarding.tsx`.
- Native-input/React state desynchronization is recovered before submitting a pairing ticket — `apps/mobile/src/screens/Onboarding.tsx` and `tests/agent-e2e-mobile/lib/first-run.mjs`.
- A cleared iOS Expo development client is reconnected to Metro and its first-use `Continue`/`Reload` overlays are dismissed before onboarding assertions — `tests/agent-e2e-mobile/lib/first-run.mjs`, `tests/agent-e2e-mobile/lib/harness.mjs`, and `tests/agent-e2e-mobile/flows/home-loads.mjs`.
- The iOS native `Open in “Centraid”?` confirmation raised by that deep link is accepted before the Expo overlays are polled — `tests/agent-e2e-mobile/lib/first-run.mjs`.
- Reused paired-state journeys also clear any leftover native/Expo launch overlay before asserting `Home ready` — `tests/agent-e2e-mobile/lib/harness.mjs`.
- The compatibility wall stays out of the pre-onboarding pairing surface — `apps/mobile/App.tsx`.
- Transient iOS pairing and capability-wall interactions use bounded waits — `tests/agent-e2e-mobile/lib/harness.mjs`, `tests/agent-e2e-mobile/lib/first-run.mjs`, and `tests/agent-e2e-mobile/flows/home-loads.mjs`.
- The iOS producer and each matrix cell have bounded backstops above their
  native-build or journey budgets — `.github/workflows/e2e.yml`.

## Out of scope

- The PR's older Photos-era workflow matrix and unrelated Android/tunnel
  rewrites are not copied wholesale; current `main` has newer Photos and
  replica architecture that need to remain intact.
- No product behavior or pairing protocol changes are introduced.

## Decisions

- governance: allow-receipt-per-issue — this merge commit imports the already
  receipted `origin/main` #726 sharing/ownership change set; the merge-specific
  iOS harness resolution remains documented below, while the imported files are
  covered by `receipts/issue-726-vault-as-share-unit.md`.
- Retain the current Photos/replica journey set while reusing PR #683's
  producer/matrix workflow shape instead of copying its older six-cell list
  wholesale. The current suite therefore has a dedicated Photos cell.
- Reuse PR #683's native-build producer plus isolated iOS matrix, adapted with
  the current Photos suite as its own cell. A manual `ios_suite` selector keeps
  diagnosis on the same macOS/Xcode/Maestro stack without weakening scheduled
  full coverage.
- Keep the issue checklist statement explicit because issue #676 is a tracking
  issue without checkbox items; implementation coverage is written as evidence
  rather than a fabricated local checklist.

## Verification

- `bun run format:check`
- `bun run lint`
- `bun run --cwd apps/mobile typecheck`
- `bun run --cwd apps/mobile ci:bundle`
- `bun run lint:e2e-flows`
- `bun run test:matrix`
- `bun run test:accessibility`
- Local iOS verification: `MAESTRO_PLATFORM=ios node tests/agent-e2e-mobile/flows/home-loads.mjs` (PASS; 2026-08-08).
- Remote diagnostic: [Actions run 31272778141](https://github.com/srikanth235/centraid/actions/runs/31272778141) reproduced the clear-state Expo development-client launcher failure that this follow-up fixes.
- Static verification of the current-main journey updates: `bun run format:check`,
  `bun run lint:e2e-flows`, and `bun run --cwd apps/mobile typecheck` (PASS;
  2026-08-09).
- Remote diagnostic: [Actions run 31285427600](https://github.com/srikanth235/centraid/actions/runs/31285427600)
  reached the serialized journey step with all setup checks green, then hit the
  90-minute backstop. Uploaded evidence isolated the empty Photos marker,
  simulator Photo Library prompt, and transient volume app-stop addressed by
  this follow-up.
- Remote diagnostic: [Actions run 31288854362](https://github.com/srikanth235/centraid/actions/runs/31288854362)
  reached the serialized journey step with setup green. Its uploaded evidence
  showed that the Photos suite reused an empty replica before seeding, later
  launches could remain on the Expo launcher or SpringBoard, and the scroll
  probe could open the empty Photos takeover; the suite patch above addresses
  those lifecycle and seed-order causes.
- Remote diagnostic: [Actions run 31292436695](https://github.com/srikanth235/centraid/actions/runs/31292436695)
  kept setup green but failed the serialized iOS journeys before this latest
  recovery: native Photos rendered blank after its deep link, the frame probe
  stayed on Collections, the denied-permission flow stayed on SpringBoard, the
  library flow was blocked by the iOS Photo Library sheet, and repeated/reused
  launches ended in Expo's development-client launcher or a Home-ready timeout.
  The uploaded evidence is retained under the run's artifacts; this patch
  addresses each observed state rather than broadening assertions.
- Remote targeted matrix diagnostic: [Actions run 31300836677](https://github.com/srikanth235/centraid/actions/runs/31300836677)
  passed the native producer and isolated setup, then reproduced an iOS 26
  `simctl openurl` timeout on the second native surface while the Expo launcher
  visibly retained `http://127.0.0.1:8081`; the cached-card fallback above is
  the focused follow-up.
- Remote targeted follow-up: [Actions run 31304277261](https://github.com/srikanth235/centraid/actions/runs/31304277261)
  passed the producer and all isolated setup, then reached the bounded iOS
  fresh-ticket retry. Its evidence found a missing `retryableTapCommands`
  import in the post-#726 profile completion path; the import is restored here.
- Remote targeted follow-up: [Actions run 31306962706](https://github.com/srikanth235/centraid/actions/runs/31306962706)
  passed the producer and all setup, and the repaired relaunch reached the
  Photos cover. It then exposed that `centraid://docs` returned to a settled
  Home screen after the iOS confirmation; the uploaded screenshot and
  hierarchy drove the visible Home/All-apps navigation change above.
- Remote targeted follow-up: [Actions run 31308443933](https://github.com/srikanth235/centraid/actions/runs/31308443933)
  passed the producer and all setup, and the launcher route reached the Photos
  journey. Its hierarchy showed the selector had matched the empty-vault
  `Bring in photographs` import CTA, leaving the import surface blank instead
  of opening Photos; the screenshot drove the follow-up to select the named
  Photos/Docs rows from All apps for every affected journey.
- Remote targeted follow-up: [Actions run 31309798178](https://github.com/srikanth235/centraid/actions/runs/31309798178)
  passed the producer and isolated setup, and the All-apps sheet plus `Photos`
  search field worked. The iOS `hideKeyboard` step then dismissed the sheet's
  transparent scrim before the filtered row could be selected; the debug
  screenshot and command timeline drove removal of that step and the duplicate
  title tap from the launcher helper.
- Static verification of this follow-up: `bun run format:check`,
  `bun run lint:e2e-flows`, `bun run check:ui-receipt`,
  `bun run --cwd apps/mobile typecheck`, and `git diff --check` (PASS;
  2026-08-09).
- After restoring the literal volume assertion used by the matrix contract,
  `bun run test:matrix` and `bun run test:report:smoke` also pass (2026-08-09).
- The matrix workflow parses as YAML and the existing mobile flow/report
  contracts pass; targeted remote dispatches are used for failing iOS cells
  rather than repeating unrelated passing flows.

```sh
bun run format:check
bun run lint
bun run --cwd apps/mobile typecheck
bun run --cwd apps/mobile ci:bundle
bun run lint:e2e-flows
bun run test:matrix
bun run test:accessibility
```

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-09 | codex | 019fe264-a26e-7b13-bc59-366fb7760e9f |

## Audit

1. **REFUTED** — `## What changed` covers the main iOS/UI, retry-helper, smoke-flow, and 90-minute timeout edits, but omits material staged behavior: Android system-ANR dismissal, the fresh-launch control-channel retry in `home-loads.mjs`, and copying `scan-first-onboarding.png` to the UI-impact artifact path.
2. **PASS** — Each checked item is realized in the staged diff: `LogBox.ignoreAllLogs`, stable onboarding IDs, `codeRef`/blur/remount recovery, `active={onboarded === true}`, bounded retry/wait helpers with iOS fresh-ticket retry, and bounded producer/matrix workflow timeouts.
3. **REFUTED** — The `gh issue view 676` output contains no checklist items, while this receipt contains six checked and one unchecked items; the receipt checklist therefore does not mirror that issue output.

## Audit round

1. **REFUTED** — `## What changed` covers the timeout, LogBox suppression, stable onboarding IDs, compatibility gating, helper/harness retries, smoke-flow retry, screenshot copy, and flow documentation, but omits the new empty-ticket error path in `apps/mobile/src/screens/Onboarding.tsx` (`setError("Paste a pairing ticket first.")`) and the newly addressable Cancel control.
2. **PASS** — All six checked receipt items are realized in the staged diff: dev-only LogBox suppression; stable onboarding test IDs; native-input ref/blur and E2E remount recovery; post-onboarding compatibility gating; bounded pairing/capability retries; and the iOS timeout increase from 60 to 90 minutes.
3. **REFUTED** — `gh issue view 676` has no Markdown checkbox checklist. The receipt states that fact, but then adds seven local checkbox items, so its checklist does not mirror the issue's empty checklist.

## Audit round

1. **PASS** — `## What changed` covers every material non-receipt staged change: the 90-minute workflow cap; LogBox suppression; onboarding input recovery, the empty-ticket error, and the scanner Cancel accessibility label/role; compatibility-wall gating/retry; first-run and harness ANR, bounded-wait, recovery, and fresh-ticket retry behavior; scan-first flow retry and screenshot copying; and flow documentation.
2. **PASS** — `## Checklist` contains no Markdown checkbox items, so there are no checked items to validate; this is consistent with the issue's empty checklist.
3. **PASS** — `gh issue view 676` contains no Markdown checkbox checklist, and the receipt's `## Checklist` likewise contains no checkbox items, so the receipt checklist mirrors the issue.
