# Recovery: vault erase

This build has **no vault-erase gesture**. No command, `centraid` verb, or surface erases a vault or destroys its seal key; the v0 erase ceremony and its boot roll-forward were removed with the v0 tree in [#1020](https://github.com/srikanth235/centraid/issues/1020). The one erase primitive that exists is custody's: `MemberKeyCustody::destroy_all` in [`crates/vault/src/custody/member_key.rs`](../../crates/vault/src/custody/member_key.rs) destroys every member key file for a vault on the seat that holds them, and nothing outside its tests calls it.

## What still holds

| Rule | Detail |
| --- | --- |
| **A copied vault is ciphertext** | `keys/` sits beside `vault/`, and export, backup and copy gestures never move it. Deleting a vault directory without its keys leaves sealed cells unreadable to whoever holds the copy |
| **The kit is the only way back** | Once key material is gone, recovery is a previously exported, password-wrapped kit plus a generation — nothing on the host |
| **Never hand-delete `keys/`** | `gateway.endpoint.key` and `backup.master.key` are not vault-scoped. Removing them turns a recoverable box into a new gateway every paired device must pair with again |
| **An empty `vault/` founds a new vault** | The next `centraid gateway --data-dir <dir>` founds over an empty `vault/`. Run `centraid recover` before the first start if you intend to restore |

## Restoring a vault whose directory is gone

This is an ordinary backup restore into a fresh data directory: see [backup-restore.md](backup-restore.md). Every device paired to the lost vault must pair again after the restore fences the replica epoch.

## Escalation

If the kit is lost **and** the key store is gone, the vault's sealed content is unrecoverable by design. Say so plainly rather than attempting recovery theatre; the remaining question is what to rebuild, not how to decrypt.

## Related

- [backup-restore.md](backup-restore.md) — the restore paths
- [../decisions.md](../decisions.md) — the "#298 erase posture" row
- [../logs.md](../logs.md) — where to read what happened
