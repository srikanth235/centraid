# Desktop E2E scenarios

_Updated: 2026-08-11. The suite has 66 tests across eight spec files._

This is the current, executable coverage map for the real Electron app. A scenario is listed as covered only when a current Playwright spec proves it; older coverage claims are intentionally not carried forward.

| Area | Spec | Tests | Covered behavior |
| --- | --- | --: | --- |
| Launch | `launch-time.spec.ts` | 1 | Cold process start through usable Home |
| Onboarding and Home | `onboarding-home.spec.ts` | 18 | First-run CTA, auto-founded `Shared` + `Personal`, returning user, tiles/badges, empty state, rename, tile menu, app open, sidebar, command palette |
| Delete | `delete-app.spec.ts` | 8 | Draft/published delete, offline/404 behavior, cancel/Escape/Enter/backdrop dismissal |
| Builder | `builder.spec.ts` | 7 | New builder turn and tool pill, publish failure, preview iframe, existing-app edit, Code file tree, Logs filtering |
| App view / automation templates / Analytics | `appview-templates-insights.spec.ts` | 7 | System app renders inline with no iframe, automation clone survives a restart, independent drafts, Analytics hero |
| Automations | `automations.spec.ts` | 12 | List/error/retry, create/edit, enable/disable, webhook URL, delete, run viewer, success/failure timeline, nested tool transcript, rerun |
| Settings / gateways | `settings-gateways.spec.ts` | 12 | Theme and system mode persistence, dark restart, Agents page, pairing-only enrollment, switch/rename/remove gateway, unreachable/auth errors, Cmd+K |
| Offline durability | `offline-reload.spec.ts` | 1 | A Tally expense added while the gateway is unreachable still renders in the group ledger with its pending chip after a reload that is also offline (#738) |

## Current architecture assumptions

- Bundled system apps use the inline React route. Builder previews and user code-store apps use the served iframe path.
- A fresh desktop path uses the local gateway; the user explicitly chooses **Start fresh on this Mac** before it is founded.
- Gateway connections are pairing-only; tests must not reintroduce URL/token paste or SSH connect flows.
- The suite's fixture state is local to each test. Do not share a live gateway data directory or Electron profile across workers.
- **The replica plane needs a real daemon.** `startMockGateway` has no replica routes and answers `{}` to `/centraid/_vault/status`, so no vault is addressed and `openReplicaShellSession` refuses. The in-process embed the harness selects with `CENTRAID_EMBEDDED_GATEWAY=1` founds real vaults but passes no `devicePairing` to `serve()`, and `build-gateway` only hands the replica route handler an `EnrollmentStore` when `devicePairing` is present — so under the embed every replica request answers `replica_device_not_enrolled` (403). A scenario that needs a working replica (offline reads, queued writes, the pending-write overlay) must spawn `packages/gateway/dist/cli/cli.js serve` and reach it through the remote-profile seam, as `offline-reload.spec.ts` does. Build the gateway before running such a spec.
- **A durable outbox needs the offline copy switched on.** `seedRemoteGatewayProfile` writes `rememberDevice: false`, and with it off the replica opens in memory mode, so a reload legitimately loses queued writes. Turn it on through `window.CentraidApi.setGatewayRememberDevice` (the Settings → This device handler) and reload before relying on outbox durability.

## Deferred or not applicable

The following remain untested or have no current UI surface: onboarding/settings fault injection; builder stop, attachments, file diff, title/history, device sizing, and refresh; app-view chat/model/settings; webhook-secret toast; nested/filter/pin run controls; iframe auth-header injection; publish-queue events; and the old Insights time-window/run-click scenarios. Add a test when the product surface exists; do not preserve a scenario by inventing a mock-only UI.

Run the suite from `apps/desktop`:

```sh
bun run test:e2e
```
