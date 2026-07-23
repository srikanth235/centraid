# Receipt — Issue #521: end-user resource respect

Issue: https://github.com/srikanth235/centraid/issues/521

## Checklist

- [x] Health responses expose RSS, event-loop lag, storage fsync (when known), and active hardware profile class; Diagnostics UI surfaces them with friendly labels (hardware-profile / event-loop / load-shed / disk) and human load-shed copy
- [x] Disk health uses free-space percent + absolute floor so small volumes degrade correctly
- [x] Durable Resource mode (Auto | Conserve | Balanced | Performance) maps onto existing profile resolution; active mode + resolved class on hardware-profile health detail
- [x] Owner-facing Resource mode control (not env-only)
- [x] In-repo tests for profile/mode, disk percent+floor, health metrics, diagnostics rendering
- [x] Receipt + PR

## What changed

Health responses expose RSS, event-loop lag, storage fsync (when known), and active hardware profile class; Diagnostics UI surfaces them with friendly labels (hardware-profile / event-loop / load-shed / disk) and human load-shed copy:

- `packages/gateway/src/serve/health-registry.ts` — metrics fields `hardwareProfileClass` / `resourceMode`; human load-shed detail via resource-mode helpers
- `packages/gateway/src/serve/resource-mode.ts` — mode parse/resolve, human event-loop / load-shed / RSS copy
- `packages/gateway/src/serve/resource-mode.test.ts`
- `packages/gateway/src/serve/health-registry.test.ts`
- `packages/gateway/src/serve/build-gateway.ts` — event-loop probe human detail; publish profile class/mode into metrics source
- `packages/gateway/src/index.ts` — export resource-mode / disk / profile helpers
- `packages/client/src/centraid-api.d.ts` — `CentraidHealthMetrics` on health payload
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.tsx` — metrics strip + friendly component labels
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.module.css`
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.test.tsx`

Disk health uses free-space percent + absolute floor so small volumes degrade correctly:

- `packages/gateway/src/serve/disk-health.ts` — `evaluateDiskFreeStatus` (percent OR absolute floor); detail includes `% free`
- `packages/gateway/src/serve/disk-health.test.ts` — small-volume percent + absolute floor cases

Durable Resource mode (Auto | Conserve | Balanced | Performance) maps onto existing profile resolution; active mode + resolved class on hardware-profile health detail:

- `packages/gateway/src/serve/hardware-profile.ts` — `resourceMode` on profile; Conserve/Balanced/Performance class + throughput tiers; `formatHardwareProfileDetail`
- `packages/gateway/src/serve/hardware-profile.test.ts`
- `packages/gateway/src/cli/config.ts` — optional daemon `resourceMode`
- `packages/gateway/src/cli/cli.ts` — pass config resourceMode into `serve`
- `packages/gateway/src/serve/build-gateway.ts` — resolve mode from env/prefs/options at boot; report hardware-profile detail
- `docs/config-ownership.md` — pref key + apply-on-boot ownership

Owner-facing Resource mode control (not env-only):

- `packages/client/src/react/screens/ResourceModeCard.tsx` — Auto/Conserve/Balanced/Performance UI writing `gateway.resourceMode`; refresh depends only on stable `loadMode` and ignores late GET results while a save is in flight
- `packages/client/src/react/screens/ResourceModeCard.test.tsx` — includes stable-loadMode re-render and mid-save stale-GET guards
- `packages/client/src/react/screens/GatewayScreen.tsx` — mount Resource mode card on Overview
- `packages/client/src/react/screens/GatewayScreen.module.css`
- `packages/client/src/react/shell/routes/GatewayRoute.tsx` — `useCallback` load/save prefs bridge (identity stable across 1s uptime ticks)
- `packages/client/src/centraid-api.d.ts` — module + `declare global` `CentraidHealthMetrics` / `CentraidGatewayHealth.metrics`

In-repo tests for profile/mode, disk percent+floor, health metrics, diagnostics rendering: covered by the `*.test.ts(x)` files listed above.

Receipt + PR: this file; PR opened for branch `feat/521-resource-respect`.

## Out of scope

- Quiet hours, on-battery auto-Conserve, thermal sensors, deferred-work queue (Phase 3)
- Lazy vault mount and other #456 evidence-gated designs
- Hot-apply of every worker env limit without gateway restart (mode is durable; applies on next serve; UI notes restart)

## Decisions

- One policy path only: Resource mode feeds existing `resolveGatewayHardwareProfile`; no second load-shed mechanism.
- Prefs (`gateway.resourceMode`) win over daemon config; env `CENTRAID_RESOURCE_MODE` wins over both (operator override).
- Performance raises standard-class concurrency rather than inventing a third hardware class.
- Disk thresholds use OR of percent and absolute floor so small SD cards and multi-TB disks both degrade correctly.
- Mode changes apply fully on next gateway restart (worker ceilings are process env at boot); acceptable per plan.

## Verification

```sh
bun run --cwd packages/gateway test -- src/serve/hardware-profile.test.ts src/serve/resource-mode.test.ts src/serve/disk-health.test.ts src/serve/health-registry.test.ts
bun run --cwd packages/client test -- src/react/screens/SettingsDiagnosticsScreen.test.tsx src/react/screens/ResourceModeCard.test.tsx
```

45 gateway + 13 client tests passed (ResourceModeCard race guards included). Built entry points also exercised: health snapshot metrics, Conserve vs Performance limits, disk percent on 32 GiB / 2 TiB volumes.

## Audit

**Check 1 — What changed faithfully describes the diff**
PASS – Tree matches the receipt’s major surfaces: `resource-mode.ts` parse/resolve + human event-loop/load-shed copy; `health-registry` metrics (`rssBytes`, event-loop lag, `storageFsyncMs`, `hardwareProfileClass`, `resourceMode`); `disk-health` `evaluateDiskFreeStatus` percent OR absolute floor with `% free` detail; `hardware-profile` mode→class/throughput + `formatHardwareProfileDetail`; `build-gateway` / CLI config mode wiring; Diagnostics metrics strip + friendly labels; `ResourceModeCard` on Gateway Overview + prefs bridge; tests and `docs/config-ownership.md`.

**Check 2 — All checked checklist items are realized in the diff**
PASS – Every `[x]` item is present in code: health metrics + Diagnostics UI labels/copy; disk percent+floor classifier and tests; Resource mode Auto|Conserve|Balanced|Performance feeding `resolveGatewayHardwareProfile` with mode+class on hardware-profile detail; owner UI writing `gateway.resourceMode` (not env-only); unit tests for profile/mode, disk, health-registry, diagnostics, ResourceModeCard; this receipt (PR branch noted).

**Check 3 — Checklist mirrors the issue**
PASS – Checklist text matches issue #521 acceptance bullets exactly (health legibility, disk percent+floor, durable Resource mode on profile path, owner-facing control, in-repo tests, receipt+PR). Out-of-scope Phase 3 items correctly excluded.

## Steering

**Check 1 — every human-steering event is recorded in ### Steering under ## Accounting**
PASS – No interrupt or mid-task correction; zero steering rows required. User authorized a multi-step implementation goal (“implement all this and create PR”) with a written plan; no mid-task human redirects after that authorization.

**Check 2 — no non-steering message is recorded as a steering event**
PASS – No false-positive steering rows; Accounting ### Steering table absent/empty because there were no steering events.

## Follow-up (PR review fixes)

- Stabilized ResourceModeCard refresh (`loadMode` deps + busyRef) and GatewayRoute `useCallback` bridges so 1s Overview ticks cannot re-fetch prefs or race mid-save.
- Mirrored `CentraidHealthMetrics` on the global `CentraidGatewayHealth` interface in `centraid-api.d.ts`.
