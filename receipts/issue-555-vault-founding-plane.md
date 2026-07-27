# Receipt — issue #555: Vault founding plane and device-local connections

Issue #555 replaces implicit vault bootstrap and split gateway/device state with an explicitly founded, lock-owned gateway. This is the single authoritative acceptance checklist; each checked item is backed by implementation and verification in this branch.

## Checklist

- [x] After a lease conflict clears, the WAL shipper re-arms within one tick; a crash + fast restart inside `LEASE_FRESH_WINDOW_MS` does not disable capture for the process's lifetime
- [x] Regression test drives the real sequence (claim → foreign-fresh lease → mount → conflict clears → shipper captures) and fails against today's `main`
- [x] A gateway with no `core_vault` row boots healthy, reports `status: "uninitialized"`, `/centraid/_vault/vaults` → `{"vaults":[]}`, and does NOT create a vault
- [x] Automations scheduler, health probes, and `/centraid/_apps` return explicit empty-but-healthy answers at zero vaults
- [x] Pairing against an uninitialized gateway returns `409 uninitialized` (no hang); the phone shows a sensible error
- [x] `centraid-gateway pair --vault` still requires an existing vault, and its failure on a virgin gateway points the operator at `init-ticket`
- [x] `VaultRegistry.delete()` no longer throws `vault_last`; zero vaults is a legal registry state with zero mounted planes
- [x] `serve --init-vault <name>` yields a ready vault headlessly, is documented as KIT-LESS, and every suite that assumed auto-bootstrap is migrated to it
- [x] A second gateway on the same root **exits immediately** with an actionable message; the first is unaffected and keeps serving
- [x] A mutating `--data-dir` CLI command refuses while the daemon holds the lock, pointing at it; a **read-only** CLI open succeeds
- [x] Killing the holder (`SIGKILL`) releases the lock with no cleanup step — the next start acquires immediately, with no freshness window
- [x] `lock-status` reports the holder by asking the running daemon, and reports "held, not answering" plus the OS-level holder when it is wedged; **no override flag exists**
- [x] `gateway.db` exists with its full schema at zero vaults, and `prefs.json` / `devices.json` / `tickets.json` / `recovery-kit.json` / `backup.json` / `storage/` are **gone** — nothing in the tree writes them
- [x] Redeeming a ticket and creating the first enrollment happen in **one transaction**: a crash injected between them leaves the ticket unredeemed and the gateway still foundable
- [x] Two concurrent redemptions of one founding ticket produce exactly one success — asserted against the rowcount, not a mutex
- [x] Revoking a device removes its web sessions by **`ON DELETE CASCADE`**, and severs the transport because the enrollment the QUIC listener admits on is gone
- [x] `gateway.db` **is** the lock: `PRAGMA locking_mode` is `EXCLUSIVE`, the handle is held for process lifetime, no `gateway.lock.db` is ever created, and no separate `-shm` sidecar appears
- [x] With the daemon **stopped or crash-looping**, `sqlite3 gateway.db` opens and reads normally — the case a separate lock file existed to serve is covered by the daemon not holding it
- [x] `gateway.db` has **no `vaults` table** — a test asserts vault enumeration still reads the filesystem, so the founding gate's zero-vaults precondition cannot disagree with the registry root
- [x] `GatewayInstanceLease`, `gateway.lease`, and all `leaseConflicted` plumbing are **gone**; WAL ownership is unconditional and no code path can disarm the shipper
- [x] A data dir on a network mount surfaces a health **warning**, not a refusal — **and** sets `skipOrphanDelete`, so blob GC never deletes under a possible cross-host writer
- [x] `endpoint.json` no longer exists; the `pair` and `status` CLIs derive `endpointId` from the identity key and obtain a live ticket from the running daemon, reporting a clear "daemon not running" when it is not
- [x] The desktop embed participates in the lock
- [x] **The data dir is identical in shape on a laptop and a VPS** — a test diffs the desktop-embedded tree against a `centraid-gateway serve --data-dir` tree after the same operations and asserts the entry sets match. `cli/paths.ts`'s layout header is rewritten to match, having documented six files that no longer exist
- [x] **No process other than the daemon writes into the data dir** — `profile.json`, `gateway.status.json`, `gateway.ownership.json`, and `token.bin` do not appear anywhere under it, on any platform, at any point in the lifecycle
- [x] The desktop's connection list renders **with no gateway running and no data dir present** (the remote case), from device-local storage rather than a `gateways/` directory scan
- [x] A remote-only gateway connection creates **no local directory at all** — adding, using, and forgetting it touches only device storage and the OS keychain
- [x] The registry is **one `connections.json`**, not a directory per connection, and both it and the credentials are owned by the desktop **main** process; a test asserts the renderer's `centraid.v1.` localStorage holds no connection record and no credential
- [x] A connection record carries `endpointId` and **no `url` and no `transport` field**; nothing in the codebase can add a gateway by URL, and the url/iroh XOR in `validateAddGatewayFields` is gone because there is no second branch
- [x] **`device_tokens`, `device-token-store.ts`, and the `cdt_…` prefix do not exist**; `gateway.db` has no such table, and no code path mints or resolves a bearer
- [x] **`POST /centraid/_gateway/pair` is gone** — pairing is iroh-only, and the web PWA pairs over iroh-wasm like every other client
- [x] **Revoking a device makes the QUIC handshake itself refuse** — a revoked device cannot open a connection at all, and `revocation-severs-planes.test.ts` (minus its token plane) still passes
- [x] `web_sessions` is unaffected: a browser control cookie still survives a gateway restart on its sliding window
- [x] **A gateway is identified by its EndpointId, not its address** — changing a relay hint, or losing it entirely, does not create a new connection or require re-pairing; the hint is refreshable cache, and no stored pairing ticket is treated as durable identity
- [x] **`iroh-device-key.bin` no longer exists in any gateway tree** — the device's iroh secret lives in `safeStorage` / Keychain / Keystore, keyed per connection, and its EndpointId still matches the enrolled `devices` row across a restart (the `ensureIrohDeviceKey` invariant survives the move)
- [x] `gateway-paths.ts`'s header lists what the directory actually contains — it currently omits `iroh-device-key.bin`, the ownership stamp, and the status file
- [x] `centraid-gateway serve` with **no `--data-dir`** resolves the platform default; `--data-dir` and `CENTRAID_DATA_DIR` still override, in that precedence
- [x] **The desktop, the CLI, and the OS service all land on the same data dir by default** — starting the second while the first runs hits the lock and exits, which is only possible once the default exists
- [x] **No gateway data lives under the desktop's `userData`** — a test asserts the resolved default is outside it, so removing the desktop application's data cannot delete a vault
- [x] Supervisor decisions no longer consult a pid for liveness: `isProcessAlive` and `startedAt` are gone, `stale-reclaim` reduces to "lock free, start", and `probe-failed-refuse` fires on lock-held-plus-no-answer
- [x] A daemon restart does not disturb any device's connection record or token — asserted for desktop and for a paired phone
- [x] A corrupt (non-32-byte) `endpoint-key.bin` **throws** with an actionable message naming both remedies; a corrupt device key re-mints with a warning
- [x] Minting goes through temp-file + rename: an interrupted first boot leaves either nothing or a complete key, never a short file
- [x] A `chmod 644` key self-heals to `0600` with a warning rather than refusing
- [x] All three call sites use the shared `@centraid/tunnel` loader with an explicit `onCorrupt` policy
- [x] Every sealing-key read/write in the codebase goes through `KeyStore`; no phase-3/4 code names `vault/keys/<vaultId>.sealkey` directly
- [x] **`keys/` is the only directory holding secrets**, and a test asserts no file under it parses as raw key material: the four secrets (vault DEKs, `connections.sealkey`, endpoint key, backup keyring) all live there, wrapped. The test sweeps the **whole data dir**, not just `keys/`, and passes with **no exemption list** — which is only possible because device credentials moved to devices
- [x] **`vault/` holds vault content only** — a test asserts no key, lock, or coordination file appears anywhere under it, and `ARCHITECTURE.md:131` becomes true rather than aspirational
- [x] Deleting `gateway.db` and `cache/` no longer destroys the master keys; the backup engine re-seeds fencing from the provider and reads existing snapshots on the surviving keyring
- [x] **No key material lives in `gateway.db`** — a test greps every table for raw or base64 key bytes; the one sealed column holds ciphertext whose key is in `keys/`
- [x] `keys/` custody survives the fold: `LoadCredentialEncrypted=` still points at a real path, and crypto-erase is still a single `unlink` with no `VACUUM` in the erase path
- [x] `backup/` and `storage/` no longer exist: keyring in `keys/`, code bundles in `cache/`, state in `gateway.db`; no code or doc comment references a `staging/` dir
- [x] `sourceInstanceId` is derived (`HMAC(endpointSecret, "backup-source")`), not stored; it is stable across a restart and a lost `gateway.db`, and is not computable by a provider holding the public endpoint id
- [x] `local-usage.ts`'s storage components match the new layout — the `backup` component no longer claims to walk a keyring or a staging dir
- [x] No `custody.json` or equivalent index exists; wrapping scheme is read off the envelope
- [x] On desktop with `safeStorage` available, the at-rest key is wrapped, and **a `<dataDir>` copied to another machine cannot open its sealed columns**
- [x] On Linux desktop without libsecret, the store degrades to the 0600 file with a warning rather than failing
- [x] Headless keeps the 0600 file with a pluggable wrap seam; no passphrase-at-boot path exists
- [x] Per-vault DEKs are independent — no code path re-derives a vault's key from a master keyring
- [x] A store opening a pre-existing plaintext key adopts and (where supported) wraps it in place, preserving the `core_vault` fingerprint check
- [x] `resolveSealKey`'s no-key / right-key / wrong-key distinction and `.sealkey.next` rotation completion survive the refactor
- [x] SECURITY.md states the headless boundary explicitly
- [x] `POST /centraid/_vault/vaults:initialize` creates a vault only for a landlord-authorized caller (loopback, or a redeemed founding ticket) and only at zero vaults — otherwise `409`
- [x] `vaults:restore` sits behind the **same** gate, and `recoverHandler` no longer has an admin-plane mount
- [x] A founding ticket is one-time and short-lived (10 min); a second redemption fails, minting a new one invalidates the prior, and it is refused once a vault exists
- [x] **VPS + phone journey with no desktop anywhere:** SSH → `init-ticket` → redeem on phone → full ceremony on the phone → kit saved off-device via the share sheet → vault ready
- [x] Desktop founds through the same gate: afterwards `desktop-loopback-token.bin` does not exist, the desktop holds an `owner`-trust enrollment keyed to its own iroh EndpointId (secret in `safeStorage`), and a daemon restart does not break re-adoption
- [x] `desktop-loopback-token.bin` is excluded from the backup tarball
- [x] First-run shows Create / Restore as peer paths; no Home until one completes; a device pairing into a founded gateway never sees either
- [x] Create ceremony gates in order: password → wrapped kit delivered → mandatory re-select verify (fingerprint check) → loss-consent checkbox. None skippable
- [x] The kit is a passphrase-wrapped file containing keyring + sealing key + target addressing, excluding provider credentials; the wrap uses scrypt with `{kdf,N,r,p,salt}` in the header; `parseRecoveryKit` round-trips it
- [x] Restore accepts kit + password and completes the recover flow to an adopted vault with **sealed columns readable**, with both the sealing key and the keyring placed via `KeyStore.import()`; the next backup runs on the restored keyring
- [x] A founding ticket and a pairing ticket share one file and one store; a founding ticket carries no `vaultId` and a pairing ticket still requires one
- [x] Adding a backup target, rotating an epoch, **or creating a second vault** flags the kit stale and surfaces exactly one re-download prompt; re-downloading an unchanged kit does not
- [x] **A gateway with two backed-up vaults has both sealing keys in one kit**, each in its own target row, and restoring from it makes **both** vaults' sealed columns readable. A test creates vault B after the kit was written and asserts the fingerprint went stale
- [x] **A local-only vault stays local-only**: creating a vault opts it into neither remote CAS nor a backup target, it has no row in the kit, and it costs zero offsite bytes. Creating one does **not** flag the kit stale (there is nothing new to protect)
- [x] Ceremony copy says the kit unlocks **backed-up** vaults, not "everything"; a gateway holding one backed-up and one local-only vault says so where the kit is presented
- [x] Enabling remote CAS on a vault with no backup target degrades a health component and warns at the point of opt-in, naming the consequence (offsite bytes that no kit can decrypt)
- [x] `BackupState.recoveryKit` and the `backup-service.ts:1667` fallback are gone; the `recovery_kit` row is the only representation of kit confirmation
- [x] Erase: typed-name confirm → fence/generation bump → gateway returns to uninitialized → first-run shown
- [x] Erasing the LAST vault succeeds and leaves the registry with zero mounted planes
- [x] After erase, no row in any `gateway.db` table references the erased vaultId; a previously-paired device gets a clean re-pair prompt, not a token for a dead vault
- [x] **The post-erase tree diffs clean against the vaultless layout** — the test is a tree comparison, not a deletion checklist, so a file added later cannot silently survive an erase
- [x] `KeyStore.destroy()` removes the key and `.sealkey.next` in every at-rest form; a pre-erase directory copy cannot decrypt sealed columns. The #298 amendment is documented
- [x] `kitFingerprint` + confirmation flag persist at the gateway level and survive an erase — a fresh create overwrites them; an erase alone does not resurrect a stale kit prompt
- [x] Gateway identity files are byte-identical across an erase
- [x] **Erase → restore on the same box** preserves the endpoint identity byte-for-byte, leaves zero enrollments, and a previously-paired device gets a clean re-pair prompt
- [x] No `admin` plane exists in gateway source; every request resolves to a real enrollment in a specific vault, and nothing is implicitly enrolled in all of them
- [x] A request with no resolvable device identity **fails closed**, and a regression test asserts it (today it would succeed with wildcard reach)
- [x] The loopback embed and every test suite that relied on implicit universal access hold real enrollments
- [x] A newly paired (non-founding) device lands at `full` trust, not `owner`
- [x] Revoking the last `owner` enrollment requires typed confirmation naming the consequence, and the SSH/CLI recovery from that state is tested

