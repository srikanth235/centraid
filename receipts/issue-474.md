<!-- governance: allow-receipt-per-issue (#474) this receipt landed on the default branch as `issue-474.md` in c4a3aa4d, before its slug was known. Renaming it to a slugged filename is exactly what doc-integrity frozen-files forbids; immutability of the audit trail wins, so the name stays. -->

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-3cef613e-dec-1784538872-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 420 | 434071 | 34467655 | 171189 | 605680 | 24.2286 | 420 | 434071 | 34467655 | 171189 |  |
| claude-code-3cef613e-dec-1784538958-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 15 | 8367 | 1786677 | 6334 | 14716 | 1.1041 | 435 | 442438 | 36254332 | 177523 |  |
| claude-code-3cef613e-dec-1784539012-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 6 | 2439 | 678771 | 2310 | 4755 | 0.4124 | 441 | 444877 | 36933103 | 179833 |  |
| claude-code-3cef613e-dec-1784539584-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 111 | 48286 | 13951767 | 31981 | 80378 | 8.0778 | 552 | 493163 | 50884870 | 211814 |  |
| claude-code-3cef613e-dec-1784539646-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 12 | 4881 | 1497930 | 2937 | 7830 | 0.8530 | 564 | 498044 | 52382800 | 214751 |  |
| claude-code-3cef613e-dec-1784541167-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 118 | 73581 | 16827074 | 46619 | 120318 | 10.0395 | 682 | 571625 | 69209874 | 261370 |  |
| claude-code-3cef613e-dec-1784550516-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 452 | 487223 | 41759287 | 144088 | 631763 | 27.5292 | 1134 | 1058848 | 110969161 | 405458 | fix(gateway): unblock shutdown pinned open by SSE streams (#474)http.Server.clos |
| claude-code-3cef613e-dec-1784550667-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 29 | 23683 | 3365899 | 8854 | 32566 | 2.0525 | 1163 | 1082531 | 114335060 | 414312 | fix(e2e): repair remaining nightly lanes and the shutdown hang behind them (#474 |
| claude-code-3cef613e-dec-1784551005-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 8 | 7308 | 941854 | 5341 | 12657 | 0.6502 | 1171 | 1089839 | 115276914 | 419653 |  |
| claude-code-3cef613e-dec-1784551038-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 2 | 1132 | 238978 | 153 | 1287 | 0.1304 | 1173 | 1090971 | 115515892 | 419806 |  |
| claude-code-3cef613e-dec-1784551108-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 9 | 11173 | 1206978 | 4721 | 15903 | 0.7914 | 1182 | 1102144 | 116722870 | 424527 |  |
| claude-code-3cef613e-dec-1784551154-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 6 | 11289 | 737439 | 2790 | 14085 | 0.5091 | 1188 | 1113433 | 117460309 | 427317 |  |
| claude-code-3cef613e-dec-1784551849-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 47 | 24071 | 6400255 | 10404 | 34522 | 3.6109 | 1235 | 1137504 | 123860564 | 437721 |  |
| claude-code-3cef613e-dec-1784551902-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 10 | 18050 | 1326805 | 2401 | 20461 | 0.8363 | 1245 | 1155554 | 125187369 | 440122 |  |
| claude-code-3cef613e-dec-1784551939-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 2 | 3753 | 269775 | 131 | 3886 | 0.1616 | 1247 | 1159307 | 125457144 | 440253 |  |
| claude-code-3cef613e-dec-1784552010-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 11 | 5073 | 1921458 | 3954 | 9038 | 1.0913 | 1258 | 1164380 | 127378602 | 444207 |  |
| claude-code-3cef613e-dec-1784552042-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 2 | 430 | 275911 | 133 | 565 | 0.1440 | 1260 | 1164810 | 127654513 | 444340 |  |
| claude-code-3cef613e-dec-1784552095-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 10 | 1760 | 1382428 | 3478 | 5248 | 0.7892 | 1270 | 1166570 | 129036941 | 447818 |  |
| claude-code-3cef613e-dec-1784552152-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 6 | 3153 | 831024 | 4974 | 8133 | 0.5596 | 1276 | 1169723 | 129867965 | 452792 |  |
| claude-code-3cef613e-dec-1784558232-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 161 | 100122 | 26147690 | 64281 | 164564 | 15.3074 | 1437 | 1269845 | 156015655 | 517073 |  |
| claude-code-3cef613e-dec-1784558286-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 6 | 2730 | 965643 | 3513 | 6249 | 0.5877 | 1443 | 1272575 | 156981298 | 520586 |  |
| claude-code-3cef613e-dec-1784559997-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 887 | 748094 | 87217147 | 310662 | 1059643 | 56.0551 | 2330 | 2020669 | 244198445 | 831248 | fix(gateway): close the second SSE-pinned listener and a test that proved nothin |
| claude-code-3cef613e-dec-1784560068-1 | claude-code | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | claude-opus-4-8 | 12 | 12671 | 620884 | 3386 | 16069 | 0.4743 | 2342 | 2033340 | 244819329 | 834634 | fix(gateway): close the second SSE-pinned listener and a test that proved nothin |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-3cef613e-1784638357-1 | 3cef613e-dece-4259-ba2b-7e6f173aea56 | #474 | correction | classifier | Reversed prior push-to-main directive; requested PR instead | pending | 199 | 2026-07-20T10:12:37.915Z |


## Checklist

- [x] Repair every failing lane in nightly e2e run 29694615676 (`desktop-e2e`, `web-e2e`, `mobile-e2e`, `pairing-cross-network-relay`, `test-health-report`)
- [x] Size Playwright `globalTimeout` below the job `timeout-minutes` so the reporter flushes instead of being cancelled mid-write
- [x] Store nightly test-health reports as dated, append-only history
- [x] Gate staged-file formatting in pre-commit so mechanical CI failures are caught locally
- [x] Declare vendored blueprint kit assets as Turbo build outputs
- [x] Fix the gateway shutdown hang pinned open by SSE streams
- [x] Force the relay path in `pairing-cross-network-relay` on a NAT'd hosted runner
- [x] Fix the iOS `op-sqlite` / `expo-updates` header collision that broke the mobile build
- [x] Size node-project test timeouts for hosted-runner disk latency
- [x] Apply the SSE-safe close to the gateway web-UI server
- [x] Make the headless-compile lifecycle test wait on a real deadline instead of a 500ms iteration budget

## What changed

**Gateway shutdown (product fix).** `packages/app-engine/src/http/http-server.ts` — `RuntimeHttpServerHandle.close()` was a bare `server.close()`, which resolves only once every connection ends. Node reaps idle keep-alive sockets itself, but an active request never ends on its own, and the gateway serves several endless `text/event-stream` responses. One subscribed client pinned the listener open forever. `close()` now stops accepting, closes idle connections, then force-destroys survivors after `GATEWAY_SHUTDOWN_GRACE_MS` (new, in `packages/app-engine/src/http/server-tuning.ts`). `apps/desktop/src/main.ts` — the quit hard-cap timer was `unref()`'d, so the safety net that should have masked this could never fire.

**Desktop e2e teardown.** `apps/desktop/tests/e2e/fixtures.ts` gains `closeApp` (bounded close, SIGKILL on overrun, loud warning naming the test) and `stopDetachedGateways`, which stops detached children before removing their data dir. It reads pids from the product's own records and refuses to signal any pid whose live `ps` command line does not name this workspace, because pids get recycled. Call sites updated across `apps/desktop/tests/e2e/appview-templates-insights.spec.ts`, `apps/desktop/tests/e2e/automations.spec.ts`, `apps/desktop/tests/e2e/builder.spec.ts`, `apps/desktop/tests/e2e/delete-app.spec.ts`, `apps/desktop/tests/e2e/onboarding-home.spec.ts` and `apps/desktop/tests/e2e/settings-gateways.spec.ts`.

**Cross-network relay isolation.** `tests/agent-e2e-pairing/lib/docker-harness.mjs` and `tests/agent-e2e-pairing/flows/cross-network-relay.md` — isolation is now enforced by transport class rather than by address. Address enumeration structurally could not cover the runner's public NAT-mapped address, so both test subnets now DROP all UDP except DNS; the n0 relay is unaffected because its data path is a WebSocket over TLS over TCP 443. QAD on UDP 7842 is deliberately blocked, since that is how a peer learns the public address that defeated the previous fix. A self-validating UDP probe proves the block, and its `--sport` affordance is retired before the ceremony with an `iptables -S` read-back.

**Mobile iOS build.** `apps/mobile/ios/Podfile` and `apps/mobile/ios/Podfile.lock` — `op-sqlite` publishes its vendored SQLite amalgamation as a public pod header, so `<sqlite3.h>` resolved to it for every target. `expo-updates` (added in #468) stores its database in the OS SQLite via `import SQLite3`, putting both headers in one translation unit with mismatched guards (`SQLITE3_H` vs `_SQLITE3_H_`). A `post_install` hook unpublishes the public copy; op-sqlite still compiles against its own via the private header path. The hook raises if op-sqlite is installed but the header is missing, so a layout change fails loudly at `pod install` rather than silently no-opping.

**Test timeouts.** `packages/test-kit/src/vitest.ts` raises the `nodePreset` default to 30s; `packages/gateway/src/cli/{admin,backup-admin,key-admin}.test.ts` escalate to 60s and drop two inline per-test `timeout` options that would have capped those tests back below their file budget. `TESTING.md` documents the two tiers.

**Web-UI server shutdown (same defect, second listener).** `packages/gateway/src/serve/web-ui-server.ts` — the returned `close()` was a bare `server.close(cb)`, carrying the identical defect fixed in `http-server.ts`: one subscribed `text/event-stream` client pins the listener open forever, and `serve()` awaits this during teardown, so it can wedge a gateway switch or quit. It now closes idle connections and force-destroys survivors after `GATEWAY_SHUTDOWN_GRACE_MS`, which `packages/app-engine/src/index.ts` now re-exports so consumers outside app-engine can share the one grace window.

**A lifecycle test that proved nothing.** `packages/gateway/src/routes/lifecycle-automation-routes.test.ts` — the headless-compile test polled for the run's `endedAt` on an iteration budget of 20 × 25ms = 500ms, and on expiry simply fell through: `endedAt` was never asserted, so the two assertions that remained passed against a run row that had not finished. A compile spawns a real app-server subprocess and takes ~7s, so the budget was expiring on *every* run, including locally — the test had never once observed a completed run. Worse, falling through left the compile still writing objects into `code/apps.git` while `afterEach` deleted the data dir, which surfaced in CI run 29751584092 as an unrelated-looking `ENOTEMPTY` from `rm`. The poll is now a wall-clock deadline and `endedAt` is asserted, which is what makes both the claim and the teardown honest.

**Earlier commits on this issue.** `.github/workflows/e2e.yml` (globalTimeout / `timeout-minutes` sizing, dated report slots), `apps/desktop/tests/e2e/playwright.config.ts`, `apps/web/tests/e2e/playwright.config.ts`, `apps/web/tests/e2e/web-pwa.spec.ts`, `apps/web/tests/e2e/perf-waterfall.spec.ts`, `tests/agent-e2e-mobile/lib/harness.mjs`, `tests/agent-e2e-mobile/flows/home-loads.mjs`, `tests/agent-e2e-pairing/lib/device-redeem.mjs`, `scripts/test-report/prepare-pages-site.mjs`, `scripts/test-report/generate.mjs`, `scripts/test-report/summary-markdown.mjs`, `scripts/test-report/smoke.mjs`, `packages/blueprints/turbo.json` (undeclared build outputs made cached builds diverge from uncached), and the `format-check` governance directive: `.governance/packs.lock`, `.governance/packs/srikanth235/centraid/directives/format-check/directive.yaml`, `.governance/packs/srikanth235/centraid/directives/format-check/constitution.md`, `.governance/packs/srikanth235/centraid/directives/format-check/check.sh`.

### Checklist crosswalk

Each checked item above, mapped to the work that satisfies it:

- Repair every failing lane in nightly e2e run 29694615676 (`desktop-e2e`, `web-e2e`, `mobile-e2e`, `pairing-cross-network-relay`, `test-health-report`) — all five lanes are addressed across this commit and the three earlier ones; `web-e2e` is confirmed green in CI, the rest are verified locally per `## Verification`.
- Size Playwright `globalTimeout` below the job `timeout-minutes` so the reporter flushes instead of being cancelled mid-write — desktop 22m under a 35m job, web 10m under a 20m job. Job-level cancellation is unconditional and kills the reporter mid-flush, destroying traces and the JSON report; `globalTimeout` fails the run while leaving evidence behind.
- Store nightly test-health reports as dated, append-only history — `scripts/test-report/prepare-pages-site.mjs` gains `--date` / `--run-id` / `--run-url` / `--keep`, writing dated archive slots.
- Gate staged-file formatting in pre-commit so mechanical CI failures are caught locally — the `format-check` directive, scoped to staged files only so it never fires on someone else's pre-existing debt.
- Declare vendored blueprint kit assets as Turbo build outputs — `packages/blueprints/turbo.json`.
- Fix the gateway shutdown hang pinned open by SSE streams — `packages/app-engine/src/http/http-server.ts`, detailed above.
- Force the relay path in `pairing-cross-network-relay` on a NAT'd hosted runner — `tests/agent-e2e-pairing/lib/docker-harness.mjs`, by transport class rather than by address.
- Fix the iOS `op-sqlite` / `expo-updates` header collision that broke the mobile build — `apps/mobile/ios/Podfile`, unpublishing the shadowing public header.
- Size node-project test timeouts for hosted-runner disk latency — `packages/test-kit/src/vitest.ts` at 30s, with `packages/gateway/src/cli/admin.test.ts`, `packages/gateway/src/cli/backup-admin.test.ts` and `packages/gateway/src/cli/key-admin.test.ts` escalating to 60s.

- Apply the SSE-safe close to the gateway web-UI server — `packages/gateway/src/serve/web-ui-server.ts`, with `GATEWAY_SHUTDOWN_GRACE_MS` now re-exported from `packages/app-engine/src/index.ts` so both listeners share one grace window.
- Make the headless-compile lifecycle test wait on a real deadline instead of a 500ms iteration budget — `packages/gateway/src/routes/lifecycle-automation-routes.test.ts` now polls to a wall-clock deadline and asserts `endedAt`, which also stops `afterEach` racing the live compile's writes into `code/apps.git`.

## Out of scope

- **Detached gateway lifetime (filed as #475).** Detached children outlive their data directory and squat a fixed port; the fixture stops them, which unblocks the lane but does not change product behaviour. The production port-squatting case is untouched.
- **`op-sqlite` FTS5 dead config.** `"op-sqlite": { "fts5": true }` in `apps/mobile/package.json` never applies — bun hoists op-sqlite to the repo root, so the podspec finds the root `package.json`, which has no `op-sqlite` key. Filed separately.
- **`web-ui-server.ts:208`** has the identical bare-`close()` bug, but the desktop never passes `options.web`, so it is not on this hot path.
- **Worker concurrency.** Capping `maxForks` may be a better fix than a timeout bump if the disk contention is superlinear, but that would lengthen every healthy run to fix an occasional host. Deferred pending recurrence.
- **`project.pbxproj`** was deliberately excluded: the Xcodeproj gem de-quotes a `PRODUCT_BUNDLE_IDENTIFIER` line that #468 had just set for store readiness. `Pods/` is gitignored, so `pod install` re-adds the bundle entries.

## Decisions

**Isolation by transport, not by address.** Two prior attempts blocked the direct path by naming addresses. The CI evidence showed the selected path was `20.116.79.56:64512` — the runner's public NAT-mapped address, which appears on no local interface and so cannot be enumerated. Chasing it would need an external lookup and would vary per runner. Blocking UDP is host-independent and degrades correctly, because the relay is TCP.

**The UDP 443 allowance was a wrong guess, corrected before shipping.** An earlier revision allowed UDP 443 on the intuition that QUIC implies UDP 443. In pinned iroh 1.0.2 the relay data path is TCP 443 and the only relay UDP is QAD on 7842. Encoding the guess would have put a documented falsehood in the file whose value is documenting the true topology.

**Coverage instrumentation was not the cause of the timeouts.** The initial hypothesis was v8 coverage overhead. `bun run coverage` runs in both the `ci` and nightly lanes, and the identical command passed in one and failed in the other on the same image and Node version. The median file was 0.83x — *faster* nightly — with only fsync-bound tests inflating 5–10x. The fix is therefore deliberately not coverage-conditional: the required `check` gate is exposed to the same flake and passed only by landing on a fast host.

**The `ENOTEMPTY` was attributed by A/B, not assumed.** On pristine main, a `PPID 1` orphaned gateway was still rewriting `gateway.lease` into a deleted workspace seven minutes after removal (1 stray / 1 leftover, reproduced 2/2). With the fix, 0/0. The force-kill path added here never fired in any run, so it is not the cause.

## Verification

```sh
bun run lint
bun run format:check
bunx turbo run typecheck
bun run --cwd apps/desktop test:e2e
cd apps/mobile/ios && pod install && xcodebuild -workspace Centraid.xcworkspace \
  -scheme Centraid -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' build
```

Desktop e2e on the rebased tree: **53 passed, 5 skipped, 0 failed (7.6m)**, with `strays=0, leftovers=0`. Pristine main for comparison: same pass count but `strays=1, leftovers=1`. Test `1.2 — completing onboarding persists the profile and lands on home`, the original failure, passes.

iOS: `** BUILD SUCCEEDED **`, exit 0, zero redefinition errors, from a wiped `Pods/` and empty derived data on the rebased tree. Header resolution verified to flip: the app target now reaches the SDK's `sqlite3.h` while op-sqlite still reaches its own private copy.

Coverage lane: all 12 originally-failing files pass locally (120 tests). The nightly host penalty could not be reproduced on this machine, which performs like the fast runner.

CI run 29751583983 confirmed the relay lane green for the first time (`pairing-cross-network-relay` had never passed before), alongside `desktop-e2e`, `pairing-lifecycle` and `pairing-ticket-hygiene`.

The lifecycle-automation fix was verified by the file's own runtime: it ran 12.4s before the change and 19.3s after, across repeated local runs (11/11 tests passing each time). That ~7s delta is the compile run actually finishing — direct evidence that the previous 500ms budget was expiring every time rather than observing completion.

**Not verified locally, CI-only:** the relay flow requires Docker on a Linux host with the NAT topology, so the port-class rules have never been executed against real netfilter. The iOS fix was verified for mechanism, not by reproducing the original failure — this Mac has Xcode 26.6 / iOS 26.5 SDK against CI's Xcode 16.x / iOS 18.x, and locally the two headers are close enough (3.51.3 vs 3.51.0) that the collision stays latent.

## Audit

Independent sub-agents reviewed each lane against the CI evidence and the diff. Three of this session's stated hypotheses were refuted by that review and corrected before shipping: coverage instrumentation as the timeout cause, UDP 443 as a relay requirement, and the force-kill path as the `ENOTEMPTY` cause. The `stderr` noise initially read as teardown collateral was shown to appear with identical counts in passing runs.

## Steering

Verdict: **PASS**

Evidence for rubric checks:

1. **Every human-steering event in the transcript is recorded as a row in this receipt's `### Steering` table under `## Accounting`.**
   - Identified one steering event: "pleae creae PR (do not push to main branch directlry)" at 2026-07-20T10:12:37.915Z (ordinal 199).
   - This is a **correction** (reverses prior directive to push to main directly; redirects to open a PR instead).
   - Event is recorded in the `### Steering` table as `steer-3cef613e-1784638357-1`.
   - **Check: PASS**

2. **No non-steering message is recorded as a steering event.**
   - Reviewed all 324 user entries in the transcript. Non-steering messages include:
     - Initial greeting ("hi")
     - Goal-setting hook notifications (automated)
     - Questions and clarifications (e.g., "30 mins is time out set by us for desktop tests, right?")
     - Affirmations without redirection (e.g., "yes, implement all your suggestions")
     - Questions about timing and environment (e.g., "how long is desktop e2e taking")
     - Stop hook feedback messages (automated)
   - None of these appear in the steering table.
   - **Check: PASS**

**Historical context:** The correction event reflects a mid-session redirect where the user changed course from pushing directly to main to creating a PR instead. This is a valid steering event captured in the ledger.

