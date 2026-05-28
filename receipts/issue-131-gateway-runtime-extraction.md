# issue-131 — Extract embedded runtime out of Electron so it can run standalone

GitHub issue: [#131](https://github.com/srikanth235/centraid/issues/131)

Lift the orchestration trapped inside `apps/desktop/src/main/local-runtime.ts`
into a host-agnostic `@centraid/gateway-runtime` package, then wrap it
two ways: the Electron embed (unchanged behavior) and a new
`centraid-gateway` standalone daemon. Same wire protocol — desktop and
mobile reach the daemon via the existing `kind: 'remote'` path; no new
`GatewayKind`, no `runtime-core` API change.

The Electron-embedded runtime today is essentially a private deployment
of a public protocol that's accidentally trapped inside Electron. The
mobile use case basically can't exist without this — there is no way
today for a phone to reach the user's own local data unless that data
lives in OpenClaw.

## Checklist

- [x] Commit 1 — `@centraid/gateway-runtime` package + `serve()`
- [x] Commit 2 — port `local-runtime.ts` to call `serve()`
- [x] Commit 3 — `centraid-gateway` CLI bin
- [x] Commit 4 — LAN bind enablement + integration test + README
- [x] Commit 5 — write-serialization audit in `runtime-core`

## What changed

### Commit 1 — `@centraid/gateway-runtime` package + `serve()`

New package at `packages/gateway-runtime/`. `serve(options)` is the
host-agnostic lift of what `ensureLocalRuntime` did inline: mkdir
appsDir → construct `makeGatewayDbProvider` / `AnalyticsStore` /
`UserStore` / `ChatHistoryStore` (lazy file open underneath) →
build a per-turn prefs loader closure → construct `makeChatRunner`
with the `runtimeRef` cycle-break → construct `Runtime` →
`startRuntimeHttpServer` → `runtime.bootstrap()` → fire-and-forget
OS-scheduler reconcile (opt-in via `schedulerHostFactory`).

Two injected ports keep the package free of host deps:

- `GatewayPaths` — absolute paths for `appsDir`, `identityDb`,
  `analyticsDb`, `chatRunnerSessionDir`, `codexHomeBaseDir`. No path
  derivation in the package — the Electron caller derives from
  `<userData>/gateways/<id>/`, the daemon from `<dataDir>/`.
- `SecretsProvider` — single async method `getProviderApiKey()`. The
  Electron caller wraps `safeStorage`; the daemon reads a sealed file.

`parseProviderPrefs` lives here too (it's the secret-free half of the
old `resolveProviderPrefs`). The async wrapper that splices in the
API key is reconstituted by each caller around its own `SecretsProvider`.

`serve.test.ts` covers boot, bearer auth, mkdir, store handles,
caller-supplied token + host, and the `runner-status` route.

### Commit 2 — port `local-runtime.ts` to call `serve()`

`apps/desktop/src/main/local-runtime.ts` shrinks from ~370 LOC to ~190.
The body of `ensureLocalRuntime` builds a `GatewayPaths` from
`gateway-paths.ts` and a `SecretsProvider` wrapping
`getProviderApiKey(gatewayId)`, then calls `serve({ paths, secrets,
schedulerHostFactory })` and stores the handle in the existing per-
gateway `handles` map.

Public export surface is identical so `ipc.ts`, `gateway-store.ts`, and
`settings.ts` are unaffected: `localRuntimeAppsDir`,
`localRuntimeCodexHomeBaseDir`, `localRuntimeGatewayDb`,
`localRuntimeAnalyticsDb`, `localRuntimeAutomationHost`,
`shutdownLocalRuntime`, `shutdownAllLocalRuntimesExcept`,
`noteRunnerPrefsChanged`, `parseProviderPrefs`, `resolveProviderPrefs`,
`ensureLocalRuntime` all keep the same names and shapes. The handle's
nominal type changed from `RuntimeHttpServerHandle` to
`GatewayServeHandle` but the structural shape `settings.ts` consumes
(`{ url, token }`) is unchanged.

Per-launch random token, loopback bind, lazy store construction, and
scheduler reconcile semantics are preserved. No migrations, no behavior
diff.

### Commit 3 — `centraid-gateway` CLI bin

Second consumer of `serve()`. New entry point at
`packages/gateway-runtime/src/cli.ts` registered as
`bin: { "centraid-gateway": "./dist/cli.js" }`. Subcommands:

- `serve [--config <path>] [--data-dir <path>] [--host <h>] [--port <p>]`
- `print-token --data-dir <path>`
- `--version`, `--help`

Wrapping additions (no orchestration changes):

- `cli-config.ts` — JSON config file with `dataDir`, `host`, `port`,
  `runner`, `provider` blocks. CLI flags override file fields.
- `cli-paths.ts` — `daemonLayoutFor(dataDir)` mirrors the Electron per-
  gateway tree without the `gateways/<id>/` segment: `<dataDir>/apps/`,
  `<dataDir>/identity.sqlite`, `<dataDir>/analytics.sqlite`,
  `<dataDir>/codex-home/`, `<dataDir>/chat-runner-sessions/`,
  `<dataDir>/token.bin`, `<dataDir>/provider-key.bin`.
- `cli-token.ts` — mint a 32-byte hex token on first boot, persist to
  `<dataDir>/token.bin` at mode `0o600`, reuse on subsequent boots.
- `cli-secrets.ts` — v0 stores the provider API key as plaintext at
  mode `0o600` and logs a one-line warning on startup. Honest about
  the gap vs. Electron's `safeStorage`.
- `cli-runner-prefs.ts` — `seedRunnerPrefs(userStore, config)` writes
  the config's `runner` / `provider` blocks into the identity DB's
  user-prefs row so the per-turn prefs loader inside `serve()` reads
  them unchanged. Keys absent from the config are explicitly cleared,
  so the config file stays the source of truth across re-seeds.
- SIGINT / SIGTERM handlers call `handle.close()` and exit 0.

`cli.test.ts` covers config validation, prefs-patch shape, layout
resolution, token mint/read, fs-secrets round-trip, plus an end-to-end
spawn → parse `listening on …` + `token: …` → bearer auth → SIGTERM →
clean exit.

### Commit 4 — LAN bind enablement + integration test + README

`--host` accepts `0.0.0.0`; nothing else needed for LAN bind. New
`serve-multiclient.test.ts` proves the multi-client contract:
client A uploads an app via `POST /centraid/_apps/<id>/upload`,
client B lists it via `GET /centraid/_apps` and static-serves it via
`GET /centraid/<id>/`. New `packages/gateway-runtime/README.md`
documents the daemon flow (paste URL + token into the desktop's "Add
remote gateway" form), the config file shape, and the v0 gaps (no TLS,
no per-device tokens, no mDNS, no OS keychain on daemon).

### Commit 5 — write-serialization audit in `runtime-core`

Today's Electron embed has effectively one client; the daemon is
reachable from multiple devices, so concurrent writers against shared
SQLite files are now a real case. Audit findings:

- **Missing `PRAGMA busy_timeout`** on every per-app and gateway
  opener: `handler-runner.ts`, `run-query.ts`, `gateway-db.ts:openDb`,
  `schema.ts`, `table-rows.ts`, all 4 sites in `app-settings.ts`.
  Without it, racing writers fail immediately with `SQLITE_BUSY`
  instead of backing off. Added `PRAGMA busy_timeout = 30000` to every
  hot-path opener. (Migrations already had it.)
- **Upload lock** — confirmed `route-handlers.ts:handleAppUpload`
  always goes through `withAppUploadLock` from `upload-lock.ts`. OK.
- **Registry writes** — confirmed `registry.ts` uses `writeFile`-to-tmp
  + atomic `rename`. OK.
- **Change-bus emit ordering** — confirmed `onWrite` fires from
  `handler-runner.ts:finish()` after the worker COMMITs, and from
  `run-query.ts` after `stmt.run()` (auto-commit on single-statement
  DML). Emit-after-commit invariant holds. OK.

New `concurrent-writers.test.ts` — 50 parallel `writeOp` calls against
the same `data.sqlite`: every write lands, every onWrite fires once,
totals add up. Second test exercises a polling reader concurrent with N
writers and asserts no `SQLITE_BUSY`. The 50-writer test would fail
deterministically without the new `busy_timeout`.

New `packages/runtime-core/README.md` adds a Concurrency section
documenting the model: WAL + foreign_keys + busy_timeout trio on every
opener, one-writer-at-a-time per file enforced by SQLite, change-bus
emit-after-commit invariant, upload-lock for version writes, atomic
rename for the registry.

## Verification

- `bun run build` — 9/9 packages compile, including the new
  `@centraid/gateway-runtime`.
- `bun run typecheck` — 18/18 tasks clean.
- `bun run check` — oxlint + oxfmt clean.
- `bun run test` — 14/14 turbo tasks. `runtime-core` 340/340 (incl.
  concurrent-writers); `gateway-runtime` 19/19 (incl. CLI spawn smoke
  + multi-client upload).

The desktop's byte-for-byte-identical behavior is the proof for commit
2; verified by build + typecheck. Manual `bun run dev:desktop` smoke
to send a chat turn requires the developer's environment with a runner
CLI installed — not a CI gate.

## What stays unchanged

- `runtime-core` public API — commit 5 adds `busy_timeout` to existing
  pragma blocks; no signature changes.
- `agent-runtime` — no changes.
- `openclaw-plugin` — keeps its own `Runtime` wiring. Converting it to
  call `serve()` would require touching the OpenClaw auth model,
  scheduler, and tools registration; out of scope.
- Desktop renderer, preload, mobile, design-tokens — no changes.
- `GatewayKind = 'local' | 'remote'` — no new kind; daemons surface
  through the existing `remote` path.

## Out of scope (explicit, per the issue)

Per-device tokens + revocation, TLS termination, tunneling docs
(Tailscale / Cloudflare), backup tooling, automated upgrade
migrations, mDNS / Bonjour discovery, multi-user identity,
cross-device chat resumption, daemon auto-update, replacing OpenClaw.
All build cleanly on top of the slice this PR lands without further
`runtime-core` changes.
