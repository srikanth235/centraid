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
- [x] Expose the DEV frame-probe arm to iOS accessibility automation
- [x] Recover a transient iOS dev-client redbox during cold-start sampling

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

- **iOS warm-run timing and follow-up fixes (30760887247).** The native `.app` cache was a hit: native build/install and cache-save steps were skipped, with restore/install taking about 35–47 seconds. The remaining setup was the uncached gateway dependency build (~5m25) and simulator boot (~2m); the sequential six-journey suite consumed ~47 minutes. The run exposed two independent automation issues. To **Expose the DEV frame-probe arm to iOS accessibility automation**, `apps/mobile/src/kit/perf/FrameProbe.tsx` marks its DEV arm as `accessible`. To **Recover a transient iOS dev-client redbox during cold-start sampling**, `tests/agent-e2e-mobile/flows/cold-start.mjs` reloads only when the explicit `No script URL provided` redbox appears before asserting Home. `.github/workflows/e2e.yml` now enables the existing OS-isolated Turbo cache for iOS too, removing that repeat gateway rebuild on subsequent warm runs.

- **iOS Photos open selectors (30745625780).** Onboarding + cold-start green under the 90m cap. `tests/agent-e2e-mobile/flows/mobile-scroll-frames` / `tests/agent-e2e-mobile/flows/scroll-frames.mjs` failed tapping bare `Photos`/`People` (tiles publish `Open Photos` / `Open People`). `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs` Photos assert uses the exact a11y label with a longer first-paint wait.

- **iOS Tally re-tap + perf deep-link alert (30748673657).** native-v0 opened Tally then `retryableTapCommands` re-tapped `Open Tally` under the cover and failed; launcher opens are a single tap. scroll-frames hit iOS "Open in 'Centraid'?" on `centraid://perf-frames` — dismiss Open before asserting `perf-frame-sampling`; `apps/mobile/src/kit/perf/FrameProbe.tsx` also accepts hostname-form deep links.

- **iOS perf arm never reached Linking (30752843689).** native-v0/cold-start green; scroll-frames dismissed the Open-in alert but `perf-frame-sampling` never appeared. FrameProbe now exposes DEV `testID="perf-frame-arm"`; scroll-frames taps that instead of `openLink`.

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
bun run test:matrix
node --test scripts/mobile-onboarding-maestro-contract.test.mjs
bun run test:accessibility
node node_modules/vitest/vitest.mjs run --config scripts/test-report/vitest.config.ts
bun run turbo run typecheck --filter=@centraid/mobile
bun run lint:e2e-flows
bun run --cwd apps/mobile lint
bun run --cwd apps/mobile test -- src/lib/phone-link.test.ts src/lib/replica/mobile-gateway-compatibility.integration.test.ts src/lib/replica/mobile-gateway-compatibility.test.ts
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
