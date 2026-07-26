# Receipt — issue #555: Vault founding plane and device-local connections

Issue #555 replaces implicit vault bootstrap and the split gateway/device state
model with an explicitly founded, lock-owned gateway. This receipt is updated
phase by phase so each intermediate commit remains auditable.

## Checklist

- [x] After a lease conflict clears, the WAL shipper re-arms within one tick; a crash + fast restart inside `LEASE_FRESH_WINDOW_MS` does not disable capture for the process's lifetime
- [x] Regression test drives the real sequence (claim → foreign-fresh lease → mount → conflict clears → shipper captures) and fails against today's `main`
- [ ] A gateway with no `core_vault` row boots healthy, reports `status: "uninitialized"`, `/centraid/_vault/vaults` → `{"vaults":[]}`, and does NOT create a vault
- [ ] Automations scheduler, health probes, and `/centraid/_apps` return explicit empty-but-healthy answers at zero vaults
- [ ] Pairing against an uninitialized gateway returns `409 uninitialized` (no hang); the phone shows a sensible error
- [ ] `centraid-gateway pair --vault` still requires an existing vault, and its failure on a virgin gateway points the operator at `init-ticket`
- [ ] `VaultRegistry.delete()` no longer throws `vault_last`; zero vaults is a legal registry state with zero mounted planes
- [ ] `serve --init-vault <name>` yields a ready vault headlessly, is documented as KIT-LESS, and every suite that assumed auto-bootstrap is migrated to it
- [ ] A second gateway on the same root **exits immediately** with an actionable message; the first is unaffected and keeps serving
- [ ] A mutating `--data-dir` CLI command refuses while the daemon holds the lock, pointing at it; a **read-only** CLI open succeeds
- [ ] Killing the holder (`SIGKILL`) releases the lock with no cleanup step — the next start acquires immediately, with no freshness window
- [ ] `lock-status` reports the holder by asking the running daemon, and reports "held, not answering" plus the OS-level holder when it is wedged; **no override flag exists**
- [ ] `gateway.db` exists with its full schema at zero vaults, and `prefs.json` / `devices.json` / `tickets.json` / `recovery-kit.json` / `backup.json` / `storage/` are **gone** — nothing in the tree writes them
- [ ] Redeeming a ticket and creating the first enrollment happen in **one transaction**: a crash injected between them leaves the ticket unredeemed and the gateway still foundable
- [ ] Two concurrent redemptions of one founding ticket produce exactly one success — asserted against the rowcount, not a mutex
- [ ] Revoking a device removes its web sessions by **`ON DELETE CASCADE`**, and severs the transport because the enrollment the QUIC listener admits on is gone
- [ ] `gateway.db` **is** the lock: `PRAGMA locking_mode` is `EXCLUSIVE`, the handle is held for process lifetime, no `gateway.lock.db` is ever created, and no separate `-shm` sidecar appears
- [ ] With the daemon **stopped or crash-looping**, `sqlite3 gateway.db` opens and reads normally — the case a separate lock file existed to serve is covered by the daemon not holding it
- [ ] `gateway.db` has **no `vaults` table** — a test asserts vault enumeration still reads the filesystem, so the founding gate's zero-vaults precondition cannot disagree with the registry root
- [ ] `GatewayInstanceLease`, `gateway.lease`, and all `leaseConflicted` plumbing are **gone**; WAL ownership is unconditional and no code path can disarm the shipper
- [ ] A data dir on a network mount surfaces a health **warning**, not a refusal — **and** sets `skipOrphanDelete`, so blob GC never deletes under a possible cross-host writer
- [ ] `endpoint.json` no longer exists; the `pair` and `status` CLIs derive `endpointId` from the identity key and obtain a live ticket from the running daemon, reporting a clear "daemon not running" when it is not
- [ ] The desktop embed participates in the lock
- [ ] **The data dir is identical in shape on a laptop and a VPS** — a test diffs the desktop-embedded tree against a `centraid-gateway serve --data-dir` tree after the same operations and asserts the entry sets match. `cli/paths.ts`'s layout header is rewritten to match, having documented six files that no longer exist
- [ ] **No process other than the daemon writes into the data dir** — `profile.json`, `gateway.status.json`, `gateway.ownership.json`, and `token.bin` do not appear anywhere under it, on any platform, at any point in the lifecycle
- [ ] The desktop's connection list renders **with no gateway running and no data dir present** (the remote case), from device-local storage rather than a `gateways/` directory scan
- [ ] A remote-only gateway connection creates **no local directory at all** — adding, using, and forgetting it touches only device storage and the OS keychain
- [ ] The registry is **one `connections.json`**, not a directory per connection, and both it and the credentials are owned by the desktop **main** process; a test asserts the renderer's `centraid.v1.` localStorage holds no connection record and no credential
- [ ] A connection record carries `endpointId` and **no `url` and no `transport` field**; nothing in the codebase can add a gateway by URL, and the url/iroh XOR in `validateAddGatewayFields` is gone because there is no second branch
- [ ] **`device_tokens`, `device-token-store.ts`, and the `cdt_…` prefix do not exist**; `gateway.db` has no such table, and no code path mints or resolves a bearer
- [ ] **`POST /centraid/_gateway/pair` is gone** — pairing is iroh-only, and the web PWA pairs over iroh-wasm like every other client
- [ ] **Revoking a device makes the QUIC handshake itself refuse** — a revoked device cannot open a connection at all, and `revocation-severs-planes.test.ts` (minus its token plane) still passes
- [ ] `web_sessions` is unaffected: a browser control cookie still survives a gateway restart on its sliding window
- [ ] **A gateway is identified by its EndpointId, not its address** — changing a relay hint, or losing it entirely, does not create a new connection or require re-pairing; the hint is refreshable cache, and no stored pairing ticket is treated as durable identity
- [ ] **`iroh-device-key.bin` no longer exists in any gateway tree** — the device's iroh secret lives in `safeStorage` / Keychain / Keystore, keyed per connection, and its EndpointId still matches the enrolled `devices` row across a restart (the `ensureIrohDeviceKey` invariant survives the move)
- [ ] `gateway-paths.ts`'s header lists what the directory actually contains — it currently omits `iroh-device-key.bin`, the ownership stamp, and the status file
- [ ] `centraid-gateway serve` with **no `--data-dir`** resolves the platform default; `--data-dir` and `CENTRAID_DATA_DIR` still override, in that precedence
- [ ] **The desktop, the CLI, and the OS service all land on the same data dir by default** — starting the second while the first runs hits the lock and exits, which is only possible once the default exists
- [ ] **No gateway data lives under the desktop's `userData`** — a test asserts the resolved default is outside it, so removing the desktop application's data cannot delete a vault
- [ ] Supervisor decisions no longer consult a pid for liveness: `isProcessAlive` and `startedAt` are gone, `stale-reclaim` reduces to "lock free, start", and `probe-failed-refuse` fires on lock-held-plus-no-answer
- [ ] A daemon restart does not disturb any device's connection record or token — asserted for desktop and for a paired phone
- [ ] A corrupt (non-32-byte) `endpoint-key.bin` **throws** with an actionable message naming both remedies; a corrupt device key re-mints with a warning
- [ ] Minting goes through temp-file + rename: an interrupted first boot leaves either nothing or a complete key, never a short file
- [ ] A `chmod 644` key self-heals to `0600` with a warning rather than refusing
- [ ] All three call sites use the shared `@centraid/tunnel` loader with an explicit `onCorrupt` policy
- [ ] Every sealing-key read/write in the codebase goes through `KeyStore`; no phase-3/4 code names `vault/keys/<vaultId>.sealkey` directly
- [ ] **`keys/` is the only directory holding secrets**, and a test asserts no file under it parses as raw key material: the four secrets (vault DEKs, `connections.sealkey`, endpoint key, backup keyring) all live there, wrapped. The test sweeps the **whole data dir**, not just `keys/`, and passes with **no exemption list** — which is only possible because device credentials moved to devices
- [ ] **`vault/` holds vault content only** — a test asserts no key, lock, or coordination file appears anywhere under it, and `ARCHITECTURE.md:131` becomes true rather than aspirational
- [ ] Deleting `gateway.db` and `cache/` no longer destroys the master keys; the backup engine re-seeds fencing from the provider and reads existing snapshots on the surviving keyring
- [ ] **No key material lives in `gateway.db`** — a test greps every table for raw or base64 key bytes; the one sealed column holds ciphertext whose key is in `keys/`
- [ ] `keys/` custody survives the fold: `LoadCredentialEncrypted=` still points at a real path, and crypto-erase is still a single `unlink` with no `VACUUM` in the erase path
- [ ] `backup/` and `storage/` no longer exist: keyring in `keys/`, code bundles in `cache/`, state in `gateway.db`; no code or doc comment references a `staging/` dir
- [ ] `sourceInstanceId` is derived (`HMAC(endpointSecret, "backup-source")`), not stored; it is stable across a restart and a lost `gateway.db`, and is not computable by a provider holding the public endpoint id
- [ ] `local-usage.ts`'s storage components match the new layout — the `backup` component no longer claims to walk a keyring or a staging dir
- [ ] No `custody.json` or equivalent index exists; wrapping scheme is read off the envelope
- [ ] On desktop with `safeStorage` available, the at-rest key is wrapped, and **a `<dataDir>` copied to another machine cannot open its sealed columns**
- [ ] On Linux desktop without libsecret, the store degrades to the 0600 file with a warning rather than failing
- [ ] Headless keeps the 0600 file with a pluggable wrap seam; no passphrase-at-boot path exists
- [ ] Per-vault DEKs are independent — no code path re-derives a vault's key from a master keyring
- [ ] A store opening a pre-existing plaintext key adopts and (where supported) wraps it in place, preserving the `core_vault` fingerprint check
- [ ] `resolveSealKey`'s no-key / right-key / wrong-key distinction and `.sealkey.next` rotation completion survive the refactor
- [ ] SECURITY.md states the headless boundary explicitly
- [ ] `POST /centraid/_vault/vaults:initialize` creates a vault only for a landlord-authorized caller (loopback, or a redeemed founding ticket) and only at zero vaults — otherwise `409`
- [ ] `vaults:restore` sits behind the **same** gate, and `recoverHandler` no longer has an admin-plane mount
- [ ] A founding ticket is one-time and short-lived (10 min); a second redemption fails, minting a new one invalidates the prior, and it is refused once a vault exists
- [ ] **VPS + phone journey with no desktop anywhere:** SSH → `init-ticket` → redeem on phone → full ceremony on the phone → kit saved off-device via the share sheet → vault ready
- [ ] Desktop founds through the same gate: afterwards `desktop-loopback-token.bin` does not exist, the desktop holds an `owner`-trust enrollment keyed to its own iroh EndpointId (secret in `safeStorage`), and a daemon restart does not break re-adoption
- [ ] `desktop-loopback-token.bin` is excluded from the backup tarball
- [ ] First-run shows Create / Restore as peer paths; no Home until one completes; a device pairing into a founded gateway never sees either
- [ ] Create ceremony gates in order: password → wrapped kit delivered → mandatory re-select verify (fingerprint check) → loss-consent checkbox. None skippable
- [ ] The kit is a passphrase-wrapped file containing keyring + sealing key + target addressing, excluding provider credentials; the wrap uses scrypt with `{kdf,N,r,p,salt}` in the header; `parseRecoveryKit` round-trips it
- [ ] Restore accepts kit + password and completes the recover flow to an adopted vault with **sealed columns readable**, with both the sealing key and the keyring placed via `KeyStore.import()`; the next backup runs on the restored keyring
- [ ] A founding ticket and a pairing ticket share one file and one store; a founding ticket carries no `vaultId` and a pairing ticket still requires one
- [ ] Adding a backup target, rotating an epoch, **or creating a second vault** flags the kit stale and surfaces exactly one re-download prompt; re-downloading an unchanged kit does not
- [ ] **A gateway with two backed-up vaults has both sealing keys in one kit**, each in its own target row, and restoring from it makes **both** vaults' sealed columns readable. A test creates vault B after the kit was written and asserts the fingerprint went stale
- [ ] **A local-only vault stays local-only**: creating a vault opts it into neither remote CAS nor a backup target, it has no row in the kit, and it costs zero offsite bytes. Creating one does **not** flag the kit stale (there is nothing new to protect)
- [ ] Ceremony copy says the kit unlocks **backed-up** vaults, not "everything"; a gateway holding one backed-up and one local-only vault says so where the kit is presented
- [ ] Enabling remote CAS on a vault with no backup target degrades a health component and warns at the point of opt-in, naming the consequence (offsite bytes that no kit can decrypt)
- [ ] `BackupState.recoveryKit` and the `backup-service.ts:1667` fallback are gone; the `recovery_kit` row is the only representation of kit confirmation
- [ ] Erase: typed-name confirm → fence/generation bump → gateway returns to uninitialized → first-run shown
- [ ] Erasing the LAST vault succeeds and leaves the registry with zero mounted planes
- [ ] After erase, no row in any `gateway.db` table references the erased vaultId; a previously-paired device gets a clean re-pair prompt, not a token for a dead vault
- [ ] **The post-erase tree diffs clean against the vaultless layout** — the test is a tree comparison, not a deletion checklist, so a file added later cannot silently survive an erase
- [ ] `KeyStore.destroy()` removes the key and `.sealkey.next` in every at-rest form; a pre-erase directory copy cannot decrypt sealed columns. The #298 amendment is documented
- [ ] `kitFingerprint` + confirmation flag persist at the gateway level and survive an erase — a fresh create overwrites them; an erase alone does not resurrect a stale kit prompt
- [ ] Gateway identity files are byte-identical across an erase
- [ ] **Erase → restore on the same box** preserves the endpoint identity byte-for-byte, leaves zero enrollments, and a previously-paired device gets a clean re-pair prompt
- [ ] No `admin` plane exists in gateway source; every request resolves to a real enrollment in a specific vault, and nothing is implicitly enrolled in all of them
- [ ] A request with no resolvable device identity **fails closed**, and a regression test asserts it (today it would succeed with wildcard reach)
- [ ] The loopback embed and every test suite that relied on implicit universal access hold real enrollments
- [ ] A newly paired (non-founding) device lands at `full` trust, not `owner`
- [ ] Revoking the last `owner` enrollment requires typed confirmation naming the consequence, and the SSH/CLI recovery from that state is tested