## What changed

- Phase 0 landed first and independently in branch commit `d194e2d6`: its regression drives claim → foreign-fresh lease → mount → conflict clears → shipper captures, and the production change re-arms capture within one tick. Phase 1 then follows issue #555's explicit instruction that “Its test retires with the lease” by deleting `GatewayInstanceLease` and making WAL ownership unconditional; the ordered commit diff preserves the live-bug regression while the final tree makes its failure mode unrepresentable.
- Gateway startup is explicitly vaultless. A complete `gateway.db` is created before any vault, holds the process-lifetime exclusive lock, and owns preferences, enrollments, pairing/founding tickets, web sessions, backup metadata, storage limits, recovery-kit state, and erase intents.
- The retired split-state and lease model is gone from the final tree. Vault discovery stays filesystem-backed, the shipper and WAL ownership remain unconditional, and only the capture clock sleeps while no backup destination is configured—preserving the established no-unconfigured-spool contract and zero idle physical writes. Network filesystems warn and force orphan-safe blob behavior, and laptop/VPS layouts are parity-tested.
- Gateway connections are iroh-only and keyed by stable EndpointId. Desktop connection metadata lives in one main-process-owned `connections.json`; device credentials live in platform custody, relay tickets remain refreshable hints, and no URL/direct-token pairing path remains.
- The web PWA E2E harness persists that same EndpointId + endpoint-ticket contract and adapts only its transport boundary to the loopback control proxy, keeping browser behavior coverage aligned without reviving the retired direct connection shape.
- Secret custody is centralized through `KeyStore`. Endpoint identity, per-vault sealing keys, the backup keyring, and connection sealing material live under `keys/`; desktop custody uses `safeStorage`, headless custody uses the documented 0600 fallback, and copied data directories cannot be opened under another device's custody key. The container now persists the external wrapping credential in an independently mounted `/config` custody volume alongside the wrapped `/data` volume.
- Founding create and restore share one zero-vault authorization boundary. Reservation state is crash-recoverable, ticket redemption and first-owner enrollment commit atomically, and concurrent redemption is enforced by SQLite rowcount.
- Desktop and phone use the same ordered, non-skippable ceremony: password, wrapped-kit delivery, re-selection and cryptographic verification, explicit loss consent, then entry. The desktop loopback embed can mint and consume its direct-host founding envelope, recovery-kit Blob URLs remain alive long enough for Electron to download them, and the E2E fixture exercises the real ceremony in an isolated gateway root. The complete-tree fixtures seed the same fresh pricing cache on both sides, so the unrelated background catalog refresh cannot race the snapshot or write after teardown. VPS-with-phone founding is covered without a desktop.
- Erase is a crash-safe transition back to the uninitialized layout. It bumps backup fencing, removes all vault references and custody material, preserves gateway identity, severs prior enrollments, and supports restoring on the same host.
- Authorization fails closed around concrete per-vault enrollments. Ordinary pairing grants `full`, founding grants the first `owner`, last-owner revocation requires typed confirmation, and CLI recovery is tested.

### Acceptance evidence crosswalk

