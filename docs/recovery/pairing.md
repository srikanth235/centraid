# Recovery: founding and enrollment

Use this runbook when a gateway's first boot did not produce the vault you expect, a pair ticket expired, or a device lost its identity. The pairing wire is [`crates/net/src/pairing.rs`](../../crates/net/src/pairing.rs); its end-to-end test is [`crates/net/tests/pair_and_stream.rs`](../../crates/net/tests/pair_and_stream.rs). The full enrollment model is [enrollment.md](../enrollment.md).

## Founding

There is no founding ceremony, no founding ticket, and no `uninitialized` state. `centraid gateway --data-dir <dir>` founds a vault the first time it finds none:

1. Under `<dir>/vault/` it stages a new `vault.db` in `.founding/`, writes the vault and owner rows, and renames the directory to `<dir>/vault/<vaultId>/`. The vault's display name is `--vault-name` (default `Centraid`). stderr says `FOUNDED a new vault <id> (owner party <id>)`.
2. On every later start it opens the one vault it finds. A data dir holding two vaults is refused, never guessed at; a `vault.db` with a schema and no vault row is refused with the reason ("created and never founded").
3. Nothing else happens. No kit is minted and no ticket is issued unless `--print-qr` asks for one.

Without `--data-dir` the gateway runs entirely in memory and says so on stderr: no vault, and every pairing is lost on exit.

Restoring an existing vault onto a blank machine is the backup plane, not founding: see [backup-restore.md](backup-restore.md). Run `recover` **before** the first `centraid gateway` against that data dir, or the gateway founds a new vault there.

## Ordinary enrollment

1. On the gateway host, start the gateway with tickets: `centraid gateway --data-dir <dir> --print-qr [N]`. `--print-qr` with no value mints one ticket; a count mints that many, because a ticket is one-shot and a phone and a tablet need two. Each is printed as a QR and as a `base64url` line.
2. The device scans the QR (mobile) or runs `centraid seat pair <ticket>` (a desktop or headless seat). The redeeming connection is accepted provisionally, may carry only a `pair` request, and is promoted in place on success, so pairing and the first bootstrap share one dial.
3. Redemption burns the ticket and enrols the device in one critical section. Enrollment lives in the vault's own `access_device` / `access_device_secret` rows, so it survives a gateway restart.
4. Every later connection is admitted by the device's proven iroh EndpointId. Unknown and revoked are one refusal.

`centraid pair --mint` mints from a process that exits immediately, so nothing can redeem its ticket; it says so on stderr. Use `centraid gateway --print-qr`.

## Durable state

| Location | Role |
| --- | --- |
| `<data-dir>/vault/<vaultId>/vault.db` | the vault, including the enrolled devices (`access_device`, `access_device_secret`) |
| `<data-dir>/keys/gateway.endpoint.key` | the gateway's long-term iroh identity. Losing it changes the EndpointId and every paired device must pair again |
| Device platform secure store | one enrollment record per vault: the device's private identity key, the vault id, dialling hints ([`Enrolments.kt`](../../mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/Enrolments.kt)) |
| Device replica | named by `vault_id` only, never by the gateway ([traps/seat-identity.md](../traps/seat-identity.md)) |

Tickets are **not** durable: only the secret's hash is held, in memory, for 15 minutes (`TICKET_TTL_MS`). A gateway restart invalidates every outstanding QR. Relay hints are refreshable address cache, not identity.

## Recovery steps

### Ticket expired, consumed, or minted before a restart

Mint a new one by restarting with `--print-qr`. Never try to revive or edit the old value. A wrong secret and an unknown ticket are the same refusal; an expired or already-burnt ticket says so.

### Device enrolled but cannot connect

1. Check the gateway's stderr for the ready line (`centraid gateway ready`) and for the endpoint-identity warning — a gateway that could not keep its identity says it minted a fresh one and every seat must pair again.
2. Run `centraid doctor --data-dir <dir>` to confirm the vault opens cleanly.
3. If the device's secure store was cleared, its identity is gone: pair it again with a new ticket. The old device row stays in the vault until it is revoked.
4. For relay-only failures, try `--no-relay` on a LAN or pass `--relay <url>` for a self-hosted relay, and read [logs.md](../logs.md) with `--log centraid_net=debug`.

### Revoking a lost device

Revocation is the `devices.revoke` admin command ([`admin.proto`](../../crates/api-proto/proto/centraid/core/v1/admin.proto)): it deletes the device's private key sibling and keeps its row, so the device list still shows it and the door no longer admits it. `centraid devices list` and `centraid devices revoke <device>` exit `3` in this build — the verbs are owed, not silent stubs.

### Gateway identity is corrupt or lost

Stop the gateway before custody work. Restore the original `keys/gateway.endpoint.key` from wherever you keep `keys/` out of band; deleting it deliberately mints a new identity and every device must pair again. The key store is never part of a backup generation or an export.

## Do not

- Hand-edit `vault.db` while the gateway runs.
- Persist pair tickets anywhere.
- Copy device credentials into the gateway data directory.
- Commit real pair tickets, endpoint secrets, or recovery kits.
- Delete `vault/` to "reset" a gateway — the next start founds a new vault over the directory.