## What changed

- **After a lease conflict clears, the WAL shipper re-arms within one tick; a crash + fast restart inside `LEASE_FRESH_WINDOW_MS` does not disable capture for the process's lifetime.** `VaultPlane` now evaluates WAL ownership against the live lease-conflict predicate. A plane mounted while conflicted keeps its capture clock armed and constructs the shipper on the first eligible tick.
- **Regression test drives the real sequence (claim → foreign-fresh lease → mount → conflict clears → shipper captures) and fails against today's `main`.** `vault-plane.test.ts` exercises a real `GatewayInstanceLease`, forces a fresh foreign record before mount, advances it beyond freshness, reclaims it, and proves both WAL generations are captured on the next tick.

Current changed files:

- `packages/gateway/src/serve/vault-plane.ts`
- `packages/gateway/src/serve/vault-plane.test.ts`
- `receipts/issue-555-vault-founding-plane.md`

## Out of scope

- None for the issue. The unchecked checklist items are the remaining phases of this same PR.

## Verification

```sh
bun run build
bun run --cwd packages/gateway test -- src/serve/vault-plane.test.ts -t 'WAL capture re-arms after a fresh foreign lease conflict clears'
bun run --cwd packages/gateway typecheck
```

The full `vault-plane.test.ts` file also ran: the new regression and 22 other tests
passed, while two pre-existing owner-route tests timed out at their 30-second
limits. The isolated regression and package typecheck are green.

## Decisions

- The Phase 0 compatibility fix is intentionally isolated before deleting the lease in Phase 1, as required by the issue. This proves the existing safety model is repaired before its replacement lands.

## Audit

PASS — A fresh-context auditor found that `## What changed` matches the
two-file code diff, both checked items are realized by the regression's claim →
foreign-fresh lease → conflicted mount → freshness expiry → next `walTick()`
sequence, and the checklist text and order exactly mirror issue #555.

## Steering

PASS — A fresh-context audit of session
`019f9e70-5250-7862-b42f-4db4a9d7686c` found no human-steering events. The
initial request, GitHub-login authorization, and completion confirmation were
ordinary task messages, and no interrupt records appeared. No steering rows are
required.

## Accounting

Populated by the governance commit hook.

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019f9e70-525-1785071812-1 | codex | 019f9e70-5250-7862-b42f-4db4a9d7686c | #555 | gpt-5.6-sol | 484654 | 0 | 11650816 | 26396 | 511050 | 4.5203 | 484654 | 0 | 11650816 | 26396 | fix(gateway): re-arm WAL capture after lease conflict (#555) |
