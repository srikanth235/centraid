# Desktop App — E2E Testing Coverage Report

_Updated: 2026-06-06. Scope: `apps/desktop` (Electron)._

## Executive summary

The desktop e2e suite has been **rebuilt and broadened from 1 journey to all 14
surface areas — 59 passing tests**. The previous suite (8 tests, app-deletion only)
had **silently broken** when the gateway-store refactor (#109/#137/#141) landed: it
seeded a `gatewayUrl` that `settings.json` no longer persists, and used pre-redesign
selectors (`.app-tile`, `.tile-more-btn`). Every one of those 8 tests failed when run.

Adding the Cloud → Database coverage (6.4) also **surfaced and fixed a real product
bug**: the row-browser pager never advanced (see "Bug found" below).

| Dimension | Before | Now |
|---|---|---|
| Passing tests | 0 (suite broken) | **59** |
| Journeys covered | app deletion only | all 14 sections |
| Real Electron + real UI | ✅ | ✅ |
| Per-test isolation | ✅ | ✅ (mock gateway + `userData`) |
| Streaming (chat turns, run timelines) | ❌ | ✅ SSE in the mock |
| Runs in PR CI | ❌ | ❌ (too heavy for PRs) — **but now runs nightly** (`e2e.yml`) |

## Harness

- **Framework:** Playwright via `_electron` — launches the real Electron process and
  drives the real renderer.
- **Pointing at the mock:** post-refactor, the renderer talks to the *active gateway*
  over HTTP and `settings.json` no longer stores a URL/token. The harness seeds a
  **remote gateway profile** (`gateways/<id>/profile.json`) whose `url` is the mock,
  marks it active, and sets `onboardingCompletedAt`. See [fixtures.ts](./fixtures.ts).
- **Mock gateway:** one configurable HTTP server per test covering the full gateway
  surface + **SSE** for chat turns and automation run events, with CORS/OPTIONS and
  per-route error knobs. `gateway.state` is the single source of fixture data.

## Coverage

59 tests across six spec files (full matrix in [SCENARIOS.md](./SCENARIOS.md)):

| Spec | Sections | Tests |
|---|---|---|
| `delete-app.spec.ts` | §3 deletion | 8 |
| `onboarding-home.spec.ts` | §1 onboarding, §2 home/tiles | 10 |
| `builder.spec.ts` | §4 create, §5 edit, §6 tabs | 9 |
| `appview-templates-insights.spec.ts` | §7 app view/chat, §10 templates, §11 insights | 8 |
| `automations.spec.ts` | §8 list/viewer, §9 runs | 12 |
| `settings-gateways.spec.ts` | §12 settings, §13 gateways, §14 cross-cutting | 12 |

What's exercised end-to-end: onboarding gate → home tiles/badges → create (streamed
turn + tool pills) → publish (success + failure) → builder Code/SQL tabs + Database
browse/paginate + Logs filter → app-view copilot SSE turn + past-chats history →
Discover clone → automations list/viewer/enable/webhook/delete → run-viewer SSE
timeline (success + failure + node expand) → appearance prefs persist + Match-system +
Agents page → gateway add/switch/rename/rotate/remove + unreachable fallback →
auth-error prompt → Cmd+K / Cmd+B / Esc.

## Bug found

Adding the Database row-browser test (6.4) uncovered a genuine pagination defect in
`builder.ts::renderRowBrowser`: the current page was captured once at fragment-build
time, so `fetchRows` and the Prev/Next handlers always re-requested `offset 0` —
clicking **Next** bumped the page counter but reloaded the same 50 rows. Fixed by
reading the page lazily (`currentPage()`) at fetch/paint time. This is the only
product-code change in this work; it should land as its own commit, separate from the
test additions.

## Deferred (≈11 scenarios, mostly P2)

Documented in SCENARIOS.md. Notable: builder file-diff/device/refresh, app-view
model-picker/settings, run pin/nested/filter, template webhook-secret toast, iframe
auth-header injection, publish-queue events. Two fault-injection scenarios (onboarding
save-fail, boot settings-fail) are intentionally uncovered — the contextBridge API is
frozen and there's no production fault seam, so covering them would require a test-only
backdoor in the main process. Insights time-window (11.2) and run-click (11.3) are now
marked **N/A** — neither has a surface in the current UI.

## CI integration

The PR `ci` job ([.github/workflows/ci.yml](../../../../.github/workflows/ci.yml)) still
runs vitest unit coverage only — the e2e suite builds + launches Electron, which is too
heavy for every PR. It now runs **nightly** (and on-demand via `workflow_dispatch`) in
[.github/workflows/e2e.yml](../../../../.github/workflows/e2e.yml): it installs the
Playwright/Electron host deps (`playwright install --with-deps chromium`), builds every
package, and runs the suite under `xvfb-run`. Traces/screenshots upload as an artifact
on failure. This closes the gap that let the old suite rot unnoticed.

## How to run

```sh
cd apps/desktop
bun run test:e2e          # builds dist/, then runs all 59 e2e tests
```
