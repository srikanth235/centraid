# Desktop E2E scenarios

_Updated: 2026-08-01. The suite has 55 tests across seven spec files._

This is the current, executable coverage map for the real Electron app. A scenario is listed as covered only when a current Playwright spec proves it; older coverage claims are intentionally not carried forward.

| Area | Spec | Tests | Covered behavior |
| --- | --- | --: | --- |
| Launch | `launch-time.spec.ts` | 1 | Cold process start through usable Home |
| Onboarding and Home | `onboarding-home.spec.ts` | 10 | First-run CTA, auto-founded `Shared` + `Personal`, returning user, tiles/badges, empty state, rename, tile menu, app open, sidebar, command palette |
| Delete | `delete-app.spec.ts` | 8 | Draft/published delete, offline/404 behavior, cancel/Escape/Enter/backdrop dismissal |
| Builder | `builder.spec.ts` | 6 | New builder turn and tool pill, publish failure, preview iframe, existing-app edit, Code file tree, Logs filtering |
| App view / Discover / Analytics | `appview-templates-insights.spec.ts` | 6 | System app renders inline with no iframe, automation clone, independent drafts, empty gallery, Analytics hero |
| Automations | `automations.spec.ts` | 12 | List/error/retry, create/edit, enable/disable, webhook URL, delete, run viewer, success/failure timeline, nested tool transcript, rerun |
| Settings / gateways | `settings-gateways.spec.ts` | 12 | Theme and system mode persistence, dark restart, Agents page, pairing-only enrollment, switch/rename/remove gateway, unreachable/auth errors, Cmd+K |

## Current architecture assumptions

- Bundled system apps use the inline React route. Builder previews and user code-store apps use the served iframe path.
- A fresh desktop path uses the local gateway; the user explicitly chooses **Start fresh on this Mac** before it is founded.
- Gateway connections are pairing-only; tests must not reintroduce URL/token paste or SSH connect flows.
- The suite's fixture state is local to each test. Do not share a live gateway data directory or Electron profile across workers.

## Deferred or not applicable

The following remain untested or have no current UI surface: onboarding/settings fault injection; builder stop, attachments, file diff, title/history, device sizing, and refresh; app-view chat/model/settings; webhook-secret toast; nested/filter/pin run controls; iframe auth-header injection; publish-queue events; and the old Insights time-window/run-click scenarios. Add a test when the product surface exists; do not preserve a scenario by inventing a mock-only UI.

Run the suite from `apps/desktop`:

```sh
bun run test:e2e
```