- After a lease conflict clears, the WAL shipper re-arms within one tick; a crash + fast restart inside `LEASE_FRESH_WINDOW_MS` does not disable capture for the process's lifetime — Evidence: the ordered diff for branch commit `d194e2d6`, which lands the Phase 0 production repair and regression before Phase 1 removes the lease exactly as specified.
- Regression test drives the real sequence (claim → foreign-fresh lease → mount → conflict clears → shipper captures) and fails against today's `main` — Evidence: `git show d194e2d6:packages/gateway/src/serve/vault-plane.test.ts` contains `WAL capture re-arms after a fresh foreign lease conflict clears`; the pre-fix constructor leaves `walShipper` undefined after the conflict clears, while commit `d194e2d6` re-evaluates ownership on `walTick`. Issue #555 explicitly requires this test to retire with the lease in Phase 1, so it is visible in the ordered commit diff rather than the final tree.
- A gateway with no `core_vault` row boots healthy, reports `status: "uninitialized"`, `/centraid/_vault/vaults` → `{"vaults":[]}`, and does NOT create a vault — Evidence: `packages/gateway/src/serve/build-gateway.test.ts` vaultless HTTP integration.
- Automations scheduler, health probes, and `/centraid/_apps` return explicit empty-but-healthy answers at zero vaults — Evidence: `packages/gateway/src/serve/build-gateway.test.ts` zero-vault apps/automations/health assertions.
- Pairing against an uninitialized gateway returns `409 uninitialized` (no hang); the phone shows a sensible error — Evidence: `packages/gateway/src/cli/admin.test.ts`, `packages/gateway/src/serve/build-gateway.test.ts`, and mobile founding error handling.
- `centraid-gateway pair --vault` still requires an existing vault, and its failure on a virgin gateway points the operator at `init-ticket` — Evidence: `packages/gateway/src/cli/admin.test.ts` virgin-gateway pairing refusal.
- `VaultRegistry.delete()` no longer throws `vault_last`; zero vaults is a legal registry state with zero mounted planes — Evidence: `packages/gateway/src/serve/vault-registry.test.ts` and erase integration.
- `serve --init-vault <name>` yields a ready vault headlessly, is documented as KIT-LESS, and every suite that assumed auto-bootstrap is migrated to it — Evidence: `packages/gateway/src/cli/cli.test.ts`, `packages/gateway/README.md`, and migrated gateway suites.
- A second gateway on the same root **exits immediately** with an actionable message; the first is unaffected and keeps serving — Evidence: `packages/gateway/src/serve/gateway-db.test.ts` exclusive contention.
- A mutating `--data-dir` CLI command refuses while the daemon holds the lock, pointing at it; a **read-only** CLI open succeeds — Evidence: `packages/gateway/src/cli/lock-admin.test.ts` mutating refusal/read-only list integration.
- Killing the holder (`SIGKILL`) releases the lock with no cleanup step — the next start acquires immediately, with no freshness window — Evidence: `packages/gateway/src/serve/gateway-db-lock.integration.test.ts` real child `SIGKILL` and immediate reacquire.
- `lock-status` reports the holder by asking the running daemon, and reports "held, not answering" plus the OS-level holder when it is wedged; **no override flag exists** — Evidence: `packages/gateway/src/cli/lock-admin.test.ts` plus `packages/gateway/src/serve/gateway-db-lock.integration.test.ts` with real `lsof` holder PID.
- `gateway.db` exists with its full schema at zero vaults, and `prefs.json` / `devices.json` / `tickets.json` / `recovery-kit.json` / `backup.json` / `storage/` are **gone** — nothing in the tree writes them — Evidence: `packages/gateway/src/serve/gateway-db.test.ts` schema and retired-path sweep.
- Redeeming a ticket and creating the first enrollment happen in **one transaction**: a crash injected between them leaves the ticket unredeemed and the gateway still foundable — Evidence: `packages/gateway/src/serve/device-plane.test.ts` injected rollback between redeem and enrollment.
- Two concurrent redemptions of one founding ticket produce exactly one success — asserted against the rowcount, not a mutex — Evidence: `packages/gateway/src/serve/device-plane.test.ts` concurrent founding redemption/SQLite rowcount.
- Revoking a device removes its web sessions by **`ON DELETE CASCADE`**, and severs the transport because the enrollment the QUIC listener admits on is gone — Evidence: `packages/gateway/src/serve/gateway-db.test.ts` cascade plus `device-pairing-lifecycle.mjs` QUIC refusal.
- `gateway.db` **is** the lock: `PRAGMA locking_mode` is `EXCLUSIVE`, the handle is held for process lifetime, no `gateway.lock.db` is ever created, and no separate `-shm` sidecar appears — Evidence: `packages/gateway/src/serve/gateway-db.test.ts` locking-mode and sidecar assertions.
- With the daemon **stopped or crash-looping**, `sqlite3 gateway.db` opens and reads normally — the case a separate lock file existed to serve is covered by the daemon not holding it — Evidence: `packages/gateway/src/serve/gateway-db-lock.integration.test.ts` post-`SIGKILL` `sqlite3` read.
- `gateway.db` has **no `vaults` table** — a test asserts vault enumeration still reads the filesystem, so the founding gate's zero-vaults precondition cannot disagree with the registry root — Evidence: `packages/gateway/src/serve/gateway-db.test.ts` no-vault-table assertion and filesystem registry coverage.
- `GatewayInstanceLease`, `gateway.lease`, and all `leaseConflicted` plumbing are **gone**; WAL ownership is unconditional and no code path can disarm the shipper — Evidence: source absence checks plus `packages/gateway/src/serve/vault-plane.test.ts` coverage that the same shipper remains owned while configuration only arms/sleeps its capture clock; the 65-second constrained-hardware gate records zero unconfigured idle writes and zero live-data growth.
- A data dir on a network mount surfaces a health **warning**, not a refusal — **and** sets `skipOrphanDelete`, so blob GC never deletes under a possible cross-host writer — Evidence: `packages/gateway/src/serve/build-gateway.test.ts` health/wiring and `vault-plane-blob-sweep.test.ts` fail-safe deletion gate.
- `endpoint.json` no longer exists; the `pair` and `status` CLIs derive `endpointId` from the identity key and obtain a live ticket from the running daemon, reporting a clear "daemon not running" when it is not — Evidence: `packages/gateway/src/cli/admin.test.ts`, `status-admin.test.ts`, and retired-path sweep.
- The desktop embed participates in the lock — Evidence: desktop embedded startup uses the same `GatewayDatabase` lifetime lock; covered by `embedded-gateway-layout.test.ts`.
- **The data dir is identical in shape on a laptop and a VPS** — a test diffs the desktop-embedded tree against a `centraid-gateway serve --data-dir` tree after the same operations and asserts the entry sets match. `cli/paths.ts`'s layout header is rewritten to match, having documented six files that no longer exist — Evidence: `apps/desktop/src/main/embedded-gateway-layout.test.ts` exercises the production embed and full headless entry set without exclusions.
- **No process other than the daemon writes into the data dir** — `profile.json`, `gateway.status.json`, `gateway.ownership.json`, and `token.bin` do not appear anywhere under it, on any platform, at any point in the lifecycle — Evidence: `packages/gateway/src/serve/gateway-db.test.ts`, desktop path tests, and layout parity.
- The desktop's connection list renders **with no gateway running and no data dir present** (the remote case), from device-local storage rather than a `gateways/` directory scan — Evidence: `apps/desktop/src/main/gateway-store.test.ts` device-local list with no gateway data dir.
- A remote-only gateway connection creates **no local directory at all** — adding, using, and forgetting it touches only device storage and the OS keychain — Evidence: `apps/desktop/src/main/gateway-store.test.ts` complete remote add/use/forget lifecycle.
- The registry is **one `connections.json`**, not a directory per connection, and both it and the credentials are owned by the desktop **main** process; a test asserts the renderer's `centraid.v1.` localStorage holds no connection record and no credential — Evidence: `apps/desktop/src/main/gateway-store.test.ts` main-owned single registry and renderer-storage assertion.
- A connection record carries `endpointId` and **no `url` and no `transport` field**; nothing in the codebase can add a gateway by URL, and the url/iroh XOR in `validateAddGatewayFields` is gone because there is no second branch — Evidence: `apps/desktop/src/main/gateway-store.test.ts` EndpointId-only record assertions.
- **`device_tokens`, `device-token-store.ts`, and the `cdt_…` prefix do not exist**; `gateway.db` has no such table, and no code path mints or resolves a bearer — Evidence: `packages/gateway/src/serve/gateway-db.test.ts` schema plus repository absence checks.
- **`POST /centraid/_gateway/pair` is gone** — pairing is iroh-only, and the web PWA pairs over iroh-wasm like every other client — Evidence: route/protocol absence checks and iroh-only client/desktop/mobile implementation.
- **Revoking a device makes the QUIC handshake itself refuse** — a revoked device cannot open a connection at all, and `revocation-severs-planes.test.ts` (minus its token plane) still passes — Evidence: `tests/agent-e2e-pairing/flows/device-pairing-lifecycle.mjs` revocation at QUIC admission.
- `web_sessions` is unaffected: a browser control cookie still survives a gateway restart on its sliding window — Evidence: `packages/gateway/src/serve/web-app-sessions.contract.test.ts` restart persistence.
- **A gateway is identified by its EndpointId, not its address** — changing a relay hint, or losing it entirely, does not create a new connection or require re-pairing; the hint is refreshable cache, and no stored pairing ticket is treated as durable identity — Evidence: `apps/desktop/src/main/gateway-store.test.ts` relay-hint refresh identity coverage.
- **`iroh-device-key.bin` no longer exists in any gateway tree** — the device's iroh secret lives in `safeStorage` / Keychain / Keystore, keyed per connection, and its EndpointId still matches the enrolled `devices` row across a restart (the `ensureIrohDeviceKey` invariant survives the move) — Evidence: `apps/desktop/src/main/gateway-secrets.test.ts`, `iroh-dialer.ts`, and retired-file sweep.
- `gateway-paths.ts`'s header lists what the directory actually contains — it currently omits `iroh-device-key.bin`, the ownership stamp, and the status file — Evidence: `apps/desktop/src/main/gateway-paths.ts` header and layout tests.
- `centraid-gateway serve` with **no `--data-dir`** resolves the platform default; `--data-dir` and `CENTRAID_DATA_DIR` still override, in that precedence — Evidence: `packages/gateway/src/cli/cli.test.ts` and data-dir resolver tests.
- **The desktop, the CLI, and the OS service all land on the same data dir by default** — starting the second while the first runs hits the lock and exits, which is only possible once the default exists — Evidence: `apps/desktop/src/main/gateway-paths.ts`, service-unit tests, and lock contention tests.
- **No gateway data lives under the desktop's `userData`** — a test asserts the resolved default is outside it, so removing the desktop application's data cannot delete a vault — Evidence: `apps/desktop/src/main/gateway-ops-core.test.ts` and gateway-path tests.
- Supervisor decisions no longer consult a pid for liveness: `isProcessAlive` and `startedAt` are gone, `stale-reclaim` reduces to "lock free, start", and `probe-failed-refuse` fires on lock-held-plus-no-answer — Evidence: `apps/desktop/src/main/gateway-ops-core.test.ts` lock-informed supervisor branches.
- A daemon restart does not disturb any device's connection record or token — asserted for desktop and for a paired phone — Evidence: `device-pairing-lifecycle.mjs`, `vps-phone-founding.mjs`, and desktop registry persistence tests.
- A corrupt (non-32-byte) `endpoint-key.bin` **throws** with an actionable message naming both remedies; a corrupt device key re-mints with a warning — Evidence: `packages/tunnel/src/endpoint-secret.test.ts` and canonical `keys/endpoint-key.bin` call sites.
- Minting goes through temp-file + rename: an interrupted first boot leaves either nothing or a complete key, never a short file — Evidence: `packages/vault/src/schema/key-store.test.ts` interruption injection before atomic rename.
- A `chmod 644` key self-heals to `0600` with a warning rather than refusing — Evidence: `packages/vault/src/schema/key-store.test.ts` mode repair and warning.
- All three call sites use the shared `@centraid/tunnel` loader with an explicit `onCorrupt` policy — Evidence: exactly three production `loadEndpointSecret` call sites, each with explicit `onCorrupt`, plus tunnel loader tests.
- Every sealing-key read/write in the codebase goes through `KeyStore`; no phase-3/4 code names `vault/keys/<vaultId>.sealkey` directly — Evidence: `packages/vault/src/schema/sealed.ts`, KeyStore conformance, and repository path checks.
- **`keys/` is the only directory holding secrets**, and a test asserts no file under it parses as raw key material: the four secrets (vault DEKs, `connections.sealkey`, endpoint key, backup keyring) all live there, wrapped. The test sweeps the **whole data dir**, not just `keys/`, and passes with **no exemption list** — which is only possible because device credentials moved to devices — Evidence: `packages/gateway/src/cli/key-store.test.ts`, `packages/vault/src/schema/key-store.test.ts`, and gateway-wide secret sweep.
- **`vault/` holds vault content only** — a test asserts no key, lock, or coordination file appears anywhere under it, and `ARCHITECTURE.md:131` becomes true rather than aspirational — Evidence: `apps/desktop/src/main/embedded-gateway-layout.test.ts` and vault layout invariant tests/docs.
- Deleting `gateway.db` and `cache/` no longer destroys the master keys; the backup engine re-seeds fencing from the provider and reads existing snapshots on the surviving keyring — Evidence: `packages/gateway/src/backup/recover.integration.test.ts` and backup keyring recovery tests.
- **No key material lives in `gateway.db`** — a test greps every table for raw or base64 key bytes; the one sealed column holds ciphertext whose key is in `keys/` — Evidence: `packages/gateway/src/serve/gateway-db.test.ts` scans every table and the whole data tree.
- `keys/` custody survives the fold: `LoadCredentialEncrypted=` still points at a real path, and crypto-erase is still a single `unlink` with no `VACUUM` in the erase path — Evidence: `packages/gateway/src/cli/service-unit.test.ts`, service-admin tests, vault erase tests, and the Docker/container smoke contract that mounts `/config` separately and asserts the external credential exists without printing it.
- `backup/` and `storage/` no longer exist: keyring in `keys/`, code bundles in `cache/`, state in `gateway.db`; no code or doc comment references a `staging/` dir — Evidence: `packages/gateway/src/serve/gateway-db.test.ts`, layout parity, and source/doc absence checks.
- `sourceInstanceId` is derived (`HMAC(endpointSecret, "backup-source")`), not stored; it is stable across a restart and a lost `gateway.db`, and is not computable by a provider holding the public endpoint id — Evidence: `packages/gateway/src/backup/backup-state.test.ts` derivation/restart/lost-db assertions.
- `local-usage.ts`'s storage components match the new layout — the `backup` component no longer claims to walk a keyring or a staging dir — Evidence: `packages/gateway/src/serve/local-usage.ts` and storage usage tests.
- No `custody.json` or equivalent index exists; wrapping scheme is read off the envelope — Evidence: `packages/vault/src/schema/key-store.test.ts` self-describing envelope coverage.
- On desktop with `safeStorage` available, the at-rest key is wrapped, and **a `<dataDir>` copied to another machine cannot open its sealed columns** — Evidence: `apps/desktop/src/main/gateway-secrets.test.ts` cross-device copied-data-dir refusal.
- On Linux desktop without libsecret, the store degrades to the 0600 file with a warning rather than failing — Evidence: `apps/desktop/src/main/gateway-secrets.test.ts` Linux libsecret fallback/warning.
- Headless keeps the 0600 file with a pluggable wrap seam; no passphrase-at-boot path exists — Evidence: `packages/gateway/src/cli/key-store.test.ts` external 0600 host credential and `SECURITY.md`.
- Per-vault DEKs are independent — no code path re-derives a vault's key from a master keyring — Evidence: KeyStore/backup tests use independent named per-vault DEKs.
- A store opening a pre-existing plaintext key adopts and (where supported) wraps it in place, preserving the `core_vault` fingerprint check — Evidence: `packages/vault/src/schema/key-store.test.ts` plaintext adoption and authenticated rewrap.
- `resolveSealKey`'s no-key / right-key / wrong-key distinction and `.sealkey.next` rotation completion survive the refactor — Evidence: `packages/vault/src/schema/sealed.test.ts` and rotation/key-store lifecycle coverage.
- SECURITY.md states the headless boundary explicitly — Evidence: `SECURITY.md` KeyStore/headless boundary.
- `POST /centraid/_vault/vaults:initialize` creates a vault only for a landlord-authorized caller (loopback, or a redeemed founding ticket) and only at zero vaults — otherwise `409` — Evidence: `packages/gateway/src/routes/founding-routes.test.ts` landlord and zero-vault gates.
- `vaults:restore` sits behind the **same** gate, and `recoverHandler` no longer has an admin-plane mount — Evidence: `packages/gateway/src/routes/founding-routes.test.ts` peer restore gate and route-table tests.
- A founding ticket is one-time and short-lived (10 min); a second redemption fails, minting a new one invalidates the prior, and it is refused once a vault exists — Evidence: `packages/gateway/src/serve/device-plane.test.ts` 10-minute/single-outstanding/burn/refusal semantics.
- **VPS + phone journey with no desktop anywhere:** SSH → `init-ticket` → redeem on phone → full ceremony on the phone → kit saved off-device via the share sheet → vault ready — Evidence: `tests/agent-e2e-pairing/flows/vps-phone-founding.mjs` plus mobile OS share/re-select tests.
- Desktop founds through the same gate: afterwards `desktop-loopback-token.bin` does not exist, the desktop holds an `owner`-trust enrollment keyed to its own iroh EndpointId (secret in `safeStorage`), and a daemon restart does not break re-adoption — Evidence: `packages/gateway/src/serve/desktop-founding.integration.test.ts`, `apps/desktop/src/main/embedded-gateway-layout.test.ts` direct-host ceremony, and the complete desktop founding/onboarding Playwright flow.
- `desktop-loopback-token.bin` is excluded from the backup tarball — Evidence: `packages/gateway/src/backup/backup-sources.test.ts` exclusion assertions.
- First-run shows Create / Restore as peer paths; no Home until one completes; a device pairing into a founded gateway never sees either — Evidence: `packages/client/src/react/screens/FirstRunGate.test.tsx`, `FoundingScreen.test.tsx`, and mobile onboarding.
- Create ceremony gates in order: password → wrapped kit delivered → mandatory re-select verify (fingerprint check) → loss-consent checkbox. None skippable — Evidence: `FoundingScreen.test.tsx`, `BackupCard.test.tsx`, and `recovery-kit-files.test.ts` ordered non-skippable ceremony.
- The kit is a passphrase-wrapped file containing keyring + sealing key + target addressing, excluding provider credentials; the wrap uses scrypt with `{kdf,N,r,p,salt}` in the header; `parseRecoveryKit` round-trips it — Evidence: `packages/gateway/src/backup/backup-recovery-kit-lifecycle.test.ts` and backup recovery-kit crypto tests.
- Restore accepts kit + password and completes the recover flow to an adopted vault with **sealed columns readable**, with both the sealing key and the keyring placed via `KeyStore.import()`; the next backup runs on the restored keyring — Evidence: `packages/gateway/src/backup/recover-live.integration.test.ts` sealed-column/keyring restore.
- A founding ticket and a pairing ticket share one file and one store; a founding ticket carries no `vaultId` and a pairing ticket still requires one — Evidence: `packages/gateway/src/serve/device-plane.test.ts` shared discriminated SQLite ticket store.
- Adding a backup target, rotating an epoch, **or creating a second vault** flags the kit stale and surfaces exactly one re-download prompt; re-downloading an unchanged kit does not — Evidence: `packages/gateway/src/backup/backup-recovery-kit-lifecycle.test.ts` staleness transitions and idempotence.
- **A gateway with two backed-up vaults has both sealing keys in one kit**, each in its own target row, and restoring from it makes **both** vaults' sealed columns readable. A test creates vault B after the kit was written and asserts the fingerprint went stale — Evidence: `packages/gateway/src/backup/backup-recovery-kit-lifecycle.test.ts` multi-vault kit/restore coverage.
- **A local-only vault stays local-only**: creating a vault opts it into neither remote CAS nor a backup target, it has no row in the kit, and it costs zero offsite bytes. Creating one does **not** flag the kit stale (there is nothing new to protect) — Evidence: `packages/gateway/src/backup/backup-recovery-kit-lifecycle.test.ts` local-only exclusion.
- Ceremony copy says the kit unlocks **backed-up** vaults, not "everything"; a gateway holding one backed-up and one local-only vault says so where the kit is presented — Evidence: `packages/client/src/react/screens/BackupCard.test.tsx` recovery-scope copy.
- Enabling remote CAS on a vault with no backup target degrades a health component and warns at the point of opt-in, naming the consequence (offsite bytes that no kit can decrypt) — Evidence: `packages/gateway/src/routes/storage-routes.test.ts` health and opt-in warning.
- `BackupState.recoveryKit` and the `backup-service.ts:1667` fallback are gone; the `recovery_kit` row is the only representation of kit confirmation — Evidence: `packages/gateway/src/backup/backup-service.contract.test.ts` and gateway-db recovery-kit row assertions.
- Erase: typed-name confirm → fence/generation bump → gateway returns to uninitialized → first-run shown — Evidence: `packages/gateway/src/routes/vault-erase.test.ts` typed erase/fencing/uninitialized transition.
- Erasing the LAST vault succeeds and leaves the registry with zero mounted planes — Evidence: `packages/gateway/src/routes/vault-erase.test.ts` last-vault success.
- After erase, no row in any `gateway.db` table references the erased vaultId; a previously-paired device gets a clean re-pair prompt, not a token for a dead vault — Evidence: `packages/gateway/src/routes/vault-erase.test.ts` row/enrollment cleanup.
- **The post-erase tree diffs clean against the vaultless layout** — the test is a tree comparison, not a deletion checklist, so a file added later cannot silently survive an erase — Evidence: `packages/gateway/src/routes/vault-erase.test.ts` full post-erase tree comparison.
- `KeyStore.destroy()` removes the key and `.sealkey.next` in every at-rest form; a pre-erase directory copy cannot decrypt sealed columns. The #298 amendment is documented — Evidence: `packages/gateway/src/routes/vault-erase.test.ts` custody destruction and copied-tree refusal.
- `kitFingerprint` + confirmation flag persist at the gateway level and survive an erase — a fresh create overwrites them; an erase alone does not resurrect a stale kit prompt — Evidence: `packages/gateway/src/routes/vault-erase.test.ts` gateway-level kit-state persistence.
- Gateway identity files are byte-identical across an erase — Evidence: `packages/gateway/src/routes/vault-erase.test.ts` byte-identical endpoint identity.
- **Erase → restore on the same box** preserves the endpoint identity byte-for-byte, leaves zero enrollments, and a previously-paired device gets a clean re-pair prompt — Evidence: `packages/gateway/src/backup/recover-live.integration.test.ts` erase/restore identity and re-pair behavior.
- No `admin` plane exists in gateway source; every request resolves to a real enrollment in a specific vault, and nothing is implicitly enrolled in all of them — Evidence: repository absence checks, concrete enrollment routing, and `replica-access.ts` fail-closed removal of synthetic admin access.
- A request with no resolvable device identity **fails closed**, and a regression test asserts it (today it would succeed with wildcard reach) — Evidence: `packages/gateway/src/routes/replica-routes.test.ts` explicit missing-identity 403 regression.
- The loopback embed and every test suite that relied on implicit universal access hold real enrollments — Evidence: `build-gateway.ts` host enrollment plus enrolled fixture wrapper in `replica-routes.test.ts`.
- A newly paired (non-founding) device lands at `full` trust, not `owner` — Evidence: `packages/gateway/src/serve/device-plane.test.ts` default ordinary trust.
- Revoking the last `owner` enrollment requires typed confirmation naming the consequence, and the SSH/CLI recovery from that state is tested — Evidence: `packages/gateway/src/cli/admin.test.ts` and device-route tests for typed last-owner confirmation/CLI recovery.

