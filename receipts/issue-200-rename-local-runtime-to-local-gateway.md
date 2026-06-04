# Issue #200 — rename local-runtime → local-gateway

Issue: #200

## Checklist
- [x] Rename local-runtime.ts to local-gateway.ts and its symbols to localGateway across importers

## What changed

### Rename local-runtime.ts to local-gateway.ts and its symbols to localGateway across importers
`apps/desktop/src/main/local-runtime.ts` is the Electron wrapper that
starts/stops embedded `@centraid/gateway` server instances. "Runtime" was
confusing — the gateway package owns an internal concept literally called
`Runtime`, and the desktop's runtime↔gateway relationship is 1:1, so the word
was a redundant alias colliding with a real type. The rest of the code already
speaks "local gateway" (handles keyed by `gatewayId`).

Renamed the file `local-runtime.ts` → `local-gateway.ts` and its exported
symbols across the four importers (`main.ts`, `gateway-store.ts`, `ipc.ts`,
`settings.ts`):
- `ensureLocalRuntime` → `ensureLocalGateway`
- `shutdownLocalRuntime` → `shutdownLocalGateway`
- `shutdownAllLocalRuntimesExcept` → `shutdownAllLocalGatewaysExcept`
- `localRuntimeAppsDir` → `localGatewayAppsDir`
- `localRuntimeGatewayDb` → `localGatewayIdentityDb` (also drops the awkward double "gateway")
- `localRuntimeAnalyticsDb` → `localGatewayAnalyticsDb`
- `setLocalRuntimeInfoProvider` → `setLocalGatewayInfoProvider` (+ internal `localRuntimeInfo` var, `local-gateway:` log tag)

Genuine uses of "runtime" were preserved: the gateway's `Runtime`, the per-app
`runtime.sqlite` filename, and the `runtimeMode` settings field.

## Out of scope
- Descriptive "in-process runtime" prose in `ipc.ts` / `settings.ts` /
  `gateway-store.ts` that isn't a direct reference to the renamed file/symbols
  was left as-is to keep the diff focused on the name.
- The pre-existing `@centraid/conversation-engine` cross-package typecheck
  resolution gap in the worktree (unrelated to this rename) is untouched.

## Verification
- `tsc -p tsconfig.json --noEmit` on `@centraid/desktop` surfaces no new errors
  from the rename — the only diagnostic is the pre-existing
  `@centraid/conversation-engine` module-resolution gap (confirmed present with
  the rename stashed, so not a regression).
- Repo-wide grep confirms zero remaining `localRuntime` / `LocalRuntime` /
  `local-runtime` identifiers or import paths.
