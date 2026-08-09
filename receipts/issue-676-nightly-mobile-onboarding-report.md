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
  has an explicit accessibility label and role. The profile field now follows
  the same uncontrolled native-value contract, with a stable test ID and event
  mirroring so a cold iOS retry cannot submit an empty React-side name.
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
- The cached Metro-card tap is explicitly best effort; the real contract remains
  the subsequent mandatory `Home ready` assertion, so a stale iOS hierarchy or
  an already-restored Home screen cannot create a false failure —
  `tests/agent-e2e-mobile/lib/first-run.mjs`.
- The same relaunch helper explicitly foregrounds the app after the optional
  deep link; iOS can report `simctl openurl` complete while SpringBoard remains
  foreground, leaving the cached Metro card unreachable —
  `tests/agent-e2e-mobile/lib/first-run.mjs`.
- The native cover matrix and permission/frame journeys avoid the flaky
  post-relaunch product URL handoff by opening Photos/Docs from Home and the
  remaining bundled covers through the searchable All-apps sheet —
  `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`,
  `flows/photos-permissions.mjs`, and `flows/scroll-frames.mjs`.
- `apps/mobile/src/screens/home/AllAppsSheet.tsx` queues app/place navigation
  until the native Modal interaction settles. This keeps a lazy cover such as
  People from losing its root-stack transition while the iOS launcher sheet is
  dismissing.
- The native Photos cover now gets the same bounded lazy-destination wait used
  by PR #683's Settings recovery: the launcher row is tapped once, then the
  flow waits up to 45 seconds for `Collections` rather than treating React's
  blank lazy-import fallback as a bad source-row tap —
  `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`.
- The Home All-apps control now has a dedicated `home-all-apps` test ID, and
  the shared iOS launcher helper retries that control up to three times while
  it remains visible. This prevents a transient press-animation hierarchy
  change from being mistaken for the native Modal opening, and prevents a
  recovery tap from landing on the Modal's non-interactive title —
  `apps/mobile/src/screens/home/HomeBand.tsx` and
  `tests/agent-e2e-mobile/lib/first-run.mjs`.
- The Settings leg now follows current `main`'s vault-sharing accessibility
  contract (`<vault> on <gateway>. Switch vault`) instead of the pre-#726
  `Open vault menu` label, while retaining the durable `APPEARANCE` destination
  marker — `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`.
- iOS launch recovery no longer probes for Android's system-ANR label while
  Expo is replacing its development-client hierarchy, and the cached Metro
  card gets a longer settle window. The native flow also accepts
  `MAESTRO_NATIVE_SURFACE=notes`, exposed as the manual `native-notes` lane,
  so a failed cover can be rerun without replaying already-green covers —
  `tests/agent-e2e-mobile/lib/first-run.mjs`,
  `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`, and
  `.github/workflows/e2e.yml`.
- The frame sampler now dismisses iOS's native `Open in “Centraid”?`
  confirmation immediately after arming its custom-scheme probe, reusing the
  shared confirmation helper instead of letting the alert mask the
  `perf-frame-sampling` marker — `tests/agent-e2e-mobile/flows/scroll-frames.mjs`.
- The scroll flow gives the lazy Photos full-screen cover the same 45-second
  destination budget as the native-cover matrix, so a completed launcher tap
  is not mistaken for a loaded grid while React is still leaving its blank
  fallback — `tests/agent-e2e-mobile/flows/scroll-frames.mjs`.
- The frame sampler keeps its deep-link hook for manual use but exposes a
  visible DEV-only `perf-frame-arm` control for Maestro. The iOS simulator can
  accept a custom-scheme URL while never delivering it to Expo Linking; the
  arm control avoids that system handoff, and its sampling/report nodes are
  explicit, non-collapsible accessibility targets —
  `apps/mobile/src/kit/perf/FrameProbe.tsx` and
  `tests/agent-e2e-mobile/flows/scroll-frames.mjs`.
- The DEV probe now lives in the left safe-area gutter and publishes its report
  through a non-collapsible accessible wrapper below the status bar. Expo's
  floating development-tools button occupies the upper-right gutter in CI, so
  the previous right-edge arm target opened the Expo menu instead of delivering
  `Pressable.onPress` — `apps/mobile/src/kit/perf/FrameProbe.tsx`.