### Changed-file inventory

- `.github/workflows/e2e.yml`
- `ARCHITECTURE.md`
- `Dockerfile`
- `README.md`
- `SECURITY.md`
- `apps/desktop/package.json`
- `apps/desktop/src/main/app-sessions.ts`
- `apps/desktop/src/main/detached-gateway-core.test.ts`
- `apps/desktop/src/main/detached-gateway-core.ts`
- `apps/desktop/src/main/detached-gateway.ts`
- `apps/desktop/src/main/embedded-gateway-layout.test.ts`
- `apps/desktop/src/main/embedded-gateway.ts`
- `apps/desktop/src/main/gateway-connectivity.ts`
- `apps/desktop/src/main/gateway-ops-core.test.ts`
- `apps/desktop/src/main/gateway-ops-core.ts`
- `apps/desktop/src/main/gateway-ops.ts`
- `apps/desktop/src/main/gateway-pairing-core.test.ts`
- `apps/desktop/src/main/gateway-pairing-core.ts`
- `apps/desktop/src/main/gateway-pairing.ts`
- `apps/desktop/src/main/gateway-paths.ts`
- `apps/desktop/src/main/gateway-secrets.test.ts`
- `apps/desktop/src/main/gateway-secrets.ts`
- `apps/desktop/src/main/gateway-store-core.test.ts`
- `apps/desktop/src/main/gateway-store-core.ts`
- `apps/desktop/src/main/gateway-store.test.ts`
- `apps/desktop/src/main/gateway-store.ts`
- `apps/desktop/src/main/ipc-core.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/main/iroh-dialer.ts`
- `apps/desktop/src/main/local-gateway.ts`
- `apps/desktop/src/main/phone-link.ts`
- `apps/desktop/src/main/settings.ts`
- `apps/desktop/src/main/transport.test.ts`
- `apps/desktop/src/main/transport.ts`
- `apps/desktop/src/preload.ts`
- `apps/desktop/tests/e2e/COVERAGE_REPORT.md`
- `apps/desktop/tests/e2e/electron-entry.mjs`
- `apps/desktop/tests/e2e/fixtures.ts`
- `apps/desktop/tests/e2e/onboarding-home.spec.ts`
- `apps/desktop/tests/e2e/settings-gateways.spec.ts`
- `apps/mobile/src/lib/phone-link-parse.ts`
- `apps/mobile/src/lib/phone-link.test.ts`
- `apps/mobile/src/lib/phone-link.ts`
- `apps/mobile/src/lib/recovery-kit-files.test.ts`
- `apps/mobile/src/lib/recovery-kit-files.ts`
- `apps/mobile/src/lib/spaces.test.ts`
- `apps/mobile/src/lib/spaces.ts`
- `apps/mobile/src/lib/vault-founding.test.ts`
- `apps/mobile/src/lib/vault-founding.ts`
- `apps/mobile/src/screens/Onboarding.tsx`
- `apps/web/src/connectivity.ts`
- `apps/web/src/iroh-transport.test.ts`
- `apps/web/src/iroh-transport.ts`
- `apps/web/src/main.ts`
- `apps/web/src/matrix-contracts.test.ts`
- `apps/web/src/matrix-durability.test.ts`
- `apps/web/src/web-host.test.ts`
- `apps/web/src/web-host.ts`
- `apps/web/src/web-state.test.ts`
- `apps/web/src/web-state.ts`
- `apps/web/tests/e2e/control-transport.ts`
- `apps/web/tests/e2e/perf-waterfall.spec.ts`
- `apps/web/tests/e2e/server.ts`
- `apps/web/tests/e2e/web-pwa.spec.ts`
- `docs/config-ownership.md`
- `docs/decisions.md`
- `docs/dev-environment.md`
- `docs/glossary.md`
- `docs/logs.md`
- `docs/recovery/backup-restore.md`
- `docs/recovery/pairing.md`
- `packages/app-engine/src/http/http-server.test.ts`
- `packages/app-engine/src/stores/prefs-store.ts`
- `packages/backup/src/engine.ts`
- `packages/backup/src/index.ts`
- `packages/backup/src/recovery-kit.test.ts`
- `packages/backup/src/recovery-kit.ts`
- `packages/client/src/centraid-api.d.ts`
- `packages/client/src/device-enrichment-worker.test.ts`
- `packages/client/src/gateway-client-backup.ts`
- `packages/client/src/gateway-client-devices.ts`
- `packages/client/src/gateway-client-founding.test.ts`
- `packages/client/src/gateway-client-founding.ts`
- `packages/client/src/gateway-client-recover.test.ts`
- `packages/client/src/gateway-client-recover.ts`
- `packages/client/src/gateway-client-storage.ts`
- `packages/client/src/gateway-client.ts`
- `packages/client/src/react/boot.tsx`
- `packages/client/src/react/screens/BackupCard.module.css`
- `packages/client/src/react/screens/BackupCard.test.tsx`
- `packages/client/src/react/screens/BackupCard.tsx`
- `packages/client/src/react/screens/DevicesCard.test.tsx`
- `packages/client/src/react/screens/DevicesCard.tsx`
- `packages/client/src/react/screens/FirstRunGate.test.tsx`
- `packages/client/src/react/screens/FirstRunGate.tsx`
- `packages/client/src/react/screens/FoundingScreen.test.tsx`
- `packages/client/src/react/screens/FoundingScreen.tsx`
- `packages/client/src/react/screens/RecoverScreen.test.tsx`
- `packages/client/src/react/screens/RecoverScreen.tsx`
- `packages/client/src/react/screens/RecoverSteps.tsx`
- `packages/client/src/react/screens/RecoveryKitGate.tsx`
- `packages/client/src/react/screens/SettingsStorageScreen.test.tsx`
- `packages/client/src/react/screens/SettingsStorageScreen.tsx`
- `packages/client/src/react/shell/flatVaultSwitcher-core.test.ts`
- `packages/client/src/react/shell/flatVaultSwitcher-core.ts`
- `packages/client/src/react/shell/flatVaultSwitcherRegistry.ts`
- `packages/client/src/react/shell/routes/ConnectFlowDetailsStep.tsx`
- `packages/client/src/react/shell/routes/SettingsRoute.tsx`
- `packages/client/src/react/shell/routes/StorageRoute.tsx`
- `packages/client/src/react/shell/routes/connectFlow-core.test.ts`
- `packages/client/src/react/shell/routes/connectFlow-core.ts`
- `packages/client/src/react/shell/routes/connectFlowIO.ts`
- `packages/client/src/react/shell/routes/gatewayModals.test.ts`
- `packages/client/src/react/shell/routes/gatewayModals.ts`
- `packages/client/src/react/shell/routes/settingsStorageData.ts`
- `packages/client/src/react/shell/routes/spaceModals.test.ts`
- `packages/client/src/react/shell/routes/spaceModals.ts`
- `packages/gateway/README.md`
- `packages/gateway/scripts/bench-low-end.mjs`
- `packages/gateway/src/backup/backup-config.ts`
- `packages/gateway/src/backup/backup-health.test.ts`
- `packages/gateway/src/backup/backup-recovery-kit-lifecycle.test.ts`
- `packages/gateway/src/backup/backup-recovery-kit.ts`
- `packages/gateway/src/backup/backup-service-restore.test.ts`
- `packages/gateway/src/backup/backup-service.contract.test.ts`
- `packages/gateway/src/backup/backup-service.ts`
- `packages/gateway/src/backup/backup-sources.test.ts`
- `packages/gateway/src/backup/backup-sources.ts`
- `packages/gateway/src/backup/backup-state.test.ts`
- `packages/gateway/src/backup/backup-state.ts`
- `packages/gateway/src/backup/backup.integration.test.ts`
- `packages/gateway/src/backup/recover-internals.test.ts`
- `packages/gateway/src/backup/recover-internals.ts`
- `packages/gateway/src/backup/recover-job.test.ts`
- `packages/gateway/src/backup/recover-job.ts`
- `packages/gateway/src/backup/recover-live.integration.test.ts`
- `packages/gateway/src/backup/recover.integration.test.ts`
- `packages/gateway/src/backup/recover.ts`
- `packages/gateway/src/backup/recovery-kit-state.test.ts`
- `packages/gateway/src/backup/recovery-kit-state.ts`
- `packages/gateway/src/backup/restore-lazy.integration.test.ts`
- `packages/gateway/src/backup/restore-verify-sealkey.test.ts`
- `packages/gateway/src/backup/storage-connections.ts`
- `packages/gateway/src/backup/wal.integration.test.ts`
- `packages/gateway/src/cli/admin.test.ts`
- `packages/gateway/src/cli/backup-admin.test.ts`
- `packages/gateway/src/cli/backup-admin.ts`
- `packages/gateway/src/cli/cli-serve-args.ts`
- `packages/gateway/src/cli/cli.test.ts`
- `packages/gateway/src/cli/cli.ts`
- `packages/gateway/src/cli/data-dir.ts`
- `packages/gateway/src/cli/device-admin.ts`
- `packages/gateway/src/cli/endpoint-host.ts`
- `packages/gateway/src/cli/founding-admin.ts`
- `packages/gateway/src/cli/key-admin.test.ts`
- `packages/gateway/src/cli/key-admin.ts`
- `packages/gateway/src/cli/key-store.test.ts`
- `packages/gateway/src/cli/key-store.ts`
- `packages/gateway/src/cli/landlord-auth.ts`
- `packages/gateway/src/cli/lock-admin.test.ts`
- `packages/gateway/src/cli/lock-admin.ts`
- `packages/gateway/src/cli/paths.ts`
- `packages/gateway/src/cli/recover-admin.test.ts`
- `packages/gateway/src/cli/recover-admin.ts`
- `packages/gateway/src/cli/resolve-config.ts`
- `packages/gateway/src/cli/runner-prefs.ts`
- `packages/gateway/src/cli/service-admin.test.ts`
- `packages/gateway/src/cli/service-admin.ts`
- `packages/gateway/src/cli/service-unit.test.ts`
- `packages/gateway/src/cli/service-unit.ts`
- `packages/gateway/src/cli/status-admin.test.ts`
- `packages/gateway/src/cli/status-admin.ts`
- `packages/gateway/src/cli/vault-admin.test.ts`
- `packages/gateway/src/cli/vault-admin.ts`
- `packages/gateway/src/index.ts`
- `packages/gateway/src/lifecycle/automation-anchor-scopes.test.ts`
- `packages/gateway/src/lifecycle/automation-lifecycle-over-http.test.ts`
- `packages/gateway/src/lifecycle/clone-over-http.test.ts`
- `packages/gateway/src/lifecycle/draft-preview-over-http.test.ts`
- `packages/gateway/src/lifecycle/ext-band-over-http.test.ts`
- `packages/gateway/src/lifecycle/install-over-http.test.ts`
- `packages/gateway/src/lifecycle/lifecycle-over-http.test.ts`
- `packages/gateway/src/lifecycle/webhook-route-over-http.test.ts`
- `packages/gateway/src/paths.ts`
- `packages/gateway/src/routes/apps-store-routes.test.ts`
- `packages/gateway/src/routes/backup-routes.test.ts`
- `packages/gateway/src/routes/backup-routes.ts`
- `packages/gateway/src/routes/blob-routes-hardening.test.ts`
- `packages/gateway/src/routes/blob-routes.test.ts`
- `packages/gateway/src/routes/connections-routes.test.ts`
- `packages/gateway/src/routes/device-work-routes.test.ts`
- `packages/gateway/src/routes/devices-routes.test.ts`
- `packages/gateway/src/routes/devices-routes.ts`
- `packages/gateway/src/routes/founding-routes.test.ts`
- `packages/gateway/src/routes/founding-routes.ts`
- `packages/gateway/src/routes/gateway-info-routes.ts`
- `packages/gateway/src/routes/import-routes.test.ts`
- `packages/gateway/src/routes/lifecycle-automation-routes.test.ts`
- `packages/gateway/src/routes/pair-routes.ts`
- `packages/gateway/src/routes/recover-routes.test.ts`
- `packages/gateway/src/routes/recover-routes.ts`
- `packages/gateway/src/routes/replica-access.ts`
- `packages/gateway/src/routes/replica-intent-route.test.ts`
- `packages/gateway/src/routes/replica-routes.test.ts`
- `packages/gateway/src/routes/replica-shape.test.ts`
- `packages/gateway/src/routes/route-helpers.ts`
- `packages/gateway/src/routes/storage-local-routes.test.ts`
- `packages/gateway/src/routes/storage-routes.test.ts`
- `packages/gateway/src/routes/storage-routes.ts`
- `packages/gateway/src/routes/templates-routes.test.ts`
- `packages/gateway/src/routes/vault-erase.test.ts`
- `packages/gateway/src/routes/vault-routes.atlas.test.ts`
- `packages/gateway/src/routes/vault-routes.browse.test.ts`
- `packages/gateway/src/routes/vault-routes.test.ts`
- `packages/gateway/src/routes/vault-routes.ts`
- `packages/gateway/src/serve/authz-matrix.smoke.test.ts`
- `packages/gateway/src/serve/build-gateway.test.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/connection-broker.test.ts`
- `packages/gateway/src/serve/demo-seed.test.ts`
- `packages/gateway/src/serve/desktop-founding.integration.test.ts`
- `packages/gateway/src/serve/device-plane.test.ts`
- `packages/gateway/src/serve/device-token-store.test.ts`
- `packages/gateway/src/serve/device-token-store.ts`
- `packages/gateway/src/serve/enrollment-store.ts`
- `packages/gateway/src/serve/erase-recovery.ts`
- `packages/gateway/src/serve/founding-recovery.test.ts`
- `packages/gateway/src/serve/founding-recovery.ts`
- `packages/gateway/src/serve/gateway-db-lock.integration.test.ts`
- `packages/gateway/src/serve/gateway-db.test.ts`
- `packages/gateway/src/serve/gateway-db.ts`
- `packages/gateway/src/serve/gateway-instance-lease.test.ts`
- `packages/gateway/src/serve/gateway-instance-lease.ts`
- `packages/gateway/src/serve/host-identity.ts`
- `packages/gateway/src/serve/local-usage.ts`
- `packages/gateway/src/serve/outbox-executor.test.ts`
- `packages/gateway/src/serve/pairing-store.ts`
- `packages/gateway/src/serve/pairing-ticket-codec.ts`
- `packages/gateway/src/serve/power-context.ts`
- `packages/gateway/src/serve/resource-mode.ts`
- `packages/gateway/src/serve/revocation-severs-planes.test.ts`
- `packages/gateway/src/serve/secret-log.smoke.test.ts`
- `packages/gateway/src/serve/serve-device-tokens.test.ts`
- `packages/gateway/src/serve/serve-git-store.test.ts`
- `packages/gateway/src/serve/serve-multiclient.test.ts`
- `packages/gateway/src/serve/serve-scheduler-reconcile.test.ts`
- `packages/gateway/src/serve/serve-vault-addressing.test.ts`
- `packages/gateway/src/serve/serve.test.ts`
- `packages/gateway/src/serve/serve.ts`
- `packages/gateway/src/serve/storage-limits.ts`
- `packages/gateway/src/serve/vault-context.ts`
- `packages/gateway/src/serve/vault-plane-blob-sweep.test.ts`
- `packages/gateway/src/serve/vault-plane-conversation-archival.test.ts`
- `packages/gateway/src/serve/vault-plane.test.ts`
- `packages/gateway/src/serve/vault-plane.ts`
- `packages/gateway/src/serve/vault-quarantine.test.ts`
- `packages/gateway/src/serve/vault-registry.test.ts`
- `packages/gateway/src/serve/vault-registry.ts`
- `packages/gateway/src/serve/web-app-sessions.contract.test.ts`
- `packages/gateway/src/serve/web-app-sessions.ts`
- `packages/gateway/src/serve/web-session-store.test.ts`
- `packages/gateway/src/serve/web-session-store.ts`
- `packages/protocol/src/handshake.test.ts`
- `packages/protocol/src/handshake.ts`
- `packages/protocol/src/routes.ts`
- `packages/tunnel/fixtures/wire-golden.json`
- `packages/tunnel/src/client.ts`
- `packages/tunnel/src/desktop-tunnel.ts`
- `packages/tunnel/src/endpoint-secret.test.ts`
- `packages/tunnel/src/endpoint-secret.ts`
- `packages/tunnel/src/index.ts`
- `packages/tunnel/src/iroh.ts`
- `packages/tunnel/src/native-relay.ts`
- `packages/tunnel/src/protocol.ts`
- `packages/tunnel/src/wire-conformance.contract.test.ts`
- `packages/vault/src/blob/derivatives.ts`
- `packages/vault/src/blob/preview.test.ts`
- `packages/vault/src/blob/preview.ts`
- `packages/vault/src/blob/s3.test.ts`
- `packages/vault/src/blob/store-routing.test.ts`
- `packages/vault/src/db.ts`
- `packages/vault/src/gateway/reseal.ts`
- `packages/vault/src/host.test.ts`
- `packages/vault/src/host.ts`
- `packages/vault/src/index.ts`
- `packages/vault/src/restore-check.ts`
- `packages/vault/src/schema/key-store.test.ts`
- `packages/vault/src/schema/key-store.ts`
- `packages/vault/src/schema/sealed.ts`
- `receipts/issue-555-vault-founding-plane.md`
- `scripts/gateway-package/container-smoke.sh`
- `scripts/test-report/validate-nightly-wiring.mjs`
- `tests/agent-e2e-mobile/lib/ci-gateway.mjs`
- `tests/agent-e2e-pairing/AGENTS.md`
- `tests/agent-e2e-pairing/README.md`
- `tests/agent-e2e-pairing/flows/cross-network-relay.md`
- `tests/agent-e2e-pairing/flows/cross-network-relay.mjs`
- `tests/agent-e2e-pairing/flows/device-pairing-lifecycle.md`
- `tests/agent-e2e-pairing/flows/device-pairing-lifecycle.mjs`
- `tests/agent-e2e-pairing/flows/extension-companion.mjs`
- `tests/agent-e2e-pairing/flows/pairing-ticket-hygiene.md`
- `tests/agent-e2e-pairing/flows/pairing-ticket-hygiene.mjs`
- `tests/agent-e2e-pairing/flows/vps-phone-founding.md`
- `tests/agent-e2e-pairing/flows/vps-phone-founding.mjs`
- `tests/agent-e2e-pairing/lib/device-redeem.mjs`
- `tests/agent-e2e-pairing/lib/docker-harness.mjs`
- `tests/agent-e2e-pairing/lib/harness.mjs`
- `tests/helpers/factories.ts`
- `tests/matrix.json`
- `tests/perf/fixtures/gateway-idle-server.mjs`
- `tests/scale/gateway-sessions.scale.test.ts`

