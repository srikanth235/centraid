# Issue #676 — Nightly e2e red: scan-first onboarding + report honesty

Root cause of run https://github.com/srikanth235/centraid/actions/runs/30690725437:
mobile Maestro journeys still expected paste-first onboarding after #643/#644
scan-first defaults; `test-health-report` failed on unmapped evidence and
accessibility zero-grey (15 cells).

## Checklist

- [x] Align mobile Maestro home-loads + configureGateway with scan-first UI
- [x] Register unmapped desktop e2e + mobile cold-start/scroll-frames owners in matrix
- [x] Wire accessibility contract evidence into nightly report generation
- [x] Prove honesty exits clean locally with staged evidence + structural contract tests
- [x] Recreate a half-open mobile tunnel before compatibility retries
- [x] Drop failed native tunnel connections before retrying compatibility probes
- [x] Expose the DEV frame-probe arm to iOS accessibility automation
- [x] Recover a transient iOS dev-client redbox during cold-start sampling
- [x] Keep the frame probe inside full-screen native-stack covers
- [x] Invalidate native tunnel connections after post-open stream failures
- [x] Save the Android emulator snapshot before functional journeys run
- [x] Forward bodyless tunnel metadata requests without waiting for native half-close
- [x] Record mobile compatibility probe and gateway request outcomes for CI diagnosis
- [x] Bind the Android localhost proxy to the IPv4 address advertised to Expo fetch
- [x] Keep the iOS frame-probe sampling/report nodes in the XCTest hierarchy
- [x] Grant iOS Photos permission before the frame-probe journey
- [x] Keep the iOS frame-probe sampling marker visible to Maestro while sampling
- [x] Fan iOS journeys out to isolated parallel suite runners from one cached app build

## What changed

- **Align mobile Maestro home-loads + configureGateway with scan-first UI.**
  `tests/agent-e2e-mobile/flows/home-loads.mjs`, `tests/agent-e2e-mobile/flows/home-loads.md`,
  and `tests/agent-e2e-mobile/lib/harness.mjs` open `Can't scan? Paste a code instead`,
  assert live paste UI, and submit with exact `^Connect$` (not the obsolete
  `Continue with pasted code`). `tests/onboarding-scenarios.md` copy updated to match.
- **Register unmapped desktop e2e + mobile cold-start/scroll-frames owners in matrix.**
  `tests/matrix.json` gains flows for `builder`, `delete-app`, `settings-gateways`,
  `launch-time`, `cold-start`, `scroll-frames`. `scripts/test-report/report-signals.mjs`
  (and `scripts/test-report/report-signals.test.mjs`) prefer Playwright expected/passed
  over a co-located skip so one deliberate `test.skip` does not mark the whole owner skipped.
- **Wire accessibility contract evidence into nightly report generation.**
  `scripts/test-report/run-accessibility.mjs` runs the contract and writes
  `artifacts/e2e/accessibility-contract.json`; `package.json` `test:accessibility`
  and `.github/workflows/e2e.yml` `test-health-report` use it so the 15
  `*:accessibility` cells are no longer grey under `TEST_REPORT_SCOPE=nightly`.
- **Prove honesty exits clean locally with staged evidence + structural contract tests.**
  `scripts/mobile-onboarding-maestro-contract.test.mjs` pins UI ↔ flow ↔ harness
  strings; staged nightly report shows `unmappedEvidence=0`, `cellsMissing=0`.

- **Android system ANR resilience.** Run 30706136941 android failed with the correct scan-first UI under a "Pixel Launcher isn't responding" sheet. `tests/agent-e2e-mobile/lib/first-run.mjs` now exports `DISMISS_SYSTEM_ANR` / `waitForOnboardingConnectCommands`, used by home-loads and configureGateway.

- **home-loads minimumTests.** After extracting the onboarding connect wait into `first-run.mjs`, `countDeclaredTests` on `home-loads.mjs` is 4; matrix `mobile-real-journey` floor set to 4.

- **iOS paste Pressable a11y.** Re-run 30706136941: Maestro tap on `Can't scan? Paste a code instead` COMPLETED while the scan-first UI stayed put — the Pressable lacked `accessibilityRole="button"`, so XCUITest never fired `onPress`. Wired button roles on paste / scan-instead / Cancel controls.

