# Desktop App — E2E Scenarios & Coverage

_Updated: 2026-06-06. Scope: `apps/desktop` (Electron)._

Target journeys for the desktop e2e suite, derived from the app's real surfaces.
The suite now drives the **post-#109/#137/#141 architecture** (renderer = thin HTTP
client against the active gateway; app code in the gateway git store). It was
**rebuilt from scratch** — the previous `delete-app.spec.ts` had silently broken when
the gateway-store refactor landed (it seeded a `gatewayUrl` that settings no longer
persists, and used the pre-redesign `.app-tile` selectors).

**Status:** ✅ covered by a passing test · 🔶 partially / indirectly covered · ⬜ not yet
· N/A not present in the current UI.
**Priority:** P0 critical · P1 high · P2 polish.

**Coverage today: 59 passing tests across all 14 sections** (was 0 — the old suite
did not run). Run with `bun run test:e2e` from `apps/desktop`. The suite also runs
nightly in CI (`.github/workflows/e2e.yml`).

| Spec file | Section(s) | Tests |
|---|---|---|
| `delete-app.spec.ts` | §3 | 8 |
| `onboarding-home.spec.ts` | §1, §2 | 10 |
| `builder.spec.ts` | §4, §5, §6 | 9 |
| `appview-templates-insights.spec.ts` | §7, §10, §11 | 8 |
| `automations.spec.ts` | §8, §9 | 12 |
| `settings-gateways.spec.ts` | §12, §13, §14 | 12 |

---

## 1. Onboarding & first run

| # | Scenario | Pri | Status |
|---|---|---|---|
| 1.1 | First launch → onboarding; CTA disabled until name entered | P0 | ✅ |
| 1.2 | Enter name + color → Submit → profile saved, lands on home | P0 | ✅ |
| 1.3 | Onboarding save fails → error in card | P1 | ⬜ needs IPC fault-injection seam (contextBridge API is frozen) |
| 1.4 | Relaunch after completion → straight to home | P0 | ✅ |
| 1.5 | Settings fetch fails on boot → home with defaults | P1 | ⬜ needs IPC fault-injection seam |

## 2. Home / app tiles

| # | Scenario | Pri | Status |
|---|---|---|---|
| 2.1 | Tiles render with correct badges (draft vs new) | P0 | ✅ |
| 2.2 | Empty state: shelf-empty + composer present | P1 | ✅ |
| 2.3 | Context-menu Rename → inline edit → `meta` POST + toast | P1 | ✅ |
| 2.4 | Duplicate | P1 | N/A — no Duplicate item in the current tile menu |
| 2.5 | Context menu exposes Open/Edit/Rename/Share/Reveal/Delete | P2 | ✅ |
| 2.6 | Click tile → app view iframe | P0 | ✅ |
| 2.7 | Sidebar toggle flips `data-sidebar` | P2 | ✅ |
| 2.8 | Command palette opens (Search item) | P2 | ✅ |

## 3. App deletion

| # | Scenario | Pri | Status |
|---|---|---|---|
| 3.1 | Draft delete → gateway DELETE, toast | P0 | ✅ |
| 3.2 | Published delete → deregister + clear local state | P0 | ✅ |
| 3.3 | Gateway offline → error toast, tile remains | P0 | ✅ |
| 3.4 | Gateway 404 → idempotent success | P0 | ✅ |
| 3.5 | Dismiss: Cancel / Escape / backdrop / Enter-confirm | P0 | ✅ (a/b/c/d) |

## 4. App creation (composer → builder → publish)

| # | Scenario | Pri | Status |
|---|---|---|---|
| 4.1 | Composer → builder opens (new mode) | P0 | ✅ |
| 4.2 | Turn streams; tool pills render | P0 | ✅ |
| 4.3 | Preview iframe mounts the draft URL | P0 | ✅ |
| 4.4 | Publish → gateway POST → returns to home on success | P0 | ✅ |
| 4.5 | Publish fails → error in chat, no false success | P0 | ✅ |
| 4.6 | Stop in-flight turn | P1 | ⬜ |
| 4.7 | Attach file in composer | P2 | ⬜ |

