# issue-225 — Desktop nightly Playwright e2e suite across all 14 surfaces

GitHub issue: [#225](https://github.com/srikanth235/centraid/issues/225)

Realizes the **thin e2e journeys** that #212 scoped as nightly/on-demand follow-up.
The pre-existing `delete-app` Playwright suite had **silently broken** when the
gateway-store refactor (#109/#137/#141) landed — it seeded a `gatewayUrl` that
`settings.json` no longer persists and used pre-redesign selectors, so all 8 tests
failed and nobody noticed (the suite wasn't in CI). This rebuilds the harness,
broadens coverage to every surface, fixes a real bug the new coverage surfaced, and
closes the CI gap that let the suite rot.

## Checklist

- [x] Rebuild the e2e harness for the post-#109/#137/#141 gateway-store architecture
- [x] Broaden coverage to all 14 surface areas with SSE streaming
- [x] Add deferred-scenario specs (Database paginate, Logs filter, past-chats, Match-system, Agents page)
- [x] Fix the Cloud → Database row-browser pagination bug
- [x] Wire the suite into a nightly + on-demand CI workflow
- [x] Update the coverage docs (SCENARIOS, COVERAGE_REPORT, README)

## What changed

### Rebuild the e2e harness for the post-#109/#137/#141 gateway-store architecture

`tests/e2e/fixtures.ts` is a configurable mock gateway (full HTTP surface + SSE,
CORS/OPTIONS, per-route error knobs) plus DOM helpers. Since the renderer now talks
to the *active gateway* directly and `settings.json` no longer carries a URL/token,
the harness seeds a **remote gateway profile** under `gateways/<id>/profile.json`
pointing at the mock, marks it active, and sets `onboardingCompletedAt`. Each test
owns a fresh `userData`, a fresh mock on a random loopback port, and its own Electron
process — state never leaks. `delete-app.spec.ts` was repointed off the dead seeding +
pre-redesign selectors.

### Broaden coverage to all 14 surface areas with SSE streaming

Six spec files cover §1–§14: onboarding gate, home tiles/badges/rename/menu, app
deletion (draft/published/offline/404/dismiss paths), builder create→stream→publish
(success + failure) + Code/SQL tabs, app-view copilot SSE turn, automations
list/viewer/enable/webhook/delete + run-viewer SSE timeline (success + failure + node
expand), Discover clone, insights KPIs, appearance prefs, and gateway
add/switch/rename/rotate/remove + unreachable fallback + auth-error prompt. SSE is
modelled in the mock for both chat turns and automation run events.

### Add deferred-scenario specs (Database paginate, Logs filter, past-chats, Match-system, Agents page)

Five P1/P2 journeys from the deferred set: Cloud → Database browse + paginate (table
card → row grid → Next advances offset), Cloud → Logs filter (level chips + free-text
search), app-view past-chats history (⋯ → Chat history list + search), Settings →
Match system (OS scheme → `data-theme` + prefs PUT), and Settings → Agents (providers)
page render. The mock gained a paginated `/_apps/:id/data/:table` route. Insights
time-window (11.2) and run-click (11.3) were reclassified **N/A** — neither has a
surface in the current UI.

### Fix the Cloud → Database row-browser pagination bug

`builder.ts::renderRowBrowser` captured the current page **once** at fragment-build
time, so the `fetchRows` closure and the Prev/Next handlers always re-requested
`offset 0` — clicking Next bumped the counter but reloaded the same 50 rows. Fixed by
reading the page lazily (`currentPage()`) at fetch/paint time. This is the only
product-code change; the new 6.4 test fails against the pre-fix renderer.

### Wire the suite into a nightly + on-demand CI workflow

New `.github/workflows/e2e.yml` (`schedule` 06:00 UTC + `workflow_dispatch`) installs
the Playwright/Electron host deps (`playwright install --with-deps chromium`), builds
every package, and runs the suite under `xvfb-run`; traces/screenshots upload as an
artifact on failure. Kept off PR CI — building + launching real Electron is too heavy
per-push. Actions are pinned to SHAs and the workflow declares `permissions`.

### Update the coverage docs (SCENARIOS, COVERAGE_REPORT, README)

`tests/e2e/SCENARIOS.md`, `COVERAGE_REPORT.md`, and `README.md` updated to 59 passing
tests, the new statuses + N/A reclassifications, the bug writeup, and the nightly CI
section.

## Out of scope

- **~11 remaining P2 polish scenarios** (builder file-diff/device/refresh, app-view
  model-picker/settings, run pin/nested/filter, template webhook-secret toast, iframe
  auth-header injection, publish-queue events) — documented in SCENARIOS.md; the
  harness already has the mock plumbing to add them.
- **Two fault-injection scenarios** (onboarding save-fail, boot settings-fail) — the
  contextBridge API is frozen and there's no production fault seam, so covering them
  would need a test-only backdoor in the main process. Left uncovered by design.
- **Maestro mobile flows** — separate from this desktop suite; still deferred by #212.

## Verification

- `bun run test:e2e` (apps/desktop) — **59 pass** in ~1.6 min, `workers: 1`, no
  cross-test leakage; the rebuilt suite replaces the 0-passing (all-broken) baseline.
- The Cloud → Database **pagination** test (6.4) asserts the pager advances
  `1–50 → 51–60` and the second request carries `offset=50`; it fails against the
  pre-fix renderer and passes after the `currentPage()` fix.
- `oxlint` + `oxfmt --check` clean on all touched files (also fixed 4 pre-existing
  lint nits in the uncommitted suite); `tsc` typecheck clean.
- `fixtures.ts` (763 lines) carries a `governance: allow-repo-hygiene file-size-limit`
  waiver — it's one cohesive harness (mock gateway + builders + DOM helpers) shared by
  every spec; splitting it would scatter the single source of fixture truth.
- `e2e.yml` declares `permissions: contents: read` and pins every action to a SHA.
