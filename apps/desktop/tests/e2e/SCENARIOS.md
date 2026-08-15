# Desktop E2E scenarios

_Updated: 2026-08-15. The suite has 58 tests across ten spec files (full local run)._

This is the current, executable coverage map for the real Electron app. A scenario is listed as covered only when a current Playwright spec proves it; older coverage claims are intentionally not carried forward.

| Area | Spec | Tests | Covered behavior |
| --- | --- | --: | --- |
| Launch | `launch-time.spec.ts` | 1 | Cold process start through usable Home |
| Onboarding and Home | `onboarding-home.spec.ts` | 18 | First-run CTA, auto-founded `Personal`, returning user, tiles/badges, empty state, rename, tile menu, app open, sidebar, command palette |
| Delete | `delete-app.spec.ts` | 8 | Draft/published delete, offline/404 behavior, cancel/Escape/Enter/backdrop dismissal |
| Inline app / automation templates / Analytics | `appview-templates-insights.spec.ts` | 3 | System app renders inline with no iframe, automation clone survives a restart, Analytics runs chart |
| Automations | `automations.spec.ts` | 12 | List/error/retry, create/edit, enable/disable, webhook URL, delete, run viewer, success/failure timeline, nested tool transcript, rerun |
| Settings / gateways | `settings-gateways.spec.ts` | 12 | Theme and system mode persistence, dark restart, Agents page, pairing-only enrollment, switch/rename/remove gateway, unreachable/auth errors, Cmd+K |
| Pending writes | `pending-overlay.spec.ts` | 1 | Production inline Tally, Tasks, People, and Agenda routes over the real local gateway; visible offline add/RSVP controls and replica ⊕ outbox recovery across an Electron reload |
| Household | `household.spec.ts` | 2 | Roster, the owner's scopes and sharing surface as served; another person's seat changes presentation, never authorization |
| Docs journey | `docs-drive.spec.ts` | 1 | Byte-bearing north star (docs/apps/docs-scenarios.md): real staged upload through the visible control, Electron reload, byte-exact round-trip through the bearer transport, reading route opens |
| Locker journey | `locker.spec.ts` | 1 | Custodian-seat admission: first-open passphrase setup, item add over the live local gateway, relock on reload, item invisible until the same passphrase unlocks |

## Current architecture assumptions

- Every app the shell opens is an inline React route. The served-app plane — the sandboxed iframe host, the builder, and the previews and code-store apps they carried — retired in #799.
- A fresh desktop path uses the local gateway; the user explicitly chooses **Start fresh on this Mac** before it is founded.
- Gateway connections are pairing-only; tests must not reintroduce URL/token paste or SSH connect flows.
- The suite's fixture state is local to each test. Do not share a live gateway data directory or Electron profile across workers.

## Deferred or not applicable

The following remain untested or have no current UI surface: onboarding/settings fault injection; webhook-secret toast; nested/filter/pin run controls; publish-queue events; and the old Insights time-window/run-click scenarios. The builder and app-view scenarios that used to sit here went with their surfaces in #799. Add a test when the product surface exists; do not preserve a scenario by inventing a mock-only UI.

Run the suite from `apps/desktop`:

```sh
bun run test:e2e
```