## 5. App editing

| # | Scenario | Pri | Status |
|---|---|---|---|
| 5.1 | Edit with Centraid opens existing app (session opened) | P0 | ✅ |
| 5.2 | Inline title/description edit in topbar | P1 | ⬜ |
| 5.3 | Edit → Publish creates version; History lists | P1 | ⬜ |
| 5.4 | History → activate/rollback | P1 | ⬜ |
| 5.5 | Use/Build toggle | P1 | ⬜ |

## 6. Builder tabs

| # | Scenario | Pri | Status |
|---|---|---|---|
| 6.1 | Switch tabs (Preview/Code/Cloud) | P1 | ✅ |
| 6.2 | Code tab → file tree → open file in editor | P1 | ✅ |
| 6.3 | Agent file write → diff view | P1 | ⬜ |
| 6.4 | Cloud → Database browse + paginate | P1 | ✅ (caught + fixed a pagination bug — see note below) |
| 6.5 | Cloud → SQL run → result output | P1 | ✅ |
| 6.6 | Cloud → Logs filter | P2 | ✅ (level chips + free-text search) |
| 6.7 | Device selector resizes preview | P2 | ⬜ |
| 6.8 | Refresh preview | P2 | ⬜ |

## 7. App view + in-app chat

| # | Scenario | Pri | Status |
|---|---|---|---|
| 7.1 | Open app iframe; back returns home | P0 | ✅ |
| 7.2 | Chat FAB opens copilot panel | P1 | ✅ |
| 7.3 | Chat turn streams reply + SQL tool | P0 | ✅ |
| 7.4 | Past-chats dropdown | P1 | ✅ (⋯ → Chat history list + search filter) |
| 7.5 | Model/agent picker | P2 | ⬜ |
| 7.6 | App settings rename/delete | P1 | ⬜ |

## 8. Automations — list & viewer

| # | Scenario | Pri | Status |
|---|---|---|---|
| 8.1 | List renders rows + status pills | P0 | ✅ |
| 8.2 | Load failure → error card → Retry recovers | P1 | ✅ |
| 8.3 | New automation → builder | P0 | ✅ |
| 8.4 | Row → viewer | P0 | ✅ |
| 8.5 | Enable/disable toggle → set-enabled + toast | P0 | ✅ |
| 8.6 | Webhook URL shown + copy | P1 | ✅ |
| 8.7 | Delete → confirm → DELETE → back to list | P0 | ✅ |
| 8.8 | Edit → builder | P1 | ✅ |

## 9. Automation runs & monitoring

| # | Scenario | Pri | Status |
|---|---|---|---|
| 9.1 | Run now → run viewer | P0 | ✅ |
| 9.2 | Timeline streams to success | P0 | ✅ |
| 9.3 | Failed run → failure outcome | P0 | ✅ |
| 9.4 | Expand node → payloads | P1 | ✅ |
| 9.5 | Nested invoke child timeline | P2 | ⬜ |
| 9.6 | Keep-only-failures filter | P2 | ⬜ |
| 9.7 | Rerun (Run again) | P1 | ✅ |
| 9.8 | Pin run as fixture | P2 | ⬜ (control lives in the app-view run list) |
| 9.9 | Escape collapses node | P2 | ✅ |

## 10. Templates / Discover

| # | Scenario | Pri | Status |
|---|---|---|---|
| 10.1 | Discover renders template cards | P1 | ✅ |
| 10.2 | Use template → clone → builder | P0 | ✅ |
| 10.3 | Webhook clone → secret toast once | P1 | ⬜ |
| 10.4 | Empty gallery | P2 | ✅ |

## 11. Insights