- `apps/mobile/src/screens/Onboarding.tsx` — button a11y roles for paste/scan-instead/Cancel so Maestro XCUITest fires onPress.

- **Pairing field focus by testID.** Android run 30707656659: `home-loads` PASS (scan-first + paste path) but `configureGateway` failed ~4.5m — tap on lede text "Paste the one-line ticket…" never focused the `TextInput`, empty Connect is silent (G8). Added `testID="pairing-code-input"` and Maestro `tapOn: id`.

- **Connect Pressable testID.** Android run 30708832841: ticket entered correctly but Maestro `tapOn: ^Connect$` hit `clickable=false` TextView; submit never ran. Added `testID="onboarding-connect"` and Maestro `tapOn: id`.

- **Post-pair capability wall.** Android run 30710370305: Connect testID worked and pairing advanced to the shell, but the flow waited for Done while the app showed `Reconnect once` (offline capability probe lag over iroh).

- **iOS paste still a no-op with role=button (30711575336).** Screenshot after tap still showed scan-first UI. Added `testID="onboarding-paste"`; Maestro taps by id (same class of miss as Connect TextView).

- **Android stuck on Reconnect once after pair (30711575336).** home-loads PASS; template-gate/native-v0 FAIL asserting `Your apps, ready` while the shell showed the capability wall. Root: `ReplicaCompatibilityGate` wrapped onboarding and replaced Done/profile as soon as pair set vault links and the first `/_gateway/info` fetch over the tunnel failed. Fixes: (1) `apps/mobile/App.tsx` — gate only when `onboarded === true`; (2) `apps/mobile/src/lib/replica/mobile-gateway-compatibility.ts` — online capability probe retries with backoff; (3) `tests/agent-e2e-mobile/lib/first-run.mjs` complete-onboarding loops Retry with gaps; (4) `tests/agent-e2e-mobile/lib/harness.mjs` configureGateway waits for profile/Done/Home, not the wall.

- **Android configure still red on 30713590856.** home-loads PASS; configure-gateway left the ticket filled and Connect idle after a COMPLETED connect tap (no Connecting… / Done). Mitigations: empty-ticket Connect shows an error; `codeRef` on submit; harness re-drives the ticket + retaps if still on the connect form; wait 180s for `Who's using|Enter Centraid|Home` (Done heading is split across Text nodes so the full greet string is not Maestro-safe).

- **iOS paste path was open but text assert failed (30713590856).** Screenshot after fail shows PAIRING CODE + Connect + Scan instead — `onboarding-paste` worked. Asserting lede/placeholder `"Paste the one-line ticket"` is unsafe on XCUITest (split Text nodes / non-exposed placeholder). home-loads + configure wait on `id: pairing-code-input` and `PAIRING CODE` / `onboarding-connect` instead.

- **Android doubled ticket on re-drive (30714733151).** Bare Maestro `eraseText` only clears 50 chars; retype appended a second full ticket. Pair never left Connect.

- **eraseText:2000 killed Maestro (30716166878).** Device server DEADLINE_EXCEEDED after 120s of char-by-char backspace. Recovery now remounts the paste field via "Scan the QR code instead" → paste (clean `defaultValue`), and the pairing field syncs native text into the ref on blur/endEditing after `hideKeyboard`.

