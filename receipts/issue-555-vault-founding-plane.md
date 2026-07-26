# Receipt — issue #555: Vault founding plane and device-local connections

Issue #555 replaces implicit vault bootstrap and the split gateway/device state
model with an explicitly founded, lock-owned gateway. This receipt is updated
phase by phase so each intermediate commit remains auditable.

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
- [ ] `gateway.db` exists with its full schema at zero vaults, and `prefs.json` / `devices.json` / `tickets.json` / `recovery-kit.json` / `backup.json` / `storage/` are **gone** — nothing in the tree writes them
- [x] Redeeming a ticket and creating the first enrollment happen in **one transaction**: a crash injected between them leaves the ticket unredeemed and the gateway still foundable
- [x] Two concurrent redemptions of one founding ticket produce exactly one success — asserted against the rowcount, not a mutex
- [x] Revoking a device removes its web sessions by **`ON DELETE CASCADE`**, and severs the transport because the enrollment the QUIC listener admits on is gone
- [x] `gateway.db` **is** the lock: `PRAGMA locking_mode` is `EXCLUSIVE`, the handle is held for process lifetime, no `gateway.lock.db` is ever created, and no separate `-shm` sidecar appears
- [x] With the daemon **stopped or crash-looping**, `sqlite3 gateway.db` opens and reads normally — the case a separate lock file existed to serve is covered by the daemon not holding it
- [x] `gateway.db` has **no `vaults` table** — a test asserts vault enumeration still reads the filesystem, so the founding gate's zero-vaults precondition cannot disagree with the registry root
- [ ] `GatewayInstanceLease`, `gateway.lease`, and all `leaseConflicted` plumbing are **gone**; WAL ownership is unconditional and no code path can disarm the shipper
- [x] A data dir on a network mount surfaces a health **warning**, not a refusal — **and** sets `skipOrphanDelete`, so blob GC never deletes under a possible cross-host writer
- [ ] `endpoint.json` no longer exists; the `pair` and `status` CLIs derive `endpointId` from the identity key and obtain a live ticket from the running daemon, reporting a clear "daemon not running" when it is not
- [x] The desktop embed participates in the lock
- [x] **The data dir is identical in shape on a laptop and a VPS** — a test diffs the desktop-embedded tree against a `centraid-gateway serve --data-dir` tree after the same operations and asserts the entry sets match. `cli/paths.ts`'s layout header is rewritten to match, having documented six files that no longer exist
- [ ] **No process other than the daemon writes into the data dir** — `profile.json`, `gateway.status.json`, `gateway.ownership.json`, and `token.bin` do not appear anywhere under it, on any platform, at any point in the lifecycle
- [x] The desktop's connection list renders **with no gateway running and no data dir present** (the remote case), from device-local storage rather than a `gateways/` directory scan
- [x] A remote-only gateway connection creates **no local directory at all** — adding, using, and forgetting it touches only device storage and the OS keychain
- [ ] The registry is **one `connections.json`**, not a directory per connection, and both it and the credentials are owned by the desktop **main** process; a test asserts the renderer's `centraid.v1.` localStorage holds no connection record and no credential
- [x] A connection record carries `endpointId` and **no `url` and no `transport` field**; nothing in the codebase can add a gateway by URL, and the url/iroh XOR in `validateAddGatewayFields` is gone because there is no second branch
- [x] **`device_tokens`, `device-token-store.ts`, and the `cdt_…` prefix do not exist**; `gateway.db` has no such table, and no code path mints or resolves a bearer
- [x] **`POST /centraid/_gateway/pair` is gone** — pairing is iroh-only, and the web PWA pairs over iroh-wasm like every other client
- [x] **Revoking a device makes the QUIC handshake itself refuse** — a revoked device cannot open a connection at all, and `revocation-severs-planes.test.ts` (minus its token plane) still passes
- [x] `web_sessions` is unaffected: a browser control cookie still survives a gateway restart on its sliding window
- [ ] **A gateway is identified by its EndpointId, not its address** — changing a relay hint, or losing it entirely, does not create a new connection or require re-pairing; the hint is refreshable cache, and no stored pairing ticket is treated as durable identity
- [x] **`iroh-device-key.bin` no longer exists in any gateway tree** — the device's iroh secret lives in `safeStorage` / Keychain / Keystore, keyed per connection, and its EndpointId still matches the enrolled `devices` row across a restart (the `ensureIrohDeviceKey` invariant survives the move)
- [x] `gateway-paths.ts`'s header lists what the directory actually contains — it currently omits `iroh-device-key.bin`, the ownership stamp, and the status file
- [x] `centraid-gateway serve` with **no `--data-dir`** resolves the platform default; `--data-dir` and `CENTRAID_DATA_DIR` still override, in that precedence
- [ ] **The desktop, the CLI, and the OS service all land on the same data dir by default** — starting the second while the first runs hits the lock and exits, which is only possible once the default exists
- [x] **No gateway data lives under the desktop's `userData`** — a test asserts the resolved default is outside it, so removing the desktop application's data cannot delete a vault
- [x] Supervisor decisions no longer consult a pid for liveness: `isProcessAlive` and `startedAt` are gone, `stale-reclaim` reduces to "lock free, start", and `probe-failed-refuse` fires on lock-held-plus-no-answer
- [ ] A daemon restart does not disturb any device's connection record or token — asserted for desktop and for a paired phone
- [x] A corrupt (non-32-byte) `endpoint-key.bin` **throws** with an actionable message naming both remedies; a corrupt device key re-mints with a warning
- [x] Minting goes through temp-file + rename: an interrupted first boot leaves either nothing or a complete key, never a short file
- [x] A `chmod 644` key self-heals to `0600` with a warning rather than refusing
- [x] All three call sites use the shared `@centraid/tunnel` loader with an explicit `onCorrupt` policy
- [x] Every sealing-key read/write in the codebase goes through `KeyStore`; no phase-3/4 code names `vault/keys/<vaultId>.sealkey` directly
- [ ] **`keys/` is the only directory holding secrets**, and a test asserts no file under it parses as raw key material: the four secrets (vault DEKs, `connections.sealkey`, endpoint key, backup keyring) all live there, wrapped. The test sweeps the **whole data dir**, not just `keys/`, and passes with **no exemption list** — which is only possible because device credentials moved to devices
- [x] **`vault/` holds vault content only** — a test asserts no key, lock, or coordination file appears anywhere under it, and `ARCHITECTURE.md:131` becomes true rather than aspirational
- [x] Deleting `gateway.db` and `cache/` no longer destroys the master keys; the backup engine re-seeds fencing from the provider and reads existing snapshots on the surviving keyring
- [x] **No key material lives in `gateway.db`** — a test greps every table for raw or base64 key bytes; the one sealed column holds ciphertext whose key is in `keys/`
- [ ] `keys/` custody survives the fold: `LoadCredentialEncrypted=` still points at a real path, and crypto-erase is still a single `unlink` with no `VACUUM` in the erase path
- [ ] `backup/` and `storage/` no longer exist: keyring in `keys/`, code bundles in `cache/`, state in `gateway.db`; no code or doc comment references a `staging/` dir
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
- [ ] **VPS + phone journey with no desktop anywhere:** SSH → `init-ticket` → redeem on phone → full ceremony on the phone → kit saved off-device via the share sheet → vault ready
- [ ] Desktop founds through the same gate: afterwards `desktop-loopback-token.bin` does not exist, the desktop holds an `owner`-trust enrollment keyed to its own iroh EndpointId (secret in `safeStorage`), and a daemon restart does not break re-adoption
- [x] `desktop-loopback-token.bin` is excluded from the backup tarball
- [ ] First-run shows Create / Restore as peer paths; no Home until one completes; a device pairing into a founded gateway never sees either
- [ ] Create ceremony gates in order: password → wrapped kit delivered → mandatory re-select verify (fingerprint check) → loss-consent checkbox. None skippable
- [ ] The kit is a passphrase-wrapped file containing keyring + sealing key + target addressing, excluding provider credentials; the wrap uses scrypt with `{kdf,N,r,p,salt}` in the header; `parseRecoveryKit` round-trips it
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
- [ ] No `admin` plane exists in gateway source; every request resolves to a real enrollment in a specific vault, and nothing is implicitly enrolled in all of them
- [x] A request with no resolvable device identity **fails closed**, and a regression test asserts it (today it would succeed with wildcard reach)
- [ ] The loopback embed and every test suite that relied on implicit universal access hold real enrollments
- [x] A newly paired (non-founding) device lands at `full` trust, not `owner`
- [ ] Revoking the last `owner` enrollment requires typed confirmation naming the consequence, and the SSH/CLI recovery from that state is tested

