# Recovery: vault erase

This build has **no vault-erase gesture**. No command, `centraid` verb, or surface erases a vault or destroys its seal key; the v0 erase ceremony and its boot roll-forward were removed with the v0 tree in [#1020](https://github.com/srikanth235/centraid/issues/1020). The one erase primitive that exists is custody's: `MemberKeyCustody::destroy_all` destroys every member key file for a vault on the device that holds them, and nothing outside its tests calls it.

## What still holds

| Rule | Detail |
| --- | --- |
| **A copied backup is ciphertext** | The laptop holds sealed objects and no key. Copying its whole data directory yields ciphertext, sizes and timings, and nothing else |
| **The 24 words are the only way back** | Once a phone and its seed are gone, recovery is the written phrase and nothing on any host. There is no kit file, no password and no escrow |
| **Never hand-delete `node.key`** | It is the laptop's identity, not a vault's. Removing it makes the laptop a new endpoint every paired phone must pair with again |
| **A wiped phone is a restore, not a repair** | A fresh install plus the 24 words is the whole ceremony. Restoring makes the new phone a device at `epoch + 1`, and any surviving old phone freezes on `VAULT_MOVED` |

## Restoring a vault whose phone is gone

This is an ordinary restore: see [backup-restore.md](backup-restore.md).

## Escalation

If the 24 words are lost **and** the phone's keychain is gone, the vault is unrecoverable by design. Say so plainly rather than attempting recovery theatre; the remaining question is what to rebuild, not how to decrypt.

## Related

- [backup-restore.md](backup-restore.md) — the restore paths
- [../decisions.md](../decisions.md) — the "#298 erase posture" row
- [../logs.md](../logs.md) — where to read what happened