## Out of scope

- None of issue #555's 92 acceptance items are deferred. Existing repository-level opt-in skips (native tunnel artifact and real disk-full image tests) remain governed by their established lanes and are unrelated to this issue.

## Verification

Completed on the final implementation before receipt audit:

```sh
git show d194e2d6:packages/gateway/src/serve/vault-plane.test.ts
git diff d194e2d6^ d194e2d6 -- packages/gateway/src/serve/vault-plane.ts packages/gateway/src/serve/vault-plane.test.ts
bun run --cwd packages/gateway test
bun run --cwd packages/client test
bun run --cwd apps/mobile test
bun run --cwd apps/desktop test
bun run --cwd packages/app-engine test
bun run --cwd packages/protocol test
bun run --cwd packages/tunnel test
bun run --cwd packages/vault test
bun run --cwd packages/client test -- src/react/screens/FoundingScreen.test.tsx
bun run --cwd apps/desktop test -- src/main/embedded-gateway-layout.test.ts -t "direct-host founding"
bun run --cwd apps/desktop test:e2e -- tests/e2e/settings-gateways.spec.ts
bun run --cwd apps/desktop test:e2e -- tests/e2e/onboarding-home.spec.ts
bun run --cwd apps/web e2e
bun run --cwd packages/gateway test -- src/backup/backup.integration.test.ts
CENTRAID_BENCH_REQUIRE_FSYNC=0 CENTRAID_HARDWARE_PROFILE=constrained bun run test:perf:pr
node tests/agent-e2e-pairing/flows/vps-phone-founding.mjs
node tests/agent-e2e-pairing/flows/device-pairing-lifecycle.mjs
node tests/agent-e2e-pairing/flows/pairing-ticket-hygiene.mjs
bash -n scripts/gateway-package/container-smoke.sh
bun run test:mutation:pr
bun run check:pr:full
```