## What changed

- **Phase 0 first repaired the legacy lease model in isolated commit `3a891099`.** That historical commit re-arms WAL capture after a conflict clears and carries the real crash/fast-restart regression proof. Phase 1 then removes the lease implementation from the final tree while preserving the compatibility fix in branch history.
- **Gateway startup is explicitly vaultless.** `gateway.db` is created with its complete schema before a vault exists, owns an exclusive process-lifetime SQLite lock, and is now the durable home for gateway preferences, enrollments, tickets, web sessions, backup metadata, storage limits, and connections. Registry discovery remains filesystem-based; zero vaults is a healthy `uninitialized` state.
- **Most of the lease and split-state model is removed.** Production bearer device tokens, the direct HTTP pair route, JSON gateway stores, and coordination files are deleted. Network filesystems warn and force orphan-safe blob GC. Some unchanged test harnesses still reference retired files, and the draft does not claim the issue's stronger unconditional-WAL-ownership acceptance item.
- **Gateway and device identity are iroh-only.** Endpoint identity is derived from the persistent endpoint secret; desktop connections are keyed by EndpointId in one main-process-owned `connections.json`, with device secrets in `safeStorage`. URL/direct transport records and renderer-local connection credentials are gone.
- **Secret custody is centralized behind a new seam.** `KeyStore` owns gateway identity, per-vault DEKs, the backup keyring, and connection sealing keys under `keys/`; headless mode retains the documented 0600-file boundary and plaintext files are adopted in place. The desktop embed wraps its at-rest key with `safeStorage`, and the integration proof shows a copied data directory cannot be decrypted with another device's custody store.
- **Vault creation and restore use an explicit founding plane.** Founding tickets are short-lived and one-time, and initialize and restore share the zero-vault authorization gate. Ticket redemption, vault creation, and first-owner enrollment are one SQLite transaction; crash injection rolls the ticket back, and concurrent redemption succeeds exactly once by affected rowcount. The complete first-run ceremony remains unchecked.
- **Erase is a first-class transition back to uninitialized.** The owner-confirmed route cascades gateway state, removes vault custody material (including pending rotation material), preserves endpoint identity and gateway-level kit confirmation, and leaves zero mounted planes. The erase test discovers every `gateway.db` table with a `vault_id` column and proves no erased-vault row survives.
- **Authorization now fails closed on the implemented request paths.** Gateway requests require a resolvable device enrollment, ordinary pairing grants `full` rather than `owner`, ticket minting and peer revocation require owner trust, and revocation removes sessions. The revocation integration test uses a real iroh endpoint and proves both the admitted connection closes and a new post-revocation handshake is refused.
- **Recovery-kit verification is the only narrow fail-closed escape hatch.** An incomplete ceremony blocks the vault surface while still permitting the exact kit export and confirmation routes needed to re-open and verify the current artifact.
- **Documentation and tests cover the implemented layout and lifecycle.** Architecture, security, recovery, pairing, configuration ownership, paths, logs, protocol declarations, desktop/web clients, and many affected fixtures changed; the draft does not claim that every stale reference has been eliminated.