- The DEV probe is now rendered by `PhotosScreen`, inside the native-stack
  screen that owns the Photos grid, rather than beside the navigator. Its
  transparent arm target uses a normal 44x44 touch surface, and its manual
  deep-link parser uses React Native Linking with a guarded `IS_DEV` check so
  importing the probe does not pull native-only Expo Linking into Vitest —
  `apps/mobile/src/apps/photos/PhotosScreen.tsx`,
  `apps/mobile/src/kit/perf/FrameProbe.tsx`, and `apps/mobile/App.tsx`.
- The scroll-frame flow now exits the Photos full-screen cover through its
  stable `Home` capsule before asking the Home launcher to open People; this
  preserves the launcher helper's Home-screen precondition without relying on
  iOS's flaky native swipe-down gesture —
  `tests/agent-e2e-mobile/flows/scroll-frames.mjs`.

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
- No pairing protocol changes are introduced; the launcher transition hardening
  is limited to dismissing its native sheet before routing.

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
- Remote targeted follow-up: [Actions run 31310928894](https://github.com/srikanth235/centraid/actions/runs/31310928894)
  passed the producer and isolated setup, but the fresh-ticket iOS retry failed
  before the native cover matrix: Maestro's profile input action completed while
  the controlled `Your name` value remained empty, and Continue showed the
  required-name error. The uploaded screenshot and timeline drove the stable
  profile-input ID, native event mirroring, and one bounded re-entry after that
  specific error.
- Remote targeted follow-up: [Actions run 31312504515](https://github.com/srikanth235/centraid/actions/runs/31312504515)
  passed producer/setup and the new profile contract (`You're all set, Nightly`),
  and the Photos launcher search row became visible. The filtered row was below
  iOS's still-open keyboard, so its repeated taps never dispatched the row's
  `onOpen`; the screenshot showed the Home scrim plus keyboard and the flow
  timed out on `Collections`. The helper now submits the search field to blur
  it without closing the Modal, then uses one bounded row tap.
- Remote targeted follow-up: [Actions run 31313771140](https://github.com/srikanth235/centraid/actions/runs/31313771140)
  passed producer/setup, fresh profile onboarding, and the Photos, Docs,
  Agenda, and Tasks covers. It then showed the filtered People row closing the
  launcher while the app remained on Home; the queued Modal-dismissal
  transition above is the focused fix for that late lazy-cover race.
- Remote targeted follow-up: [Actions run 31316023613](https://github.com/srikanth235/centraid/actions/runs/31316023613)
  passed producer/setup and opened Photos, Docs, and Agenda before reaching
  Tasks. It failed on a transient cached-Metro-card tap while the final
  screenshot already showed Home; that recovery tap is now optional while the
  `Home ready` assertion remains mandatory.
- Remote targeted follow-up: [Actions run 31317613589](https://github.com/srikanth235/centraid/actions/runs/31317613589)
  passed producer/setup and the fresh profile contract, then reached the
  Photos launcher row. The row tap completed, but the iOS screenshot remained
  on the blank Expo/React lazy-cover fallback and `Collections` timed out at
  30 seconds; the Photos destination budget is now bounded at 45 seconds.
- Remote targeted follow-up: [Actions run 31318973123](https://github.com/srikanth235/centraid/actions/runs/31318973123)
  passed producer/setup, onboarding, Photos, Docs, Agenda, Tasks, People, and
  Notes. It then exposed a separate intermittent launcher race at Tally: the
  More tap reported a hierarchy change but the All-apps Modal never appeared;
  the final screenshot was still Home. The shared launcher retry now targets a
  stable button ID and repeats only while that source remains visible.
- Remote targeted follow-up: [Actions run 31320863733](https://github.com/srikanth235/centraid/actions/runs/31320863733)
  passed producer/setup, onboarding, and all eight native covers through
  Locker. Settings alone failed because current `main` exposes the vault header
  as `Personal on Personal. Switch vault`, while the flow still selected the
  removed `Open vault menu` label; the failure screenshot remained on Home with
  the vault header visible. The selector now matches the stable `Switch vault`
  suffix.
- Remote targeted follow-up: [Actions run 31323313154](https://github.com/srikanth235/centraid/actions/runs/31323313154)
  passed producer/setup and all covers through People, then failed in Notes
  during the first post-relaunch overlay probe with
  `kAXErrorInvalidUIElement`; Maestro's XCUITest bridge hung until the bounded
  12-minute chunk timeout. The iOS recovery now omits that Android-only probe,
  waits longer after the Metro-card handoff, and exposes a `native-notes`
  diagnostic lane for focused verification.
- Remote focused verification: [Actions run 31325616874](https://github.com/srikanth235/centraid/actions/runs/31325616874)
  passed the iOS producer and isolated setup, completed fresh pairing/profile
  onboarding, opened the Notes cover with `Search notes`, and passed the
  process-restart `Home ready` check. The focused lane completed green in
  21m49s without replaying the other native covers.
- Full iOS matrix verification: [Actions run 31326960216](https://github.com/srikanth235/centraid/actions/runs/31326960216)
  passed the producer and `template-gate`, then exposed a stale scroll-flow
  contract after the current-main Photos redesign: `scroll-frames` waited for
  the removed `Search photos and moments` label even though the Library grid
  was fully rendered. The [debug artifact](https://github.com/srikanth235/centraid/actions/runs/31326960216/artifacts/9042059466)
  shows the Photos Library timeline with its `Search` band tab, so the flow now
  waits on a `photos-library-grid` marker attached to the actual timeline and
  will be rerun in isolation.
- Focused rerun: [Actions run 31328260027](https://github.com/srikanth235/centraid/actions/runs/31328260027)
  passed producer setup and moved past the stale Photos marker, then exposed a
  warm-launch race in `allow-device-permissions`: the screenshot in the
  [debug artifact](https://github.com/srikanth235/centraid/actions/runs/31328260027/artifacts/9042509827)
  showed Home with the paired vault still counting and no `Home ready` marker
  after the flow's raw 30-second wait. The frame flow now uses the shared iOS
  dev-client recovery and bounded Home-ready poll for that preflight, matching
  the canonical recovery used by the native-cover and Photos journeys.
- The next focused dispatch, [Actions run 31329844899](https://github.com/srikanth235/centraid/actions/runs/31329844899),
  reached the preflight but Maestro rejected the generated YAML before running
  it: the new explanatory lines were emitted as JavaScript `//` comments, while
  Maestro requires YAML `#` comments. The generated-flow comments are corrected
  and the same cell will be rerun.
- The valid-YAML rerun, [Actions run 31330876204](https://github.com/srikanth235/centraid/actions/runs/31330876204),
  reached the warm permission preflight but the newly added deep-link recovery
  aborted on iOS `NSPOSIXErrorDomain` code 60 while opening the Expo URL; the
  command's `optional: true` did not suppress Maestro's `openLink` timeout. The
  scroll flow now keeps the shared bounded Home-ready poll but skips that
  unnecessary deep link because pairing has already left it on Home; cold/native
  journeys retain the relaunch helper where they genuinely need Metro recovery.
- Focused rerun [Actions run 31332177873](https://github.com/srikanth235/centraid/actions/runs/31332177873)
  passed the warm permission preflight, current Photos Library marker, and
  launcher route, then failed only when the `perf-frames` custom scheme raised
  iOS's native `Open in “Centraid”?` alert over the Photos grid. The debug
  [artifact](https://github.com/srikanth235/centraid/actions/runs/31332177873/artifacts/9043570725)
  shows the app was healthy beneath the alert; the sampler arm now reuses the
  shared `^Open$` dismissal before asserting `perf-frame-sampling`.
- Focused rerun [Actions run 31333688363](https://github.com/srikanth235/centraid/actions/runs/31333688363)
  exercised the new native-confirmation dismissal path, then exposed a
  separate lazy-cover timing race: `Open Photos.*` completed, but the screenshot
  in [artifact 9044114079](https://github.com/srikanth235/centraid/actions/runs/31333688363/artifacts/9044114079)
  remained on the blank fallback and `Collections` timed out at 30 seconds.
  The scroll flow now uses the native matrix's 45-second destination budget.
- Focused rerun [Actions run 31335420164](https://github.com/srikanth235/centraid/actions/runs/31335420164)
  passed the warm preflight, current Photos Library marker, lazy-cover wait, and
  the native `Open` confirmation dismissal, but the `perf-frame-sampling` marker
  never appeared. The [debug artifact](https://github.com/srikanth235/centraid/actions/runs/31335420164/artifacts/9044415535)
  showed the healthy Photos grid beneath the handoff: iOS accepted the
  `centraid://perf-frames` URL without delivering it to Expo Linking. The
  sampler now uses PR #683's DEV arm control and iOS-visible marker contract;
  the targeted scroll lane will verify it before the full matrix is dispatched.
- Local verification of the PR-derived arm path passes the mobile unit suite
  (133 files, 1,086 tests), flow lint, formatting, TypeScript, and syntax
  checks. The first pre-push pass caught the repository's 11px native type
  floor on the sampler readout; `fontSize` is now 11px and the gate will be
  rerun before publishing.
- Focused arm rerun [Actions run 31336883074](https://github.com/srikanth235/centraid/actions/runs/31336883074)
  reached the current Photos grid but failed immediately because
  `perf-frame-arm` was absent from the XCUITest hierarchy. The debug
  [artifact](https://github.com/srikanth235/centraid/actions/runs/31336883074/artifacts/9044880464)
  showed the grid was presented as a native root-stack cover; the root-level
  probe was consequently behind it. The probe now lives inside Photos and
  People cover hierarchies, matching PR #683's native-stack placement.
- Focused cover-local rerun [Actions run 31338132931](https://github.com/srikanth235/centraid/actions/runs/31338132931)
  confirmed that Maestro could find and tap `perf-frame-arm`, then failed while
  waiting for the report. The debug [artifact](https://github.com/srikanth235/centraid/actions/runs/31338132931/artifacts/9045204926)
  captured Expo's floating developer menu after the right-edge tap at
  `[386,72][398,84]`; the sampler itself was never armed. The arm target now
  uses the left gutter and the report has its own explicit accessible wrapper.
- Focused rerun [Actions run 31339333718](https://github.com/srikanth235/centraid/actions/runs/31339333718)
  validated the probe fix end to end for Photos: Maestro found and tapped the
  arm target, the report became visible, and the report text was copied. It
  then exposed a separate flow precondition: People was requested while the
  Photos full-screen cover was still presented, so `home-all-apps` was absent.
  The debug [artifact](https://github.com/srikanth235/centraid/actions/runs/31339333718/artifacts/9045618135)
  drove the explicit Photos `Home`-capsule exit above.
- Focused rerun [Actions run 31340503864](https://github.com/srikanth235/centraid/actions/runs/31340503864)
  reproduced an intermittent version of the arm race: Maestro found
  `[4,72][16,84]`, tapped `perf-frame-arm`, and completed all eight flings, but
  no `perf-frame-report` appeared. The failure screenshot in [debug artifact
  9045978442](https://github.com/srikanth235/centraid/actions/runs/31340503864/artifacts/9045978442)
  showed a healthy Photos grid, so the issue was the tiny sibling hit target's
  native-stack responder path rather than the grid or sampler budget. The
  probe is now owned by `PhotosScreen`, uses a 44x44 transparent target, and
  keeps the test import-safe; the focused lane will verify this targeted fix.
- Local verification of the queued launcher transition:
  `bun run --cwd apps/mobile typecheck`, `bun run --cwd apps/mobile test`, and
  `bun run --cwd apps/mobile ci:bundle` (PASS; 2026-08-09).
- Local verification of the probe relocation: `bun run format:check`,
  `bun run lint:e2e-flows`, `bun run check:ui-receipt`,
  `bun run lint:type-floor`, `bun run --cwd apps/mobile typecheck`, and
  `bun run --cwd apps/mobile test` (PASS; 133 files, 1,086 tests; 2026-08-10).
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