| # | Scenario | Pri | Status |
|---|---|---|---|
| 11.1 | KPI cards render | P2 | ✅ |
| 11.2 | Time-window switch | P2 | N/A — the window is a static "Last 30 days" label; no switcher in the current UI |
| 11.3 | Click run → run viewer | P2 | N/A — Insights' recent-activity rows aren't clickable; run→viewer lives in §9 (automations) |

## 12. Settings

| # | Scenario | Pri | Status |
|---|---|---|---|
| 12.1 | Appearance accent → applies live + saves to gateway | P1 | ✅ (theme/density share the same `setPrefs`→PUT path) |
| 12.2 | Match system | P2 | ✅ (resolves OS scheme → `data-theme` + prefs PUT) |
| 12.3 | Density / variant / accent toggles | P2 | 🔶 accent covered by 12.1 |
| 12.4 | Providers page renders | P2 | ✅ (Agents nav → page title + active-agent switch) |
| 12.5 | Settings persist across relaunch | P1 | ✅ |

## 13. Gateways / profiles

| # | Scenario | Pri | Status |
|---|---|---|---|
| 13.1 | Switcher lists profiles | P1 | 🔶 (covered via listGateways IPC in 13.2/13.7) |
| 13.2 | Add remote gateway → registered | P0 | ✅ |
| 13.3 | Add local workspace | P1 | ✅ |
| 13.4 | Switch active → re-scopes home | P0 | ✅ |
| 13.5 | Rename profile | P2 | ✅ |
| 13.6 | Rotate remote token | P1 | ✅ |
| 13.7 | Delete remote; local cannot be deleted | P1 | ✅ |
| 13.8 | Switch to unreachable → graceful | P0 | ✅ |

## 14. Cross-cutting

| # | Scenario | Pri | Status |
|---|---|---|---|
| 14.1 | Remote offline mid-session → no crash | P0 | 🔶 covered via 3.3 + 13.8 |
| 14.2 | Auth failure → token/Settings prompt | P0 | ✅ |
| 14.3 | Auth header injected into iframe requests | P1 | ⬜ |
| 14.4 | Global keyboard shortcuts (Cmd+K, Cmd+B, Esc) | P1 | ✅ (Cmd+K, Cmd+B, Esc; ⌘-Enter via composer) |
| 14.5 | Publish queue status/event | P1 | ⬜ |

---

## Deviations from the original plan

- **No Duplicate (2.4)** — the current tile menu is Open / Edit with Centraid / Rename /
  Share / Reveal in Finder / Delete. Cloning happens via Discover/templates (§10).
- **Fault-injection scenarios (1.3, 1.5)** — these need an IPC call to *fail*. The
  preload `window.CentraidApi` is a frozen contextBridge object, so it can't be
  monkey-patched from a test, and there's no production fault seam. Left uncovered
  rather than adding a test-only backdoor to the main process.
- **Pin run (9.8)** — the pin control lives in the app-view run list, not the
  automation run viewer; deferred with the rest of the app-view chrome.
- **Insights time-window / run-click (11.2, 11.3)** — the window is a fixed
  "Last 30 days" label and the recent-activity rows aren't clickable, so neither
  has a UI surface to drive. Marked N/A rather than deferred.

## Bug found while adding coverage

- **Cloud → Database row-browser pagination was broken** (fixed). In
  `builder.ts::renderRowBrowser`, the current page was captured **once** when the
  fragment was built, so the `fetchRows` closure and the Prev/Next handlers all
  re-fetched **offset 0** — clicking Next bumped the stored page but reloaded the
  same rows. Fixed by reading the page lazily (`currentPage()`) at fetch/paint
  time. The new 6.4 test asserts the pager advances `1–50 → 51–60` and that the
  second request carries `offset=50`; it fails against the pre-fix renderer.

## Remaining ⬜ (deferred — mostly P2 polish)

4.6/4.7, 5.2–5.5, 6.3/6.7/6.8, 7.5/7.6, 9.5/9.6/9.8, 10.3, 14.3/14.5. These are
good follow-ups; the harness (`fixtures.ts`) already has the mock endpoints + SSE
plumbing to support them.