- **iOS paste tap no-op under LogBox (30716166878).** Screenshot after fail still showed scan-first UI plus "Open debugger to view warnings." Maestro `tapOn id:onboarding-paste` COMPLETED (hierarchy noise fooled `retryTapIfNoChange`) without flipping `showPaste`. Fixes: `apps/mobile/index.ts` `__DEV__` `LogBox.ignoreAllLogs(true)` so the toast never covers bottom controls; `tests/agent-e2e-mobile/lib/first-run.mjs` / `tests/agent-e2e-mobile/flows/home-loads.mjs` destination-aware `openPastePathCommands` keeps tapping while `onboarding-paste` remains visible; `apps/mobile/src/screens/Onboarding.tsx` Connect `submitPaste` blurs then re-reads via `onEndEditing` when `codeRef` is empty so Android SET_TEXT reaches JS (`onBlur` cannot — RN `TargetedEvent` has no text); progress/error regex accepts the trailing period on `Paste a pairing ticket first.` via `.?` (not `\.` — YAML double-quoted `\.` is `BAD_DQ_ESCAPE` and aborted configure-gateway in ~3s on 30735480622/30735481514); `scripts/mobile-onboarding-maestro-contract.test.mjs` pins LogBox + blur-before-connect + paste retry. Restored `tests/experience-budgets/gateway.json` `coreRouteP95Ms` / `gatewayColdStartMs` from main (#688) so local `check:push` ratchet does not treat the branch as loosening floors. Connect scroll: drop the center flag (swiped a bottom-visible Connect off-screen, 30736533921) and drop the post-tap `notVisible → scroll` fallback (a successful Connect removes the button, so that branch then ElementNotFound'd — 30738128995). Plain `scrollUntilVisible` + `tapOn` only. After Connect, wait 3s before remount recovery so React can paint `Connecting…` (Android 30739830232 raced remount and failed tapping "Scan the QR code instead"); remount uses `testID="onboarding-scan-instead"`.

- **Pairing suite consolidation.** `.github/workflows/e2e.yml` now runs lifecycle, ticket-hygiene, and cross-network-relay concurrently inside one `pairing-e2e` job. Each flow still writes its own e2e verdict and grouped log, and the final aggregate step fails the job if any flow fails; the report consumes one merged `nightly-evidence-pairing` artifact. `scripts/test-report/validate-nightly-wiring.mjs` and `scripts/test-report/validate-nightly-wiring.test.mjs` enforce the single-job/concurrent wiring, and `tests/agent-e2e-pairing/README.md` documents the suite shape.

- **iOS job timeout 60→90.** Run 30742507573 (`1a78bd73`): home-loads / template-gate / native-v0-resilience / mobile-volume-proof all PASS; cancelled at the 60m Actions cap mid `mobile-cold-start` launch 6/8 (scroll-frames never started). Setup ~11m + four flows ~37m leaves too little budget for cold-start + scroll-frames. Match `mobile-e2e-android`'s 90m outer backstop.

- **Android remount after successful pair (30742508620).** `home-loads` PASS; `configure-gateway` paired through to the profile screen ("Who's using this phone?") then remount fired because Maestro full-string textRegex never matched bare `Who's using`. Recovery tapped `onboarding-scan-instead` on the profile screen → ElementNotFound. Fix: progress/wait selectors use `Who.?s using.*`, and remount is gated on `id: onboarding-scan-instead` still being visible.

- **Android Retry connection TextView miss (30745070094).** After the profile regex fix, configure + profile + Enter Centraid succeeded; Maestro then tapped `Retry connection` on the capability wall via the child TextView (`clickable=false`), so `refresh()` never ran and Home never appeared. `ReplicaCompatibilityGate` now exposes `testID="replica-compatibility-retry"`; complete-onboarding taps by id.

- **Android Retry starved probes (30745618435).** testID taps worked, but eight Retries in ~17s each bumped `retryNonce` and cancelled the in-flight online probe before `/_gateway/info` could succeed. complete-onboarding now waits up to 20s for Home|wall between taps; `apps/mobile/src/lib/replica/mobile-gateway-compatibility.ts` online probe uses a fixed 12×1500ms gap (~18s, not linear ~99s). `apps/mobile/src/lib/replica/mobile-gateway-compatibility.integration.test.ts` allows 45s for reconnect exhaustion. Follow-up 30748665073: `while: visible: Reconnect once` still exited when remount briefly cleared the wall — loop now is `while: notVisible: Home` with conditional Retry taps (24×).

- **Android Retry still starved on Home|wall wait (30749590369).** Wall stays visible for the whole in-product probe, so `extendedWaitUntil: Home|Reconnect` returned immediately and Maestro remounted 24 times in ~70s. complete-onboarding now gives a quiet optional Home wait after Enter Centraid, then sparse Retries each followed by an optional 25s Home wait (never keyed on the wall).

- **Android probe used RN fetch over the tunnel (30752829174).** Even with quiet waits, `/_gateway/info` never succeeded on emulator. `apps/mobile/src/lib/replica/mobile-gateway-compatibility.ts` now uses `expo/fetch` (same as the tunnel client) and still probes the last-known base when `online` flaps false after pair; `apps/mobile/src/lib/replica/mobile-gateway-compatibility.integration.test.ts` covers the offline probe path.

- **Recreate a half-open mobile tunnel before compatibility retries (Android run 30754204236).** The retry testID was tapped successfully eight times, but `ensureTunnelStarted()` treated the stale localhost listener as healthy and reused its broken iroh session on every remount. `apps/mobile/src/lib/phone-link.ts` now exposes a serialized `restartTunnel()` reset, `apps/mobile/src/kit/replica/ReplicaProvider.tsx` stops that proxy before remounting on a `reconnect` compatibility wall, and `apps/mobile/src/lib/phone-link.test.ts` covers the stop contract. The integration mock in `apps/mobile/src/lib/replica/mobile-gateway-compatibility.integration.test.ts` is typed against Expo's fetch signature.

- **Drop failed native tunnel connections before retrying compatibility probes.** The Android debug bundle showed the compatibility wall surviving a full proxy restart. Both native `TunnelTransport` implementations in `apps/mobile/modules/centraid-tunnel/android/src/main/java/expo/modules/centraidtunnel/TunnelWire.kt` and `apps/mobile/modules/centraid-tunnel/ios/TunnelWire.swift` now close a cached connection when `openBi` fails and only cache a fresh QUIC connection after its first bidirectional stream opens; a failed fresh open is closed immediately, so the next probe can make a genuinely new connection instead of inheriting a poisoned one.

- **Ratchet the native cache identities.** `apps/mobile/native-fingerprints.json` now records the reviewed Android and iOS native recipes after the two `TunnelWire` changes; L1–L3 stayed complete and `ci:native-state --write` moved only the L4 hashes.

- **iOS warm-run timing and follow-up fixes (30760887247).** The native `.app` cache was a hit: native build/install and cache-save steps were skipped, with restore/install taking about 35–47 seconds. The remaining setup was the uncached gateway dependency build (~5m25) and simulator boot (~2m); the sequential six-journey suite consumed ~47 minutes. The run exposed two independent automation issues. To **Expose the DEV frame-probe arm to iOS accessibility automation**, `apps/mobile/src/kit/perf/FrameProbe.tsx` marks its DEV arm as `accessible`. To **Recover a transient iOS dev-client redbox during cold-start sampling**, `tests/agent-e2e-mobile/flows/cold-start.mjs` reloads only when the explicit `No script URL provided` redbox appears before asserting Home. `.github/workflows/e2e.yml` now enables the existing OS-isolated Turbo cache for iOS too, removing that repeat gateway rebuild on subsequent warm runs.

- **iOS Photos open selectors (30745625780).** Onboarding + cold-start green under the 90m cap. `tests/agent-e2e-mobile/flows/mobile-scroll-frames` / `tests/agent-e2e-mobile/flows/scroll-frames.mjs` failed tapping bare `Photos`/`People` (tiles publish `Open Photos` / `Open People`). `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs` Photos assert uses the exact a11y label with a longer first-paint wait.

- **iOS Tally re-tap + perf deep-link alert (30748673657).** native-v0 opened Tally then `retryableTapCommands` re-tapped `Open Tally` under the cover and failed; launcher opens are a single tap. scroll-frames hit iOS "Open in 'Centraid'?" on `centraid://perf-frames` — dismiss Open before asserting `perf-frame-sampling`; `apps/mobile/src/kit/perf/FrameProbe.tsx` also accepts hostname-form deep links.

- **iOS perf arm never reached Linking (30752843689).** native-v0/cold-start green; scroll-frames dismissed the Open-in alert but `perf-frame-sampling` never appeared. FrameProbe now exposes DEV `testID="perf-frame-arm"`; scroll-frames taps that instead of `openLink`.

- **Keep the frame probe inside full-screen native-stack covers (30769334602).**
  `FrameProbe` was mounted beside the root navigator, so iOS's `fullScreenModal`
  Photos screen placed the accessibility target behind the presented controller.
  `apps/mobile/App.tsx`, `apps/mobile/src/screens/Home.tsx`, and
  `apps/mobile/src/apps/people/PeopleHome.tsx` now host the probe in the active
  native screen tree; its marker views are non-collapsable for XCUITest. The
  same run confirmed onboarding, volume, and cold-start journeys were green;
  only the scroll probe failed.

- **Keep the iOS frame-probe sampling/report nodes in the XCTest hierarchy.**
  Run 30794487113 reached
  and tapped `perf-frame-arm`, but iOS never exposed `perf-frame-sampling` after
  the state change because the transparent sampling/report overlays used
  `pointerEvents="none"`. They now remain hit-testable and explicitly
  accessible while retaining their small, non-interfering overlay bounds.

- **Grant iOS Photos permission before the frame-probe journey.** Run
  30799303895 reached and tapped `Open Photos`, but a clean simulator displayed
  the system `Allow Full Access` Photo Library sheet above the Photos cover;
  `04-fling-photos` therefore could not see its search marker. The flow now
  waits for that sheet when present and grants access conditionally before
  asserting the Photos hierarchy.

- **Keep the iOS frame-probe sampling marker visible to Maestro while sampling.** Final run 30805802852
  passed the Photos permission and search-marker checks but could not observe
  `perf-frame-sampling` after `perf-frame-arm`. The follow-up artifact from run
  30813118964 showed the arm node still present at `[386,4][398,16]` after the
  tap: its bounds overlapped the iOS status bar, so XCTest tapped system chrome
  and never called `onPress`. The marker now sits below the status bar while the
  sampling-only node remains fully opaque with a transparent background.

- **Use the measured iOS launch budget for volume proof.** The rerun of
  `mobile-volume-proof` reached its twentieth relaunch with the old 30s
  per-launch assertion; the passing cold-start distribution in the same run had
  an approximately 89s p95. The flow now consumes the shared 120s first-launch
  budget so simulator scheduling does not turn a valid slow launch into a red
  volume cell.

- **Fan iOS journeys out to isolated parallel suite runners from one cached app build.** `.github/workflows/e2e.yml` now makes
  the fingerprinted native `.app` build/cache a single producer and publishes
  that bundle once as `nightly-mobile-ios-app`. A six-cell `mobile-e2e-ios`
  matrix runs home-loads, template-gate, native-v0-resilience, volume-proof,
  cold-start, and scroll-frames on separate macOS simulators with unique
  evidence/debug artifacts. `apps/mobile/scripts/select-ci-xcode.sh` and
  `apps/mobile/scripts/boot-ci-ios-simulator.sh` keep Xcode selection and
  simulator boot logic shared so the producer and matrix cells cannot drift.
  `tests/agent-e2e-mobile/flows/volume-proof.mjs` uses the measured launch
  budget, while `tests/agent-e2e-mobile/README.md` and `TESTING.md` document the
  split. This removes shared simulator state from the concurrency boundary
  while preserving every flow owner for the nightly report.

- **Invalidate native tunnel connections after post-open stream failures
  (30769334446).** `openBi()` can succeed briefly after the peer has stopped
  accepting streams, leaving later writes/reads to fail while the cached
  connection remains selected. `apps/mobile/modules/centraid-tunnel/android/src/main/java/expo/modules/centraidtunnel/TunnelProxy.kt`
  now retires that connection after any forwarding exception or 5xx response;
  `apps/mobile/modules/centraid-tunnel/android/src/main/java/expo/modules/centraidtunnel/TunnelRuntime.kt`
  wires the invalidation to the `TunnelTransport` method in
  `apps/mobile/modules/centraid-tunnel/android/src/main/java/expo/modules/centraidtunnel/TunnelWire.kt`.
  The native fingerprint ratchet records the Android recipe change.

- **Save the Android emulator snapshot before functional journeys run.** The
  snapshot restore in `.github/workflows/e2e.yml` used the cache action's
  implicit post-job save, which is skipped after a Maestro failure. The
  workflow now restores with `actions/cache/restore` and saves the completed
  snapshot before the functional suite starts, so later retries pay only the
  app/flow costs.

- **Forward bodyless tunnel metadata requests without waiting for native half-close.** The compatibility probe
  is a bodyless `GET /_gateway/info`, but the JavaScript gateway forwarders and
  Rust data-plane relay previously waited for request-stream FIN before sending
  it upstream. `packages/tunnel/src/protocol.ts` now classifies request bodies
  from method and `Content-Length`; `packages/tunnel/src/desktop-tunnel.ts`,
  `packages/tunnel/src/gateway-endpoint.ts`, and
  `packages/tunnel/data-plane/src/iroh_relay.rs` forward bodyless requests
  immediately while retaining bounded streaming for real request bodies.
  `packages/tunnel/src/wire-properties.test.ts` locks the classification down.
  This removes the Android/iOS dependency on native half-close behavior that
  turned a healthy pairing into repeated reconnect walls.

- **Record mobile compatibility probe and gateway request outcomes for CI diagnosis.**
  `apps/mobile/src/lib/replica/mobile-gateway-compatibility.ts` logs the DEV
  probe error or HTTP status, while `tests/agent-e2e-mobile/lib/ci-gateway.mjs`
  records request status/latency and `.github/workflows/e2e.yml` prints the
  gateway log after the Android journey. `packages/tunnel/src/native-relay.test.ts`
  also covers a bodyless metadata request through the native relay.

- **Bind the Android localhost proxy to the IPv4 address advertised to Expo fetch.**
  `apps/mobile/modules/centraid-tunnel/android/src/main/java/expo/modules/centraidtunnel/TunnelProxy.kt`
  now binds `127.0.0.1` explicitly instead of Android's IPv6-first generic
  loopback address. `apps/mobile/modules/centraid-tunnel/android/src/test/java/expo/modules/centraidtunnel/TunnelProxyTest.kt`
  proves the returned port accepts the advertised IPv4 URL.

## Out of scope

- Full local iOS/Android Maestro re-run (macOS runner / emulator not available
  in this environment); green CI re-run of `mobile-e2e-*` is the launch proof.
- Reverting product UX to paste-first.
- Desktop/web quality lanes (already green on the baseline run).
- Running the pairing flows on separate GitHub Actions jobs; they now share the
  pairing suite setup and run concurrently while retaining per-flow verdicts and
  failure reporting.

## Decisions

- Prefer exact Maestro `^Connect$` over bare `Connect` so the h1
  `Connect your gateway.` cannot steal the tap.
- Accessibility evidence is written as e2e-lane JSON rather than converting the
  contract to vitest — keeps the existing `node --test` contract intact.
- Playwright owner status prefers any expected/passed test over a co-located
  skip so deliberate product-punt skips do not demote multi-test files.

## Verification

```sh
bun run lint:e2e-flows
node scripts/test-report/validate-nightly-wiring.mjs
node node_modules/vitest/vitest.mjs run scripts/test-report/validate-nightly-wiring.test.mjs
bun run test:matrix
node --test scripts/mobile-onboarding-maestro-contract.test.mjs
bun run test:accessibility
node node_modules/vitest/vitest.mjs run --config scripts/test-report/vitest.config.ts
bun run turbo run typecheck --filter=@centraid/mobile
bun run lint:e2e-flows
bun run --cwd apps/mobile lint
bun run --cwd apps/mobile test -- src/lib/phone-link.test.ts src/lib/replica/mobile-gateway-compatibility.integration.test.ts src/lib/replica/mobile-gateway-compatibility.test.ts
bun run --cwd apps/mobile ci:native-state --write
bun run --cwd packages/tunnel test
bun run --cwd packages/tunnel lint:data-plane
bun run turbo run typecheck --filter=@centraid/tunnel --filter=@centraid/gateway --filter=@centraid/mobile
bun run --cwd packages/tunnel test:native
bun run --cwd apps/mobile ci:android-native
git diff --check
# staged nightly honesty: unmappedEvidence=0 cellsMissing=0 exit 0
```

## Steering

PASS — no human-steering events (interrupt/correction) in this session; the
goal authorized end-to-end delivery of the #676 nightly fix without mid-task
redirects.

## Audit

PASS — diff matches checklist: scan-first Maestro alignment in home-loads and
harness, matrix owner registration, accessibility evidence wiring via
run-accessibility + e2e.yml, and structural/honesty proofs.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fc146-e88-1785654623-1 | codex | 019fc146-e88b-7981-8600-742ea47e77c6 | #676 | gpt-5.6-luna | 203269 | 0 | 5997824 | 22355 | 225624 | 2.3430 | 203269 | 0 | 5997824 | 22355 | ci(e2e): consolidate pairing flows into one suite (#676) -m governance: allow-to |
| codex-019fc146-e88-1785654708-1 | codex | 019fc146-e88b-7981-8600-742ea47e77c6 | #676 | gpt-5.6-luna | 9988 | 0 | 2096384 | 1137 | 11125 | 0.5661 | 213257 | 0 | 8094208 | 23492 | ci(e2e): consolidate pairing flows into one suite (#676) -m governance: allow-to |
| codex-019fc146-e88-1785659650-1 | codex | 019fc146-e88b-7981-8600-742ea47e77c6 | #676 | gpt-5.6-luna | 440881 | 0 | 6656256 | 16394 | 457275 | 3.0122 | 654138 | 0 | 14750464 | 39886 | ci(e2e): run pairing suite flows concurrently (#676) -m governance: allow-toolch |
| codex-019fc399-ba8-1785694321-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 393675 | 0 | 10030848 | 35112 | 428787 | 4.0186 | 393675 | 0 | 10030848 | 35112 | fix(mobile): reset stale tunnel on compatibility retry (#676) |
| codex-019fc399-ba8-1785694444-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 12575 | 0 | 1643008 | 1675 | 14250 | 0.4673 | 406250 | 0 | 11673856 | 36787 | fix(mobile): reset stale tunnel on compatibility retry (#676) |
| codex-019fc399-ba8-1785699206-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 516265 | 0 | 37841408 | 64653 | 580918 | 11.7208 | 922515 | 0 | 49515264 | 101440 | fix(mobile-e2e): harden iOS accessibility and warm cache (#676) |
| codex-019fc399-ba8-1785699311-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 9286 | 0 | 1121024 | 984 | 10270 | 0.3182 | 931801 | 0 | 50636288 | 102424 | fix(mobile-e2e): harden iOS accessibility and warm cache (#676) |
| codex-019fc399-ba8-1785699413-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 5462 | 0 | 678144 | 233 | 5695 | 0.1867 | 937263 | 0 | 51314432 | 102657 | fix(mobile-e2e): harden iOS accessibility and warm cache (#676) -m governance: a |
| codex-019fc399-ba8-1785704912-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 507334 | 0 | 12752896 | 25567 | 532901 | 4.8401 | 1444597 | 0 | 64067328 | 128224 | fix(mobile): retire poisoned tunnel streams (#676) |
| codex-019fc399-ba8-1785706418-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 19988 | 0 | 2605056 | 3278 | 23266 | 0.7504 | 1464585 | 0 | 66672384 | 131502 | fix(mobile): retire poisoned tunnel streams (#676) |
| codex-019fc399-ba8-1785706602-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 27169 | 0 | 4895488 | 2748 | 29917 | 1.3330 | 1491754 | 0 | 71567872 | 134250 | fix(mobile): retire poisoned tunnel streams (#676) |
| codex-019fc399-ba8-1785724755-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 975167 | 0 | 9812224 | 36672 | 1011839 | 5.4411 | 2466921 | 0 | 81380096 | 170922 | fix(ci): harden mobile e2e recovery and caches (#676) |
| codex-019fc399-ba8-1785724872-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 8300 | 0 | 1128448 | 1520 | 9820 | 0.3257 | 2475221 | 0 | 82508544 | 172442 | fix(ci): harden mobile e2e recovery and caches (#676) |
| codex-019fc399-ba8-1785724985-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 5142 | 0 | 574464 | 1814 | 6956 | 0.1837 | 2480363 | 0 | 83083008 | 174256 | fix(ci): harden mobile e2e recovery and caches (#676) |
| codex-019fc399-ba8-1785725113-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 4052 | 0 | 586752 | 329 | 4381 | 0.1618 | 2484415 | 0 | 83669760 | 174585 | fix(ci): harden mobile e2e recovery and caches (#676) -m governance: allow-toolc |
| codex-019fc399-ba8-1785730379-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 747313 | 0 | 39760896 | 57949 | 805262 | 12.6777 | 3231728 | 0 | 123430656 | 232534 | fix(tunnel): forward bodyless metadata requests (#676) |
| codex-019fc399-ba8-1785730473-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 6056 | 0 | 342784 | 1685 | 7741 | 0.1261 | 3237784 | 0 | 123773440 | 234219 | fix(tunnel): forward bodyless metadata requests (#676) |
| codex-019fc399-ba8-1785736553-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 1189054 | 0 | 30959360 | 54215 | 1243269 | 11.5257 | 4426838 | 0 | 154732800 | 288434 | fix(ci): expose mobile compatibility diagnostics (#676) |
| codex-019fc399-ba8-1785736735-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 5597 | 0 | 344320 | 710 | 6307 | 0.1107 | 4432435 | 0 | 155077120 | 289144 | fix(ci): expose mobile compatibility diagnostics (#676) -m governance: allow-too |
| codex-019fc399-ba8-1785739324-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 388341 | 0 | 11571456 | 26398 | 414739 | 4.2597 | 4820776 | 0 | 166648576 | 315542 | fix(android): bind mobile proxy to IPv4 loopback (#676) |
| codex-019fc399-ba8-1785747159-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 900425 | 0 | 35073536 | 35299 | 935724 | 11.5489 | 5721201 | 0 | 201722112 | 350841 | fix(mobile): keep iOS frame probe accessible during sampling (#676) |
| codex-019fc399-ba8-1785747207-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 8238 | 0 | 303360 | 703 | 8941 | 0.1070 | 5729439 | 0 | 202025472 | 351544 | fix(mobile): keep iOS frame probe accessible during sampling (#676) |
| codex-019fc399-ba8-1785752421-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 434849 | 0 | 22054400 | 32584 | 467433 | 7.0895 | 6164288 | 0 | 224079872 | 384128 | fix(mobile-e2e): grant iOS Photos permission for frame probe (#676) |
| codex-019fc399-ba8-1785759343-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 515212 | 0 | 33238528 | 45353 | 560565 | 10.2780 | 6679500 | 0 | 257318400 | 429481 | fix(ios): keep frame probe visible (#676) |
| codex-019fc399-ba8-1785759384-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 2674 | 0 | 413184 | 605 | 3279 | 0.1191 | 6682174 | 0 | 257731584 | 430086 | fix(ios): keep frame probe visible (#676) |
| codex-019fc399-ba8-1785759430-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 1835 | 0 | 416256 | 235 | 2070 | 0.1122 | 6684009 | 0 | 258147840 | 430321 | fix(ios): keep frame probe visible (#676) |
| codex-019fc399-ba8-1785770058-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 1816842 | 0 | 59516160 | 95194 | 1912036 | 20.8491 | 8500851 | 0 | 317664000 | 525515 | ci(mobile-e2e): parallelize iOS suites (#676) |
| codex-019fc399-ba8-1785770111-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 3809 | 0 | 480768 | 865 | 4674 | 0.1427 | 8504660 | 0 | 318144768 | 526380 | ci(mobile-e2e): parallelize iOS suites (#676) |
| codex-019fc399-ba8-1785770274-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 20328 | 0 | 739328 | 646 | 20974 | 0.2453 | 8524988 | 0 | 318884096 | 527026 | ci(mobile-e2e): parallelize iOS suites (#676) |
| codex-019fc399-ba8-1785770401-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 15763 | 0 | 514560 | 2397 | 18160 | 0.2040 | 8540751 | 0 | 319398656 | 529423 | ci(mobile-e2e): parallelize iOS suites (#676) |
| codex-019fc399-ba8-1785770482-1 | codex | 019fc399-ba80-7d93-b31c-9a406198fcb3 | #676 | gpt-5.6-luna | 5920 | 0 | 254976 | 716 | 6636 | 0.0893 | 8546671 | 0 | 319653632 | 530139 | ci(mobile-e2e): parallelize iOS suites (#676) -m governance: allow-toolchain-con |
