# Recovery: vault erase and restore-after-erase

Erase is the **most destructive** gesture the product exposes and the only one
that deliberately destroys key material. This is the runbook for a stranded
erase and for the restore that follows one.

Product paths: `packages/gateway/src/routes/vault-routes.ts` (the ceremony),
`packages/gateway/src/serve/erase-recovery.ts` (boot roll-forward),
`packages/gateway/src/backup/recover.ts` (the restore).

## What erase actually does

Erase **crypto-erases** the vault's independent DEK. That is the whole point:
`docs/decisions.md` records the "#298 erase amendment" that supersedes #298's
earlier "leave the seal key behind" posture. Copying the vault directory before
an erase backs up *ciphertext only*.

The order is deliberate, and it is a roll-forward, not a rollback:

1. `erase_intents` gets a row, and every `gateway.db` row scoped to the vault
   is deleted in one transaction — `devices` (which cascades `web_sessions`),
   `tickets`, `backup_targets`, `cas_reconciliations`.
2. Content is deleted from `vault/<vaultId>/`.
3. The DEK — `keys/<vaultId>.sealkey` — is destroyed.
4. The `erase_intents` row is removed.

A crash anywhere in 2–4 leaves the intent row behind, and the **next boot
completes it** (`recoverPendingVaultErases`). There is no "undo half an erase":
once step 1 commits, the vault is going away.

**What survives an erase:** the gateway's EndpointId (`keys/endpoint-key.bin`),
the backup keyring (`keys/keyring.key`), and the recovery-kit confirmation
state. That is exactly what makes restore-after-erase-on-the-same-box possible
without re-pairing the gateway itself.

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
- The gateway restarted mid-erase and now reports `uninitialized`
- Devices lost access to a vault that still appears on disk
- Restore-after-erase fails with `restore_failed`

## Steps — an erase that died mid-flight

1. **Stop the daemon.** Filesystem maintenance verbs take `gateway.db`'s
   exclusive lock and refuse while it runs.
2. Confirm the intent exists:
   ```sh
   sqlite3 "$DATA_DIR/gateway.db" 'SELECT * FROM erase_intents;'
   ```
   A row here means the erase committed its state transaction. It **will** be
   completed.
3. **Start the daemon.** Boot runs `recoverPendingVaultErases`, which finishes
   content deletion and DEK destruction and clears the row. Read
   [logs.md](../logs.md) to confirm.
4. Verify the end state: `centraid-gateway vault list --data-dir "$DATA_DIR"`
   no longer shows the vault, and `keys/<vaultId>.sealkey` is gone.
5. If the gateway now has zero vaults it is legally `uninitialized` and the
   first-run screen offers Create / Restore. That is correct, not a fault.

## Steps — restore after an erase, on the same box

The gateway keeps its identity, so this is a founding **restore**, not a new
gateway.

1. Have both in hand: the **password-wrapped recovery kit** file and its
   **password**, plus the **provider API key**. The key is deliberately not in
   the kit (`FORMAT.md`). Without all three, stop — there is nothing else to
   try.
2. Confirm the gateway is genuinely vault-free
   (`centraid-gateway status --data-dir "$DATA_DIR" --json` reports
   `vaultCount: 0`).
3. From the host itself, mint a founding ticket and run the restore through the
   first-run screen (Restore vault), or `POST
   /centraid/_vault/vaults:restore`. The restore reuses the surviving
   `keyring.key`; a kit whose keyring differs is **refused** rather than
   overwriting live key material.
4. Expect the previous enrollments to be gone. Erase deleted `devices`, so
   every device re-pairs. The gateway's EndpointId is unchanged, so the
   gateway itself does not need re-adding.

## When restore-after-erase refuses

| Message | Meaning |
| --- | --- |
| `recovery kit: expected a password-wrapped kit` | An unwrapped kit was supplied. Unwrapped kits are not accepted (issue #568) — use the file the ceremony downloaded |
| `recovery kit: wrong password or corrupt file` | Wrong password, or the file was edited. Neither is recoverable by retrying with the same inputs |
| `gateway custody contains a different backup keyring` | This kit belongs to a different gateway. Restore it onto a blank data dir instead of over this one |
| `409 restore_target_conflict` | A vault directory with that id already exists locally. Resolve the directory first; never merge trees by hand |
| `409 founding_in_progress` | Another founding ceremony holds the single founding slot. Wait for it to finish or fail — replacing its ticket would roll back an in-flight restore |

## Escalation

If the kit is lost **and** the DEK was erased, the vault's sealed content is
unrecoverable by design. Say so plainly rather than attempting recovery
theatre; the remaining question is what to rebuild, not how to decrypt.

## Related

- [backup-restore.md](backup-restore.md) — the non-erase restore paths
- [../decisions.md](../decisions.md) — the "#298 erase amendment"
- [../logs.md](../logs.md) — where to read what happened
