# Issue #435 — Photos shows a false consent banner when the vault pointer is unset; replica bridge requires an addressed vault

## Checklist

- [x] Replica bridge throws when `auth.vaultId` is unset.
- [x] `library.js` mislabels every error as a consent denial.
- [x] Build break: `@centraid/client:build` failed with TS2307 `node:sqlite`.
- [x] Desktop renderer assets resolve under file:// so the replica worker loads.

## What changed

### Checklist evidence

**Replica bridge throws when `auth.vaultId` is unset.** `addressedGatewayAuth()` lands in `packages/client/src/replica/shell-session.ts`: when the client-side pointer is unset ("let the gateway pick", #289), it asks the gateway which vault it is actually addressing via the already-on-the-wire `vaultStatus()` (`GET /centraid/_vault/status`) and folds that into the auth handed to `replicaIdentityForGatewayAuth`. The resolve is cached per gateway because `getReplicaShellSession` runs on every bridged read; a gateway that mounts no vault plane is deliberately NOT cached, so a vault mounted later is picked up on the next read. The alternative — guessing `listVaults()[0]` client-side — was rejected: the device-token transport resolves an unaddressed request to the oldest *enrollment* (`EnrollmentStore.vaultsFor()` order), not the lowest vault id, so a client guess would split-brain the replica's local store against every HTTP call. A gateway with no vault plane still raises the honest `ReplicaProtocolError('An addressed vault is required')`. Five tests in the new `packages/client/src/replica/shell-session-addressing.test.ts` cover explicit-vault passthrough (no status fetch), gateway resolve, per-gateway caching (one fetch for three concurrent calls), no-vault-plane error + re-ask, and failed-status degradation to the protocol error rather than a crash.

**`library.js` mislabels every error as a consent denial.** The catch-all in `packages/blueprints/apps/photos/queries/library.js` returned `vaultDenied` for any failure, sending the owner to fix a grant that was never the problem. Only `err.code === 'VAULT_CONSENT'` now maps to `vaultDenied`; every other failure (VAULT_ERROR, VAULT_UNAVAILABLE, replica protocol errors) surfaces as `error`, and `packages/blueprints/apps/photos/app.jsx` renders that resolved-with-error path through the existing `readFailed` notice — a broken vault must not look like an empty one. The same narrowing is applied to `queries/search.js`, `queries/duplicates.js` and `queries/enrichment-status.js` (behavior-neutral there: no consumer reads their `vaultDenied`).

**Build break: `@centraid/client:build` failed with TS2307 `node:sqlite`.** `packages/client/tsconfig.build.json` sets `"types": []`, stripping `@types/node`, so the test-only `node-sqlite-test-driver.ts` (imported only by `store-core.test.ts` and `store-docs-search.test.ts`) could not resolve `node:sqlite` under `bun run build` while `typecheck` (base tsconfig, hoisted `@types/node`) passed. The build config now excludes `src/**/*-test-driver.ts`.

**Desktop renderer assets resolve under file:// so the replica worker loads.** The shell document loads over `file://`, but `apps/desktop/vite.config.ts` left Vite's `base` at its default `/`, so every emitted asset URL was absolute. The replica's `new Worker(new URL('sqlite-worker.js', import.meta.url))` therefore resolved to `file:///assets/sqlite-worker-<hash>.js` — a path that exists nowhere on disk. The worker request was canceled, `ReplicaWorkerClient.onError` disposed the client, and every bridged read rejected with an `Error` carrying an empty message and no string `code`; `serializeReplicaError` fell back to `REPLICA_UNAVAILABLE` and the bridge substituted its generic "replica request failed", which the app surfaced as "Couldn't reach the vault". `base: './'` makes the emitted worker URL relative to `import.meta.url`, and the offline replica starts. Verified in the running desktop app: the worker and `sqlite3.wasm` load, `bootstrap`/`changes`/`checkpoint` return 200, and reads render from the replica.

### Changed paths

Modified:

- `apps/desktop/vite.config.ts`
- `packages/blueprints/apps/photos/app.jsx`
- `packages/blueprints/apps/photos/queries/duplicates.js`
- `packages/blueprints/apps/photos/queries/enrichment-status.js`
- `packages/blueprints/apps/photos/queries/library.js`
- `packages/blueprints/apps/photos/queries/search.js`
- `packages/client/src/replica/shell-session.ts`
- `packages/client/tsconfig.build.json`

Added:

- `packages/client/src/replica/shell-session-addressing.test.ts`

## Out of scope

- **The stale `vaults.json` legacy pointer.** The profile carries `{"active":"019f3337-…"}` naming a vault that no longer exists. It is inert (the registry ignores legacy single-vault files) and predates this work.
- **`chatModelByRunner` dropped on the settings write path.** Noticed while reading `setActiveVault`; unrelated to the replica, left for its own issue.
- **The same catch-all `vaultDenied` pattern in tasks/docs/tally/notes.** Photos is where it was observed and diagnosed; sweeping the other blueprint apps is a separate, behavior-affecting change.
- **A schema-behind vault failing the gateway's boot.** A vault created before a newer DDL crashes boot with a raw SQL error instead of a legible state. Filed separately; repo policy is v0/no-migrations, so this needs a `schemaBehind` affordance, not a migration.

## Decisions

- **Ask the gateway rather than guess the vault.** `addressedGatewayAuth()` spends a `GET /centraid/_vault/status` round trip (cached per gateway) instead of reading `listVaults()[0]` locally. The cheap local guess is wrong: the device-token transport resolves an unaddressed request to the oldest *enrollment* (`EnrollmentStore.vaultsFor()` order), while `listVaults()` is id-sorted. Where those disagree, the replica's local store would key on a different vault than every HTTP call — a silent split-brain. Only the gateway can answer authoritatively.
- **Do not cache "no vault plane".** When the status read yields nothing, the fallback is deliberately not memoized, so a vault mounted later is picked up on the next read rather than pinning "unknown" for the life of the renderer.
- **Fix the Vite `base`, not the worker URL.** The `file:///assets/…` miss could have been patched at the single worker call site, but the default `base: '/'` mis-resolves *every* emitted asset under `file://`; `base: './'` fixes the class, and the worker was simply its loudest symptom.
- **Narrow the consent branch instead of widening the banner.** `library.js` keeps returning a typed `vaultDenied` only for `VAULT_CONSENT`; everything else becomes `error`. Reporting a transport failure as a denial sends the owner to fix a grant that was never the problem — a broken vault must not look like an empty one.

## Verification

Automated:

```sh
cd packages/client && bun run test   # includes the 5 new shell-session-addressing tests
bun run typecheck && bun run build   # build is the gate the node:sqlite break failed
```

Manual (the bugs were all runtime-only; tests alone would not have caught the worker miss):

```sh
bun run dev:desktop
```

On a fresh profile: complete onboarding → Discover → install an app → open it. Confirmed the sqlite worker and `sqlite3.wasm` load (previously the worker request was canceled), `bootstrap`/`changes`/`checkpoint` return 200, no "No vault access yet" or "Couldn't reach the vault" banner appears, and a written note renders back from the replica.

## Audit

PASS

- **"What changed" faithfully describes the diff.** Receipt lists 8 modified + 1 added file. Verified against staged diff: all 9 paths exist in diff, no omissions. Each claim under checklist evidence is verified: (a) `addressedGatewayAuth()` function lands in `packages/client/src/replica/shell-session.ts` lines 854–883, calls `vaultStatus()`, caches per gateway key, handles no-vault-plane by returning undefined vaultId and letting `replicaIdentityForGatewayAuth` raise the protocol error; (b) `library.js` lines 181–189 check `err.code === 'VAULT_CONSENT'` before returning `vaultDenied`, else return error path; (c) `tsconfig.build.json` now excludes `src/**/*-test-driver.ts` in addition to test files; (d) `apps/desktop/vite.config.ts` line 15 sets `base: './'` with explanation comment.

- **Each checklist item is realized in the code.** All four [x] items verified: replica bridge `addressedGatewayAuth()` resolves unaddressed vault via gateway (new 5-test file `shell-session-addressing.test.ts` covers explicit passthrough, gateway resolve, per-gateway caching, no-vault-plane error + re-ask, failed status degradation); `library.js` + `search.js`/`duplicates.js`/`enrichment-status.js` narrowed to check `VAULT_CONSENT` only; `app.jsx` lines 126–134 render `data?.error` path through `readFailed()`; build excludes `*-test-driver.ts`; desktop `base: './'` makes worker URL relative.

- **Receipt's checklist mirrors the issue's checklist.** Issue #435 main has 3 items (unchecked [ ]); comment adds 4th item (unchecked [ ]). Receipt shows all 4 [x] checked, matching the implemented state. All wording identical.

## Steering

PASS

- **One genuine correction steering event is recorded.** At 2026-07-17T06:34:02.387Z, user message "why am i seeign couldn't reach the vault on first load?" corrects the agent's characterization that the "Couldn't reach the vault" notice is "transient" and clears on retry. Agent's prior statement (2026-07-17T06:32:28.318Z): "The transient 'Couldn't reach the vault' cleared on the next read, which is the honest retry path doing its job instead of a false consent banner." User's redirect causes agent to respond (2026-07-17T06:34:14.668Z): "Fair — I called it transient without evidence. Let me actually find out. Reloading the window and watching the renderer console:" This is a **correction** tier steering event — the user challenges the agent's assumption mid-task and the agent pivots to investigate rather than assert. Recorded below in steering table.

- **No non-steering message is recorded as steering.** Session contains tool results, system compaction events, and other assistant/system messages; the user's other inputs are initial problem statement (build error), screenshot + dev log context (investigation), task requests ("fix the bugs"), commands, and status checks — none are mid-task corrections or interrupts on the #435 work itself.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-d9a902af-1784277642-1 | d9a902af-877b-4579-9d81-b893be0e42fa | #435 | correction | classifier | why am i seeign couldn't reach the vault on first load? | pending | 1 | 2026-07-17T06:34:02.387Z |

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-d9a902af-877-1784277710-1 | claude-code | d9a902af-877b-4579-9d81-b893be0e42fa | #435 | claude-opus-4-8 | 998 | 1914845 | 73806109 | 343441 | 2259284 | 57.4619 | 998 | 1914845 | 73806109 | 343441 | fix(replica): address the vault the gateway picked and stop miscalling failures  |
| claude-code-d9a902af-877-1784277993-1 | claude-code | d9a902af-877b-4579-9d81-b893be0e42fa | #435 | claude-opus-4-8 | 6 | 9993 | 683686 | 3671 | 13670 | 0.4961 | 1004 | 1924838 | 74489795 | 347112 | fix(replica): address the vault the gateway picked and stop miscalling failures  |
| claude-code-d9a902af-877-1784278042-1 | claude-code | d9a902af-877b-4579-9d81-b893be0e42fa | #435 | claude-opus-4-8 | 4 | 747 | 466228 | 285 | 1036 | 0.2449 | 1008 | 1925585 | 74956023 | 347397 | fix(replica): probe (#435)Issue: #435 |
| claude-code-d9a902af-877-1784278229-1 | claude-code | d9a902af-877b-4579-9d81-b893be0e42fa | #435 | claude-opus-4-8 | 42 | 20337 | 5040076 | 7594 | 27973 | 2.8372 | 1050 | 1945922 | 79996099 | 354991 | fix(replica): address the vault the gateway picked and stop miscalling failures  |
| claude-code-d9a902af-877-1784278282-1 | claude-code | d9a902af-877b-4579-9d81-b893be0e42fa | #435 | claude-opus-4-8 | 8 | 16071 | 987026 | 1800 | 17879 | 0.6390 | 1058 | 1961993 | 80983125 | 356791 | fix(replica): address the vault the gateway picked and stop miscalling failures  |
| claude-code-d9a902af-877-1784278339-1 | claude-code | d9a902af-877b-4579-9d81-b893be0e42fa | #435 | claude-opus-4-8 | 4 | 7830 | 502732 | 1136 | 8970 | 0.3287 | 1062 | 1969823 | 81485857 | 357927 | fix(replica): address the vault the gateway picked and stop miscalling failures  |
