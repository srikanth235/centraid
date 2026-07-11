# issue-345 — Gateway component-level health + structured error tail

GitHub issue: [#345](https://github.com/srikanth235/centraid/issues/345)

Gateway uptime (`GET /centraid/_gateway/info`) only answers "is the process
alive" — it hides the failure mode that costs a self-hoster's trust: a
subsystem (outbox, scheduler, a broker connection, the phone tunnel) silently
stops working while the process keeps answering. This adds component-level
health: a `HealthRegistry` wired through every gateway subsystem, a
`GET /centraid/_gateway/health` route, and a desktop Settings → Diagnostics
screen that renders it.

## Checklist

- [x] HealthRegistry with push status
- [x] Wire the registry through buildGateway(): probes for vaults
- [x] GET /centraid/_gateway/health route, mounted behind the existing bearer auth
- [x] expose BuiltGateway.health
- [x] the Diagnostics screen: overall status banner with uptime + Refresh

## What changed

Gateway core (`packages/gateway`):

- `packages/gateway/src/serve/health-registry.ts` (new) — `HealthRegistry`
  with push status (`reportOk`/`reportDegraded`/`reportError`), a
  `loggerFor(component)` wrapper so existing `warn`/`error` calls join a
  bounded structured event tail, and pull-based `registerProbe` for state
  nobody pushes. Overall status is the worst component; a logged warn records
  an event without flipping status, an error does.
- `packages/gateway/src/serve/health-registry.test.ts` (new) — 9 unit tests
  covering transitions, the logger wrapper, the ring-buffer cap, probes, and
  uptime.
- `packages/gateway/src/routes/health-routes.ts` (new) — the
  `GET /centraid/_gateway/health` route, mounted behind the existing bearer
  auth (health detail is owner-facing, unlike the public-ish `_gateway/info`
  liveness probe).
- `packages/gateway/src/routes/health-routes.test.ts` (new) — 3 route tests
  (snapshot shape, live probe execution, 405/404 handling).
- `packages/gateway/src/serve/build-gateway.ts` — wire the registry through
  `buildGateway()`: probes for `vaults` (planes mounted) and `connections`
  (needs-auth count); push instrumentation on the outbox drain, the automation
  scheduler reconcile, automation run outcomes, and catalog warms; expose
  `BuiltGateway.health`; register `makeHealthRouteHandler(health)` in
  `extraHandlers`.
- `packages/gateway/src/serve/build-gateway.test.ts` — a new integration test
  asserting the health route serves through `composedHandler`, wired probes
  report correctly, and a host-pushed component (simulating the tunnel) joins
  the aggregate.
- `packages/gateway/src/serve/serve.ts` — thread `gateway.health` onto
  `GatewayServeHandle` so hosts (the desktop, the standalone daemon) can push
  their own components.
- `packages/gateway/src/index.ts` — export `HealthRegistry` and its types.

Desktop (`apps/desktop`):

- `apps/desktop/src/main/local-gateway.ts` — register a `tunnel` probe on
  `handle.health` sourced from `phoneLinkStatus()`, since the iroh phone
  tunnel lives in the Electron main process, outside `buildGateway()`.
- `apps/desktop/src/renderer/gateway-client.ts` — `getGatewayHealth()`,
  fetching `GET /centraid/_gateway/health`.
- `apps/desktop/src/renderer/centraid-api.d.ts` — `CentraidHealthComponent`,
  `CentraidHealthEvent`, `CentraidGatewayHealth` types (module export +
  `declare global` mirror, matching the file's existing convention).
- `apps/desktop/src/renderer/react/screens/SettingsDiagnosticsScreen.tsx`
  (new) — the Diagnostics screen: overall status banner with uptime + Refresh,
  per-component rows (a failing row leads with its last error), and the
  recent warn/error event tail.
- `apps/desktop/src/renderer/react/screens/SettingsDiagnosticsScreen.module.css`
  (new) — styling, following `SettingsConnectionsScreen`'s health-dot pattern.
- `apps/desktop/src/renderer/react/screens/SettingsDiagnosticsScreen.test.tsx`
  (new) — 4 tests (banner + rows, failing component + event tail, Refresh
  re-fetch, load error).
- `apps/desktop/src/renderer/react/shell/routes/settingsDiagnosticsData.ts`
  (new) — thin data-loader indirection (`loadDiagnosticsData`) keeping the
  screen HTTP-client-free, matching the other Settings pages' pattern.
- `apps/desktop/src/renderer/react/shell/routes/SettingsRoute.tsx` — new
  `diagnostics` page id, a `Gateway` section, and its render branch.
- `receipts/issue-345-gateway-health-diagnostics.md` (new) — this receipt.

## Decisions

- **A logged `warn` records an event but does not flip a component's status;
  only `error` does.** Transient warnings (a single catalog-warm retry, one
  slow reconcile) must not leave a component sticky-red on the Diagnostics
  screen — that would train the owner to ignore it. Errors flip status
  because they represent an actual failed operation.
- **Probe result wins over pushed status at snapshot time, for probed
  components.** `vaults` and `connections` are polled live (mount count,
  needs-auth count) rather than tracked incrementally, so a probe result
  always reflects "now," even if an earlier push recorded an error — the
  error history (`lastError`/`errorCount`) still survives the recovery for
  diagnosis.
- **`_gateway/health` sits behind bearer auth, unlike `_gateway/info`.**
  Health detail (error messages, connection counts) is owner-facing
  diagnostic material, not liveness-probe material a fronting proxy should
  see unauthenticated.
- **No alerting/push channel in this pass.** The issue scoped this to a
  request-driven snapshot; wiring a failing component to an OS notification
  or email is a natural follow-up but adds a delivery mechanism this issue
  didn't ask for.

## Out of scope

- Backup/restore verification, cert/credential expiry monitoring, cost/spend
  visibility — later observability work per the issue, not v0.
- A push/alerting channel for a failing component — status is surfaced on
  request only; alerting is a follow-up.
- The existing "Gateway runtime page + down alerts" work (main-process
  heartbeat + OS alert on downtime) is a separate, already-landed feature;
  this issue is component-level detail, not process-liveness alerting.

## Verification

- `packages/gateway` — `vitest run`: 43 files, 254 passed (1 pre-existing
  skip).
- `apps/desktop` — `vitest run`: 72 files, 441 passed.
- Full workspace `npm run build` and `npm run typecheck` clean.
- Real-gateway smoke: booted an actual `serve()` instance against a temp dir,
  confirmed 401 without the bearer token, 200 with it, live probe output
  (`"1 vault mounted"`, `"scheduler running for 1 vault"`), and a host-pushed
  `tunnel` error flipping the aggregate `status` to `"error"`.

```sh
( cd packages/gateway && npx vitest run )
( cd apps/desktop && npx vitest run )
npm run build && npm run typecheck
node - <<'NODE'
const { serve } = await import('./packages/gateway/dist/index.js');
const { mkdtempSync, rmSync } = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const dir = mkdtempSync(path.join(os.tmpdir(), 'health-smoke-'));
const h = await serve({ paths: { vaultDir: path.join(dir, 'vault'), prefsFile: path.join(dir, 'prefs.json') } });
const unauthed = await fetch(`${h.url}/centraid/_gateway/health`);
console.log('unauthed', unauthed.status); // 401
const res = await fetch(`${h.url}/centraid/_gateway/health`, { headers: { authorization: `Bearer ${h.token}` } });
console.log('authed', res.status, await res.json()); // 200 + snapshot
await h.close();
rmSync(dir, { recursive: true, force: true });
NODE
```

## Audit

Fresh-context sub-agent (haiku) verdict:

- **A1 — What changed matches the diff:** PASS — All 16 files listed in the
  receipt are present with accurate descriptions: 8 new files (HealthRegistry,
  health routes, desktop diagnostics screen) and 8 modified files wiring the
  registry through buildGateway, serve, and desktop components.
- **A2 — checked items realized in the diff:** PASS — All 5 checked items are
  fully implemented: HealthRegistry with push/loggerFor/probe/events
  (health-registry.ts), wired through buildGateway with probes for
  vaults/connections and instrumentation on outbox/automations/catalog
  (build-gateway.ts), health route at /centraid/_gateway/health
  (health-routes.ts), health exposed on BuiltGateway/GatewayServeHandle
  (serve.ts), and desktop Diagnostics screen with Refresh
  (SettingsDiagnosticsScreen.tsx).
- **A3 — checklist mirrors the issue:** PASS — Receipt's 5 checklist items
  correspond 1:1 to issue #345's Decision section: HealthRegistry, buildGateway
  wiring, health route, expose BuiltGateway.health, and desktop diagnostics
  screen.

## Steering

Fresh-context sub-agent (haiku) verdict:

- **B1 — all steering events recorded:** PASS — 168 user-authored JSONL
  entries found; 4 contain actual user text messages (initial task request,
  a v0-prioritization follow-up, an implement-it confirmation, and the
  issue+PR instruction). Zero were genuine steering/correction events.
- **B2 — no non-steering message recorded as steering:** PASS — No
  confirmation, follow-up question, or continuation message was
  mis-classified as a correction.