### Completed acceptance evidence

The following issue statements are checked because the implementation and
verification named in this receipt cover them:

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
- [x] Redeeming a ticket and creating the first enrollment happen in **one transaction**: a crash injected between them leaves the ticket unredeemed and the gateway still foundable
- [x] Two concurrent redemptions of one founding ticket produce exactly one success — asserted against the rowcount, not a mutex
- [x] Revoking a device removes its web sessions by **`ON DELETE CASCADE`**, and severs the transport because the enrollment the QUIC listener admits on is gone
- [x] `gateway.db` **is** the lock: `PRAGMA locking_mode` is `EXCLUSIVE`, the handle is held for process lifetime, no `gateway.lock.db` is ever created, and no separate `-shm` sidecar appears
- [x] With the daemon **stopped or crash-looping**, `sqlite3 gateway.db` opens and reads normally — the case a separate lock file existed to serve is covered by the daemon not holding it
- [x] `gateway.db` has **no `vaults` table** — a test asserts vault enumeration still reads the filesystem, so the founding gate's zero-vaults precondition cannot disagree with the registry root
- [x] A data dir on a network mount surfaces a health **warning**, not a refusal — **and** sets `skipOrphanDelete`, so blob GC never deletes under a possible cross-host writer
- [x] The desktop embed participates in the lock
- [x] **The data dir is identical in shape on a laptop and a VPS** — a test diffs the desktop-embedded tree against a `centraid-gateway serve --data-dir` tree after the same operations and asserts the entry sets match. `cli/paths.ts`'s layout header is rewritten to match, having documented six files that no longer exist
- [x] The desktop's connection list renders **with no gateway running and no data dir present** (the remote case), from device-local storage rather than a `gateways/` directory scan
- [x] A remote-only gateway connection creates **no local directory at all** — adding, using, and forgetting it touches only device storage and the OS keychain
- [x] A connection record carries `endpointId` and **no `url` and no `transport` field**; nothing in the codebase can add a gateway by URL, and the url/iroh XOR in `validateAddGatewayFields` is gone because there is no second branch
- [x] **`device_tokens`, `device-token-store.ts`, and the `cdt_…` prefix do not exist**; `gateway.db` has no such table, and no code path mints or resolves a bearer
- [x] **`POST /centraid/_gateway/pair` is gone** — pairing is iroh-only, and the web PWA pairs over iroh-wasm like every other client
- [x] **Revoking a device makes the QUIC handshake itself refuse** — a revoked device cannot open a connection at all, and `revocation-severs-planes.test.ts` (minus its token plane) still passes
- [x] `web_sessions` is unaffected: a browser control cookie still survives a gateway restart on its sliding window
- [x] **`iroh-device-key.bin` no longer exists in any gateway tree** — the device's iroh secret lives in `safeStorage` / Keychain / Keystore, keyed per connection, and its EndpointId still matches the enrolled `devices` row across a restart (the `ensureIrohDeviceKey` invariant survives the move)
- [x] `gateway-paths.ts`'s header lists what the directory actually contains — it currently omits `iroh-device-key.bin`, the ownership stamp, and the status file
- [x] `centraid-gateway serve` with **no `--data-dir`** resolves the platform default; `--data-dir` and `CENTRAID_DATA_DIR` still override, in that precedence
- [x] **No gateway data lives under the desktop's `userData`** — a test asserts the resolved default is outside it, so removing the desktop application's data cannot delete a vault
- [x] Supervisor decisions no longer consult a pid for liveness: `isProcessAlive` and `startedAt` are gone, `stale-reclaim` reduces to "lock free, start", and `probe-failed-refuse` fires on lock-held-plus-no-answer
- [x] A corrupt (non-32-byte) `endpoint-key.bin` **throws** with an actionable message naming both remedies; a corrupt device key re-mints with a warning
- [x] Minting goes through temp-file + rename: an interrupted first boot leaves either nothing or a complete key, never a short file
- [x] A `chmod 644` key self-heals to `0600` with a warning rather than refusing
- [x] All three call sites use the shared `@centraid/tunnel` loader with an explicit `onCorrupt` policy
- [x] Every sealing-key read/write in the codebase goes through `KeyStore`; no phase-3/4 code names `vault/keys/<vaultId>.sealkey` directly
- [x] **`vault/` holds vault content only** — a test asserts no key, lock, or coordination file appears anywhere under it, and `ARCHITECTURE.md:131` becomes true rather than aspirational
- [x] Deleting `gateway.db` and `cache/` no longer destroys the master keys; the backup engine re-seeds fencing from the provider and reads existing snapshots on the surviving keyring
- [x] **No key material lives in `gateway.db`** — a test greps every table for raw or base64 key bytes; the one sealed column holds ciphertext whose key is in `keys/`
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
- [x] `desktop-loopback-token.bin` is excluded from the backup tarball
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
- [x] A request with no resolvable device identity **fails closed**, and a regression test asserts it (today it would succeed with wildcard reach)
- [x] A newly paired (non-founding) device lands at `full` trust, not `owner`