Results:

- Gateway: 165 files passed, 1 skipped; 1,101 tests passed, 6 skipped.
- Client: 176 files and 1,287 tests passed.
- Mobile: 35 files and 226 tests passed.
- Desktop unit: 27 files and 251 tests passed, including complete embedded/headless tree parity and the direct-host founding ceremony.
- App engine: 49 files and 544 tests passed.
- Protocol: 5 files and 32 tests passed.
- Tunnel: 6 files passed, 1 native-artifact file skipped; 69 tests passed, 2 skipped.
- Vault: 116 files passed; 972 tests passed, 1 opt-in disk-full test skipped.
- Client founding ceremony regression: 2 tests passed, including delayed recovery-kit Blob URL revocation.
- Desktop Playwright gateway/settings flow: 12 tests passed.
- Desktop Playwright onboarding/home flow: 10 tests passed, including the real zero-vault founding ceremony, recovery-kit re-selection, consent, persistence, and Home entry.
- Web Playwright PWA, isolation, cache, waterfall, and iroh-pool flows: 14 tests passed.
- Production-custody backup/restore/fencing integration: 7 tests passed.
- Constrained-hardware 65-second PR performance gate: 0 idle resource filesystem writes/hour, 0 live-data growth bytes/hour, 18.43 ms write p99, 192,659,456-byte peak RSS, 4.64 ms peak event-loop p99, and no budget failures.
- Replayable VPS + phone founding journey: PASS in 5,283 ms.
- Replayable paired-device lifecycle: PASS in 5,559 ms.
- Replayable pairing-ticket hygiene journey: PASS in 3,767 ms.
- Container custody smoke script syntax passed. A local image/runtime smoke was not claimed because no Docker daemon was available; the GitHub `gateway-package` job is the runtime proof.
- Affected mutation gate: protocol score 84.75%, above the 73% floor.
- Final full PR gate: 31/31 affected tasks passed in 1m 59s, including format, lint, monorepo hygiene, typecheck, dead-code, CSS/E2E/protocol checks, matrix/report/governance suites, ratchets, and full dependent-package tests.
- Lock contention, daemon/read-only CLI coexistence, OS holder reporting, `SIGKILL` release, `sqlite3` crash-loop access, erase/restore, desktop founding/restart, full-tree layout parity, fail-closed replica identity, and whole-tree secret-sweep scenarios pass in their focused and package suites.

