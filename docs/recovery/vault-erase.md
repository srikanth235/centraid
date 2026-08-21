# Recovery: vault erase and restore-after-erase

Erase is the **most destructive** gesture the product exposes and the only one that deliberately destroys key material. This is the runbook for a stranded erase and for the restore that follows one.

Product paths: `packages/server/src/routes/vault-routes.ts` (the ceremony), `packages/server/src/serve/erase-recovery.ts` (boot roll-forward), `packages/server/src/backup/recover.ts` (the restore).

## What erase actually does

Erase **crypto-erases** the vault's independent DEK. That is the whole point: `docs/decisions.md` records the "#298 erase amendment" that supersedes #298's earlier "leave the seal key behind" posture. Copying the vault directory before an erase backs up _ciphertext only_.

The order is deliberate, and it is a roll-forward, not a rollback:

1. `erase_intents` gets a row, and every `gateway.db` row scoped to the vault is deleted in one transaction — `devices` (which cascades `web_sessions`), `tickets`, `backup_targets`, `cas_reconciliations`.
2. Content is deleted from `vault/<vaultId>/`.
3. The DEK — `keys/<vaultId>.sealkey` — is destroyed.
4. The `erase_intents` row is removed.

A crash anywhere in 2–4 leaves the intent row behind, and the **next boot completes it** (`recoverPendingVaultErases`). There is no "undo half an erase": once step 1 commits, the vault is going away.

**What survives an erase:** the gateway's EndpointId (`keys/endpoint-key.bin`), the backup keyring (`keys/keyring.key`), and the recovery-kit confirmation state. That is exactly what makes restore-after-erase-on-the-same-box possible without re-pairing the gateway itself.

## Invariants (do not violate while recovering)

| Rule | Detail |
| --- | --- |
| **Roll forward, never back** | A pending `erase_intents` row means finish the erase. Deleting the row to "save" the vault leaves half-erased state and a DEK that may already be gone |
| **The kit is the only way back** | Erase destroys the DEK. Recovery is the previously exported, password-wrapped kit plus a provider snapshot — nothing on the erased host |
| **Never hand-delete `keys/`** | `endpoint-key.bin` and `keyring.key` are NOT vault-scoped. Removing them turns a recoverable box into a new gateway every paired device must re-pair with |
| **Erase needs a verified kit** | The ceremony refuses with `recovery_kit_not_verified` unless the kit was verified. If you are being asked to bypass that, the answer is no — verify the kit first |

## Why an erase was refused

Every refusal is deliberate; none is a bug to route around.

| Response | Meaning | What to do |
| --- | --- | --- |
| `403 owner_required` | The calling device is not enrolled `owner` in this vault | Erase from an owner device, or grant owner with `centraid-gateway devices add --trust owner` (daemon stopped) |
| `503 erase_unavailable` | This host has no erase custody wiring (no `gateway.db` / `keys` / recovery-kit store) | You are on an embed without custody. Erase from the real gateway host |
| `409 typed_name_required` | `body.name` did not match the vault name **exactly** | Type it exactly — case, spaces, and all. This guard is the confirmation |
| `409 recovery_kit_not_verified` | The kit was never verified on this gateway | Download and verify the recovery kit first; then retry |
| `405 erase_ceremony_required` | Something issued a plain `DELETE /centraid/_vault/vaults/:id` | Use `POST /centraid/_vault/vaults:erase` with the exact name |

## Symptoms

- The erase request returned 5xx and the vault is partly gone
- The erase response reported `remainingVaults: 0` and the gateway's vault health component is `error: no vault is mounted`
- Devices lost access to a vault that still appears on disk
- Restore-after-erase fails with `restore_failed`

## Steps — an erase that died mid-flight

1. **Stop the daemon.** Filesystem maintenance verbs take `gateway.db`'s exclusive lock and refuse while it runs.
2. Confirm the intent exists:
   ```sh
   sqlite3 "$DATA_DIR/gateway.db" 'SELECT * FROM erase_intents;'
   ```
   A row here means the erase committed its state transaction. It **will** be completed.
3. **Start the daemon.** Boot runs `recoverPendingVaultErases`, which finishes content deletion and DEK destruction and clears the row. Read [logs.md](../logs.md) to confirm.
4. Verify the end state: `centraid-gateway vault list --data-dir "$DATA_DIR"` no longer shows the vault, and `keys/<vaultId>.sealkey` is gone.
5. Zero vaults is **not** a legal steady state since issue #603. The vault health component reports `error: no vault is mounted`, and there is no first-run Create / Restore screen to fall back to — restore is a backup-plane act (below).

> **Do not restart the daemon with an empty `vault/` if you intend to restore.** Auto-founding fires at construction on a data dir with no vault directory, so the next boot creates a brand-new `Personal` vault and the data dir is no longer vault-free. Keep the daemon **stopped** between the erase and the restore.

## Steps — restore after an erase, on the same box

The gateway keeps its identity and its `keyring.key`, so this is a **backup** restore into the surviving data dir, not a new gateway. There is no founding ticket and no founding restore route any more (issue #603).

1. Have all three in hand: the **password-wrapped recovery kit** file, its **password**, and the **provider API key**. The key is deliberately not in the kit (`FORMAT.md`). Without all three, stop — there is nothing else to try.
2. Keep the daemon **stopped** (see the warning above) and confirm the data dir is genuinely vault-free: `centraid-gateway status --data-dir "$DATA_DIR" --json` reports `vaultCount: 0` with no `failedMounts`.
3. Run the offline recover verb from the host:
   ```sh
   centraid-gateway recover --kit <file> --password-file <file> \
     --api-key <key> --data-dir "$DATA_DIR"
   ```
   It takes `gateway.db`'s exclusive lock, so it refuses while the daemon runs. The restore reuses the surviving `keyring.key`; a kit whose keyring differs is **refused** rather than overwriting live key material.
4. Start the daemon. The recovered vault directory is already on disk, so `isFresh()` is false and nothing is auto-founded over it.
5. Expect the previous enrollments to be gone. Erase deleted `devices`, so every device re-pairs. The gateway's EndpointId is unchanged, so the gateway itself does not need re-adding.

## When restore-after-erase refuses

| Message | Meaning |
| --- | --- |
| `recovery kit: expected a password-wrapped kit` | An unwrapped kit was supplied. Unwrapped kits are not accepted (issue #568) — use the file `backup kit` wrote |
| `recovery kit: wrong password or corrupt file` | Wrong password, or the file was edited. Neither is recoverable by retrying with the same inputs |
| `gateway custody contains a different backup keyring` | This kit belongs to a different gateway. Restore it onto a blank data dir instead of over this one |
| `restore_target_conflict` | A vault directory with that id already exists locally. Resolve the directory first; never merge trees by hand |
| `the running daemon holds gateway.db — stop it before recovering into this data dir` | `recover` is an offline verb. Stop the daemon (and see the warning above about restarting it into an empty `vault/`) |

## Escalation

If the kit is lost **and** the DEK was erased, the vault's sealed content is unrecoverable by design. Say so plainly rather than attempting recovery theatre; the remaining question is what to rebuild, not how to decrypt.

## Related

- [backup-restore.md](backup-restore.md) — the non-erase restore paths
- [../decisions.md](../decisions.md) — the "#298 erase amendment"
- [../logs.md](../logs.md) — where to read what happened