### Changed-file inventory

```text
ARCHITECTURE.md
README.md
SECURITY.md
apps/desktop/package.json
apps/desktop/src/main/app-sessions.ts
apps/desktop/src/main/detached-gateway-core.test.ts
apps/desktop/src/main/detached-gateway-core.ts
apps/desktop/src/main/detached-gateway.ts
apps/desktop/src/main/gateway-connectivity.ts
apps/desktop/src/main/gateway-pairing-core.test.ts
apps/desktop/src/main/gateway-pairing-core.ts
apps/desktop/src/main/gateway-pairing.ts
apps/desktop/src/main/gateway-paths.ts
apps/desktop/src/main/gateway-secrets.test.ts
apps/desktop/src/main/gateway-secrets.ts
apps/desktop/src/main/gateway-store-core.test.ts
apps/desktop/src/main/gateway-store-core.ts
apps/desktop/src/main/gateway-store.ts
apps/desktop/src/main/ipc-core.ts
apps/desktop/src/main/ipc.ts
apps/desktop/src/main/iroh-dialer.ts
apps/desktop/src/main/local-gateway.ts
apps/desktop/src/main/phone-link.ts
apps/desktop/src/main/settings.ts
apps/desktop/src/main/transport.test.ts
apps/desktop/src/main/transport.ts
apps/desktop/src/preload.ts
apps/web/src/connectivity.ts
apps/web/src/iroh-transport.test.ts
apps/web/src/iroh-transport.ts
apps/web/src/main.ts
apps/web/src/matrix-contracts.test.ts
apps/web/src/matrix-durability.test.ts
apps/web/src/web-host.test.ts
apps/web/src/web-host.ts
apps/web/src/web-state.test.ts
apps/web/src/web-state.ts
docs/config-ownership.md
docs/decisions.md
docs/glossary.md
docs/logs.md
docs/recovery/backup-restore.md
docs/recovery/pairing.md
packages/app-engine/src/stores/prefs-store.ts
packages/backup/src/engine.ts
packages/backup/src/index.ts
packages/backup/src/recovery-kit.test.ts
packages/backup/src/recovery-kit.ts
packages/client/src/centraid-api.d.ts
packages/client/src/device-enrichment-worker.test.ts
packages/client/src/gateway-client-devices.ts
packages/client/src/react/screens/BackupCard.test.tsx
packages/client/src/react/screens/BackupCard.tsx
packages/client/src/react/screens/DevicesCard.test.tsx
packages/client/src/react/screens/DevicesCard.tsx
packages/client/src/react/screens/FirstRunGate.tsx
packages/client/src/react/screens/SettingsStorageScreen.tsx
packages/client/src/react/shell/flatVaultSwitcher-core.test.ts
packages/client/src/react/shell/flatVaultSwitcher-core.ts
packages/client/src/react/shell/flatVaultSwitcherRegistry.ts
packages/client/src/react/shell/routes/ConnectFlowDetailsStep.tsx
packages/client/src/react/shell/routes/SettingsRoute.tsx
packages/client/src/react/shell/routes/connectFlow-core.test.ts
packages/client/src/react/shell/routes/connectFlow-core.ts
packages/client/src/react/shell/routes/connectFlowIO.ts
packages/client/src/react/shell/routes/gatewayModals.test.ts
packages/client/src/react/shell/routes/gatewayModals.ts
packages/client/src/react/shell/routes/spaceModals.test.ts
packages/client/src/react/shell/routes/spaceModals.ts
packages/gateway/src/backup/backup-config.ts
packages/gateway/src/backup/backup-health.test.ts
packages/gateway/src/backup/backup-recovery-kit-lifecycle.test.ts
packages/gateway/src/backup/backup-recovery-kit.ts
packages/gateway/src/backup/backup-service-restore.test.ts
packages/gateway/src/backup/backup-service.contract.test.ts
packages/gateway/src/backup/backup-service.ts
packages/gateway/src/backup/backup-sources.test.ts
packages/gateway/src/backup/backup-sources.ts
packages/gateway/src/backup/backup-state.test.ts
packages/gateway/src/backup/backup-state.ts
packages/gateway/src/backup/backup.integration.test.ts
packages/gateway/src/backup/recover-internals.test.ts
packages/gateway/src/backup/recover-internals.ts
packages/gateway/src/backup/recover-job.test.ts
packages/gateway/src/backup/recover-job.ts
packages/gateway/src/backup/recover-live.integration.test.ts
packages/gateway/src/backup/recover.integration.test.ts
packages/gateway/src/backup/recover.ts
packages/gateway/src/backup/recovery-kit-state.ts
packages/gateway/src/backup/restore-lazy.integration.test.ts
packages/gateway/src/backup/restore-verify-sealkey.test.ts
packages/gateway/src/backup/storage-connections.ts
packages/gateway/src/backup/wal.integration.test.ts
packages/gateway/src/cli/admin.test.ts
packages/gateway/src/cli/backup-admin.test.ts
packages/gateway/src/cli/backup-admin.ts
packages/gateway/src/cli/cli-serve-args.ts
packages/gateway/src/cli/cli.test.ts
packages/gateway/src/cli/cli.ts
packages/gateway/src/cli/data-dir.ts
packages/gateway/src/cli/device-admin.ts
packages/gateway/src/cli/endpoint-host.ts
packages/gateway/src/cli/founding-admin.ts
packages/gateway/src/cli/key-admin.test.ts
packages/gateway/src/cli/key-store.ts
packages/gateway/src/cli/lock-admin.ts
packages/gateway/src/cli/paths.ts
packages/gateway/src/cli/recover-admin.test.ts
packages/gateway/src/cli/recover-admin.ts
packages/gateway/src/cli/resolve-config.ts
packages/gateway/src/cli/runner-prefs.ts
packages/gateway/src/cli/status-admin.test.ts
packages/gateway/src/cli/status-admin.ts
packages/gateway/src/cli/vault-admin.test.ts
packages/gateway/src/cli/vault-admin.ts
packages/gateway/src/index.ts
packages/gateway/src/lifecycle/automation-anchor-scopes.test.ts
packages/gateway/src/lifecycle/automation-lifecycle-over-http.test.ts
packages/gateway/src/lifecycle/clone-over-http.test.ts
packages/gateway/src/lifecycle/draft-preview-over-http.test.ts
packages/gateway/src/lifecycle/ext-band-over-http.test.ts
packages/gateway/src/lifecycle/install-over-http.test.ts
packages/gateway/src/lifecycle/lifecycle-over-http.test.ts
packages/gateway/src/lifecycle/webhook-route-over-http.test.ts
packages/gateway/src/paths.ts
packages/gateway/src/routes/apps-store-routes.test.ts
packages/gateway/src/routes/blob-routes-hardening.test.ts
packages/gateway/src/routes/blob-routes.test.ts
packages/gateway/src/routes/connections-routes.test.ts
packages/gateway/src/routes/device-work-routes.test.ts
packages/gateway/src/routes/devices-routes.test.ts
packages/gateway/src/routes/devices-routes.ts
packages/gateway/src/routes/founding-routes.test.ts
packages/gateway/src/routes/founding-routes.ts
packages/gateway/src/routes/gateway-info-routes.ts
packages/gateway/src/routes/import-routes.test.ts
packages/gateway/src/routes/lifecycle-automation-routes.test.ts
packages/gateway/src/routes/pair-routes.ts
packages/gateway/src/routes/recover-routes.test.ts
packages/gateway/src/routes/recover-routes.ts
packages/gateway/src/routes/replica-intent-route.test.ts
packages/gateway/src/routes/replica-routes.test.ts
packages/gateway/src/routes/replica-shape.test.ts
packages/gateway/src/routes/route-helpers.ts
packages/gateway/src/routes/storage-local-routes.test.ts
packages/gateway/src/routes/storage-routes.test.ts
packages/gateway/src/routes/templates-routes.test.ts
packages/gateway/src/routes/vault-erase.test.ts
packages/gateway/src/routes/vault-routes.atlas.test.ts
packages/gateway/src/routes/vault-routes.browse.test.ts
packages/gateway/src/routes/vault-routes.test.ts
packages/gateway/src/routes/vault-routes.ts
packages/gateway/src/serve/authz-matrix.smoke.test.ts
packages/gateway/src/serve/build-gateway.test.ts
packages/gateway/src/serve/build-gateway.ts
packages/gateway/src/serve/connection-broker.test.ts
packages/gateway/src/serve/demo-seed.test.ts
packages/gateway/src/serve/device-plane.test.ts
packages/gateway/src/serve/device-token-store.test.ts
packages/gateway/src/serve/device-token-store.ts
packages/gateway/src/serve/enrollment-store.ts
packages/gateway/src/serve/gateway-db.test.ts
packages/gateway/src/serve/gateway-db.ts
packages/gateway/src/serve/gateway-instance-lease.test.ts
packages/gateway/src/serve/gateway-instance-lease.ts
packages/gateway/src/serve/local-usage.ts
packages/gateway/src/serve/outbox-executor.test.ts
packages/gateway/src/serve/pairing-store.ts
packages/gateway/src/serve/resource-mode.ts
packages/gateway/src/serve/revocation-severs-planes.test.ts
packages/gateway/src/serve/secret-log.smoke.test.ts
packages/gateway/src/serve/serve-device-tokens.test.ts
packages/gateway/src/serve/serve-git-store.test.ts
packages/gateway/src/serve/serve-layout-parity.test.ts
packages/gateway/src/serve/serve-multiclient.test.ts
packages/gateway/src/serve/serve-scheduler-reconcile.test.ts
packages/gateway/src/serve/serve-vault-addressing.test.ts
packages/gateway/src/serve/serve.test.ts
packages/gateway/src/serve/serve.ts
packages/gateway/src/serve/storage-limits.ts
packages/gateway/src/serve/vault-context.ts
packages/gateway/src/serve/vault-plane-blob-sweep.test.ts
packages/gateway/src/serve/vault-plane-conversation-archival.test.ts
packages/gateway/src/serve/vault-plane.test.ts
packages/gateway/src/serve/vault-plane.ts
packages/gateway/src/serve/vault-quarantine.test.ts
packages/gateway/src/serve/vault-registry.test.ts
packages/gateway/src/serve/vault-registry.ts
packages/gateway/src/serve/web-app-sessions.contract.test.ts
packages/gateway/src/serve/web-app-sessions.ts
packages/gateway/src/serve/web-session-store.test.ts
packages/gateway/src/serve/web-session-store.ts
packages/protocol/src/handshake.test.ts
packages/protocol/src/handshake.ts
packages/protocol/src/routes.ts
packages/tunnel/src/client.ts
packages/tunnel/src/endpoint-secret.test.ts
packages/tunnel/src/endpoint-secret.ts
packages/tunnel/src/index.ts
packages/tunnel/src/iroh.ts
packages/vault/src/blob/s3.test.ts
packages/vault/src/blob/store-routing.test.ts
packages/vault/src/host.test.ts
packages/vault/src/host.ts
packages/vault/src/index.ts
packages/vault/src/restore-check.ts
packages/vault/src/schema/key-store.test.ts
packages/vault/src/schema/key-store.ts
packages/vault/src/schema/sealed.ts
receipts/issue-555-vault-founding-plane.md
tests/matrix.json
```