The GitHub Actions result is recorded on the PR after publication.

## Decisions

- Issue #555 deliberately requires a sequential state that cannot coexist in the final tree: Phase 0 must land the live-lease repair and its regression separately, while Phase 1 must delete both the lease and that test because WAL ownership becomes unconditional. The branch follows that specification literally in commit `d194e2d6`; the complete ordered diff, not only the final snapshot, is therefore the evidence for checklist items 1–2.
- The intermediate `packages/gateway/src/serve/serve-layout-parity.test.ts` exercised a synthetic parity harness while the production desktop embed coverage was being built, then was retired once `apps/desktop/src/main/embedded-gateway-layout.test.ts` owned the complete-tree assertion. It remains named here because it exists in the ordered branch history, while the changed-file inventory intentionally describes the 311-path final diff.
- `gateway.db` is both the durable gateway-state authority and the exclusive process lock; vault enumeration remains rooted in the filesystem.
- EndpointId and concrete per-vault enrollments replace URL identity, durable pairing tickets, bearer devices, and wildcard authority.
- `KeyStore` is the gateway secret-custody seam. Headless retains a 0600-file boundary; the desktop embed wraps the at-rest key through `safeStorage`.
- Founding is the only zero-vault authority. Normal requests resolve to an enrolled device and a specific vault.

