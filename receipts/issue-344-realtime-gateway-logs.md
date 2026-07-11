# issue-344 — Realtime gateway logs surfaced in the desktop UI (Settings → Gateway → Logs)

GitHub issue: [#344](https://github.com/srikanth235/centraid/issues/344)

Every gateway log line used to go straight to `console.*` and die there —
when a scheduled fire failed or the outbox deferred, the UI had nothing to
show. This change tees every `RuntimeLogger` line into a bounded in-memory
ring with live fan-out, exposes it over a bearer-protected JSON tail + SSE
stream, and gives the desktop a realtime Logs screen under a new
**Settings → Gateway** section.

## Checklist

- [x] Gateway log store
- [x] Gateway log routes
- [x] Gateway wiring and exports
- [x] Desktop logs client
- [x] Logs screen in Settings
- [x] Live E2E verification

## What changed

### Gateway log store

- `packages/gateway/src/serve/gateway-log-store.ts` (new): `GatewayLogStore`
  — a ring buffer (2000 entries) + subscriber fan-out, same shape as
  `RunEventBus`. Entries are `{ seq, ts, level, message }` with a monotonic
  `seq` so clients resume (`?after=`) and dedupe across reconnects.
  `wrap(inner)` returns a `RuntimeLogger` tee: capture into the store, then
  forward to the console/host logger unchanged.
- `packages/gateway/src/serve/gateway-log-store.test.ts` (new): seq
  monotonicity + `snapshot(after)`, ring eviction without seq reuse,
  subscribe/unsubscribe idempotence, wedged-subscriber isolation, and the
  `wrap` tee.

### Gateway log routes

- `packages/gateway/src/routes/logs-routes.ts` (new): `makeLogsRouteHandler`
  serving `GET /centraid/_logs` (one-shot JSON tail, `?after=<seq>` +
  `?limit=<n>`, newest entries win the cap) and `GET /centraid/_logs/events`
  (SSE: replay the buffer past `after`, then live until the client
  disconnects — headers/heartbeat/idempotent-cleanup mirror the automation
  run stream in `automations-routes.ts`; snapshot→subscribe is synchronous
  against the in-process store, so the stream is gapless).
- `packages/gateway/src/routes/logs-routes.test.ts` (new): URL fall-through,
  JSON tail + `after`/`limit`, 405 on non-GET, SSE replay-then-live with
  seq order, `?after=` resume, and disconnect-unsubscribes.

### Gateway wiring and exports

- `packages/gateway/src/serve/build-gateway.ts`: `buildGateway` constructs a
  `GatewayLogStore` and wraps its logger with it, so every existing call
  site (vault plane mounts, scheduler reconcile + fires, outbox executor,
  vault registry) is captured with zero call-site changes; mounts
  `makeLogsRouteHandler(logStore)` in `extraHandlers` (behind the
  app-engine bearer check); exposes the store as `BuiltGateway.logs`.
- `packages/gateway/src/serve/serve.ts`: `GatewayServeHandle` passes
  `logs` through (interface derives from `BuiltGateway`).
- `packages/gateway/src/index.ts`: exports `GatewayLogStore`,
  `GatewayLogEntry`, `GatewayLogLevel`.

### Desktop logs client

- `apps/desktop/src/renderer/gateway-client-logs.ts` (new):
  `fetchGatewayLogs()` (JSON tail) and `streamGatewayLogs(onEntry, signal,
  after?)` — fetch-based SSE so the Bearer + vault headers ride along,
  same transport and frame parsing as `streamAutomationRun`; abort
  resolves quietly, transport failures reject so the caller reconnects.
- `apps/desktop/src/renderer/gateway-client.ts`: re-exports the new module
  from the barrel.

### Logs screen in Settings

- `apps/desktop/src/renderer/react/screens/LogsScreen.tsx` (new):
  prop-driven screen owning the stream lifecycle — auto-reconnect (2s)
  resuming from the last seen `seq`, Live/Connecting/Reconnecting status
  dot, level filter (All / Warnings / Errors), text search, follow-tail
  with scroll detection + "Jump to latest", Copy (ISO-stamped lines for
  bug reports), Clear, client-side 2000-entry cap.
- `apps/desktop/src/renderer/react/screens/LogsScreen.module.css` (new):
  tokenized styles (mono log lines, level tints, status dot) matching the
  Connections screen's design vocabulary.
- `apps/desktop/src/renderer/react/shell/routes/SettingsRoute.tsx`: new
  `logs` page id under a new `Gateway` nav section, wired to
  `streamGatewayLogs`.

### Live E2E verification

- `apps/desktop/tests/e2e-live/verify-13-gateway-logs-realtime.mjs` (new):
  real-Electron rig (real embedded gateway, no mocks) — opens
  Settings → Logs, asserts the stream goes Live and replays boot lines,
  fires a real owner act over the wire (vault rename PATCH) and asserts
  the line lands live over the open SSE stream, then exercises the Errors
  filter, search, and Clear. Screenshots read as ground truth.

## Out of scope

- Persistence: the ring is in-memory per gateway process (restart = fresh);
  the durable per-run record stays the journal ledger.
- Per-app handler logs — that surface already exists
  (`/centraid/_apps/<id>/logs`).
- A gateway log-level knob; capture is unconditional and cheap.
- Main-process (Electron host) lines: `BuiltGateway.logs.append()` is
  exposed for hosts, but no host call sites were added here.

## Decisions

- Settings section (Gateway → Logs) rather than a top-level sidebar page —
  it's a diagnostics surface, not a daily destination.
- Fetch-based SSE (not `EventSource`) so the Bearer header rides — the
  established `streamAutomationRun` transport.
- No terminal SSE event: unlike a run stream, the log stream lives until
  the viewer disconnects; the client owns reconnect.

## Verification

- `vitest run packages/gateway` green — 43 files, 253 passed / 1 skipped,
  including the 12 new log-store + logs-routes tests.
- `apps/desktop` `vitest run` green — 71 files, 437 passed.
- `tsc` typecheck green across the workspace (21 turbo tasks); desktop
  `bun run typecheck` (test + react configs) green.
- `oxfmt --check` + `oxlint` clean on every file listed above.
- Live E2E verification: `verify-13-gateway-logs-realtime.mjs` — all 5
  steps PASS against the real Electron app + embedded gateway; screenshots
  under `apps/desktop/tests/e2e-live/out/verify/` confirm the rendered
  screen (Live badge, replayed boot lines, the rename line landing
  realtime, Errors-filter empty state, search narrowing).

Re-runnable:

```sh
bun install                                  # worktree-local node_modules
bunx vitest run packages/gateway             # includes the new suites
bun run build --filter=@centraid/desktop     # gateway dist + renderer bundle
node apps/desktop/tests/e2e-live/verify-13-gateway-logs-realtime.mjs
bunx oxfmt --check packages/gateway/src/serve/gateway-log-store.ts \
  packages/gateway/src/routes/logs-routes.ts \
  apps/desktop/src/renderer/gateway-client-logs.ts \
  apps/desktop/src/renderer/react/screens/LogsScreen.tsx
```

## Audit

Fresh-context sub-agent (haiku) verdict:

- **A1 — What changed matches the diff:** PASS — The receipt names 14 files (9 new, 5 modified) covering the gateway log store and routes, desktop log client and UI, E2E verification, and the receipt itself; the diff stat shows exactly these 14 files with no omissions or additions.
- **A2 — checked items realized in the diff:** PASS — All six checklist items are present and complete: (1) gateway-log-store.ts + tests with 2000-entry ring buffer and wrap() tee; (2) logs-routes.ts + tests for both /centraid/_logs (JSON tail) and /centraid/_logs/events (SSE); (3) build-gateway.ts, serve.ts, index.ts wiring the store and exporting types; (4) gateway-client-logs.ts with fetchGatewayLogs() and streamGatewayLogs() (fetch-based SSE); (5) LogsScreen.tsx, LogsScreen.module.css, SettingsRoute.tsx adding the screen to a new Gateway section with all specified features (status dot, filters, search, follow, copy, clear); (6) verify-13-gateway-logs-realtime.mjs E2E covering boot replay, live lines, filters, search, and clear.
- **A3 — checklist mirrors the issue:** PASS — The receipt's six checklist items directly map to issue #344's design section: the first three (log store, log routes, wiring) cover the gateway capture surface and routes; the final three (desktop client, logs screen, E2E) cover the viewer. The issue's specification of ring-buffer storage, SSE replay-then-live streaming, bearer-authenticated routes, and the Settings UI with filters/search/copy/clear are all realized and tested.

## Steering

Fresh-context sub-agent (haiku) verdict:

- **B1 — all steering events recorded:** PASS — 1 genuine human message found in transcript (the initial task request). Zero steering events detected; no human-initiated interruptions, corrections, or redirects occurred after the task began.
- **B2 — no non-steering message recorded as steering:** PASS — The receipt records no steering rows, consistent with zero steering events in the transcript.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->