## Out of scope

- No issue requirement is intentionally excluded. Unchecked checklist items are not
  claimed by this draft and remain explicit follow-up work before it is merge-ready.

## Verification

```sh
bun run check:pr:full
bun run --cwd packages/gateway test -- src/serve/serve.test.ts
```

`bun run check:pr:full` passed on the final code tree: all 31 affected-package
tasks succeeded, including 1,086 gateway tests (6 skipped) and 971 vault tests
(1 skipped). The focused gateway HTTP suite passed 18/18 after the
recovery-kit-gate fix; the gateway admin suite also passed 9/9.

## Decisions

- The Phase 0 compatibility fix remains isolated before lease deletion, proving
  the existing model was repaired before its replacement.
- `gateway.db` is both the durable gateway-state authority and the exclusive
  process lock; vault enumeration remains rooted in the filesystem.
- EndpointId and real per-vault enrollments replace URL identity, durable pair
  tickets, bearer devices, and implicit universal access.
- `KeyStore` is the gateway secret-custody seam. Headless retains a 0600-file
  boundary; the desktop embed wraps the at-rest key through `safeStorage`.
- The founding ceremony is the only implicit zero-vault authority. Normal
  requests always resolve to a concrete enrolled device and vault.

## Audit

PASS — Fresh-context audit against GitHub issue #555, `origin/main`, branch
history, and the current working tree found no unsupported checked claim. The
receipt mirrors all 92 issue items exactly; its 73 checked items exactly match
the 73 completed-evidence entries; and its 211-path inventory exactly matches
`git diff --name-only origin/main` plus untracked files. Verification records
the actual full/focused runs, and a current-tree targeted rerun covering the
deterministic enrollment ordering and recovery-kit test split passed 32/32.

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

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-019f9e705250-1785070304-1 | 019f9e70-5250-7862-b42f-4db4a9d7686c | #555 | correction | classifier | Redirect agent to run GitHub login command itself | feat(gateway): implement vault founding plane (#555) | 119 | 2026-07-26T12:51:44.600Z |