## Audit

Overall: PASS — fresh-context final post-gate audit of the committed and working-tree change set.

1. PASS — `## What changed` faithfully covers the complete committed and working-tree change set, including the final desktop, web, WAL-performance, container-custody, and deterministic pricing-cache fixture repairs. The changed-file inventory exactly matches all 311 final-diff paths. The audit also accurately distinguishes Phase 0 commit `d194e2d6`, which lands the WAL re-arm repair and real lease-conflict regression, from Phase 1's specified removal of the lease model and that test.
2. PASS — all 92 checked items are realized in the ordered branch plus working-tree diff. The auditor specifically confirmed vaultless `gateway.db` locking, founding and restore, `KeyStore` custody, device-local iroh connections, erase, fail-closed enrollment, and issue #555's deliberate Phase 0 → Phase 1 test-retirement sequence.
3. PASS — exact normalized comparison with canonical GitHub issue #555: 92 issue checklist items versus 92 receipt items, with identical text and order and no diff.

## Steering

PASS — fresh-context review of Codex session
`019f9e70-5250-7862-b42f-4db4a9d7686c` found one human correction:
“Run the command please” redirected the agent from asking the user to run
`gh auth login` to running the interactive login itself; receipt steering row
ordinal 119 records it. “Done” merely confirmed the browser approval the agent
had requested, so it is an ordinary task message and is correctly not recorded.
No interrupt sentinel or other human redirect/correction appears in the
session.

## Accounting

Populated by the governance commit hook.

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019f9e70-525-1785071812-1 | codex | 019f9e70-5250-7862-b42f-4db4a9d7686c | #555 | gpt-5.6-sol | 484654 | 0 | 11650816 | 26396 | 511050 | 4.5203 | 484654 | 0 | 11650816 | 26396 | fix(gateway): re-arm WAL capture after lease conflict (#555) |
| codex-019f9e70-525-1785089774-1 | codex | 019f9e70-5250-7862-b42f-4db4a9d7686c | #555 | gpt-5.6-sol | 3238996 | 0 | 163382528 | 403564 | 3642560 | 54.9966 | 3723650 | 0 | 175033344 | 429960 | feat(gateway): implement vault founding plane (#555) |
| codex-019f9e70-525-1785107858-1 | codex | 019f9e70-5250-7862-b42f-4db4a9d7686c | #555 | gpt-5.6-sol | 3509035 | 0 | 138802688 | 371615 | 3880650 | 49.0475 | 7232685 | 0 | 313836032 | 801575 | fix(gateway): close founding-plane acceptance gaps (#555) -m governance: allow-t |
| codex-019f9e70-525-1785108755-1 | codex | 019f9e70-5250-7862-b42f-4db4a9d7686c | #555 | gpt-5.6-sol | 198009 | 0 | 4647424 | 10442 | 208451 | 1.8135 | 7430694 | 0 | 318483456 | 812017 | fix(ci): align founding journey with shared setup (#555) -m governance: allow-to |
| codex-019f9e70-525-1785108800-1 | codex | 019f9e70-5250-7862-b42f-4db4a9d7686c | #555 | gpt-5.6-sol | 2446 | 0 | 197888 | 432 | 2878 | 0.0621 | 7433140 | 0 | 318681344 | 812449 | fix(ci): align founding journey with shared setup (#555) -m governance: allow-to |
| codex-019f9e70-525-1785113470-1 | codex | 019f9e70-5250-7862-b42f-4db4a9d7686c | #555 | gpt-5.6-sol | 851884 | 0 | 36322304 | 77513 | 929397 | 12.3730 | 8285024 | 0 | 355003648 | 889962 | fix(ci): close founding-plane CI gaps (#555) |
| codex-019f9e70-525-1785118519-1 | codex | 019f9e70-5250-7862-b42f-4db4a9d7686c | #555 | gpt-5.6-sol | 334841 | 0 | 10266112 | 13763 | 348604 | 3.6101 | 8619865 | 0 | 365269760 | 903725 | fix(test): stabilize embedded layout parity (#555) |
| codex-019f9e70-525-1785118618-1 | codex | 019f9e70-5250-7862-b42f-4db4a9d7686c | #555 | gpt-5.6-sol | 7806 | 0 | 1290496 | 980 | 8786 | 0.3568 | 8627671 | 0 | 366560256 | 904705 | fix(test): stabilize embedded layout parity (#555) |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-019f9e705250-1785070304-1 | 019f9e70-5250-7862-b42f-4db4a9d7686c | #555 | correction | classifier | Redirect agent to run GitHub login command itself | feat(gateway): implement vault founding plane (#555) | 119 | 2026-07-26T12:51:44.600Z |
