# Recovery: backup and restore

**Recovery is 24 words.** There is no recovery kit file, no password, no key escrow and no reset link. Every key a vault has derives from one BIP39 phrase through a SLIP-0010 hardened tree; the phone keeps the 64-byte seed in the synced keychain, and the written phrase is the fallback.

The rulings are [decisions.md](../decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21); the protocol is [../gateway.md](../gateway.md); pairing is [pairing.md](pairing.md).

## What a backup is

| Piece | What it is |
| --- | --- |
| **base** | Page-aligned 4 MiB ranges of the live `vault.db`, sealed. **The unit of retention** (F10). Page-identical, because renumbering pages is what made WAL frames unreplayable in v0 (B4). |
| **segment** | A commit-bounded run of WAL frames, sealed. Capture is **commit-driven and debounced**, not on a timer. |
| **manifest** | The generation's sealed, hash-chained index, carrying the census at that txid **and the zstd dictionary the generation was sealed against** ([R-1029-6](../decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21)). |
| **spool** | The phone's queue of sealed objects not yet acked by the laptop. It survives restart and force-quit. |

Objects are at most 16 MiB, named by the BLAKE3 of their bytes, padded by Padmé, and write-once. A **drain** uploads the spool and commits one manifest entry per batch under a `prev_head` compare-and-set ([W15-D4](../decisions.md#w15--the-phones-request-contract-1029)), so a background window that ends mid-pass still advances the acked txid.

## Invariants (do not violate while recovering)

| Rule | Detail |
| --- | --- |
| The laptop holds **no key** | Every object is sealed under keys derived from the 24 words. A copy of the whole data directory yields ciphertext and sizes. |
| Storage is **write-once** | A name is the hash of its bytes; re-declaring a committed object is a no-op. That is what makes an interrupted pass free to re-run. |
| The head moves under a **compare-and-set** | Two phones racing a takeover produce one winner and one that is told `GATEWAY_HEAD_CONFLICT`. |
| A restore is onto a **fresh install** | It lays a base down and replays segments into a new file. It never repairs a file in place. |
| A restored phone is a **new device at epoch + 1** | The lease moves, and the old phone freezes read-only on `VAULT_MOVED` with its unacked commits visible (F1). That is the fence working. |
| The migration ladder is **appended to, never edited** | A rung's comment text trains the backup dictionary — [../traps/migration-header-is-a-format.md](../traps/migration-header-is-a-format.md). |
| **Forward-only schema** | A file below the binary is migrated with a pre-migration snapshot first; a file above it is refused, never guessed down ([`migrations.rs`](../../crates/vault/src/migrations.rs)). |

## Restoring onto a new phone

1. Install Centraid and choose **Restore**.
2. Type the 24 words. `RecoveryPhrase::parse` refuses a bad checksum rather than deriving from nonsense, so a mistyped word is caught before anything happens.
3. The phone derives each vault's keys and **finds the laptop**. The ordinary path is the vault's own signed pkarr record, resolved through `iroh-dns-server`. If the resolver is down or the network is walled, the member reads the endpoint id off the laptop's own screen and types it — `RestoreRequest.endpoint`, with `direct_addrs` for a LAN-only laptop that no relay can reach. Iroh's TLS proves the endpoint id, so a tampered address reaches the right laptop or nothing.
4. The phone opens the newest manifest, lays the base down and replays its segments, and claims the lease at `epoch + 1`.
5. **Compare the safety number** per vault. Each vault has its own identity key, so one number for all of them would confirm nothing about any of them. Empty means the phone could not compute one and is drawn as that, never as "it matched".

There is **no laptop-side vault listing**. A restoring phone derives its vault addresses from the phrase and probes; a listing endpoint would link a member's vaults to each other on the laptop, which is the unlinkability the per-vault identity key exists to give ([Q-1029-9](../decisions.md#open-questions-for-the-owner-1029)).

## Symptoms

| Symptom | What it means |
| --- | --- |
| `VAULT_MOVED` on the old phone | A restore took. See [pairing.md](pairing.md). |
| `GATEWAY_HEAD_CONFLICT` | Two writers raced. The loser is told the head as it stands; the compare-and-set is doing its job. |
| `GATEWAY_LEASE_STALE` | A lease claim at or below the epoch the laptop holds. A lease is claimed **once**, by pair or by restore, never per drain. |
| `GATEWAY_CLOCK_SKEW` | The phone's clock is outside the five-minute replay window. The refusal carries the server's time and the phone re-signs **once**. |
| `ERROR_CODE_PEER_UNREACHABLE` naming the seed | The core has its vault and not its keys — the shell has not handed the seed in. The member sees "unlock to back up". |
| `DictionaryMismatch` | A build whose dictionary moved is opening a generation sealed against a different one. The manifest carries its own dictionary, so this should not happen; if it does, read the trap above. |
| A restore completes and the vault is empty | `integrity_check` speaks about **pages, not rows**. A perfect page tree with no rows is a clean structural report and a total loss — which is why the drill adds `restored-census` and `restored-blob-coverage`. |

## The drill

`crates/vault/src/backup/drill.rs`, run by the `release` profile's `restore-drill` step, is the only test in the tree that asserts the whole durability chain end to end: found and commit, capture, take a generation, commit **more** so there is a tail the base does not cover, **destroy the live vault, its WAL and its spool**, restore from the object store and the two derived keys, and prove the result is `restore_check`-clean, census-matched and **byte-identical** to the vault that was lost.

What it does not cover is the two-device half — restore onto a second phone and watch the first freeze — which needs two devices and a laptop.

## Schema-change checklist

Every change that creates a durable table or column completes this in the same PR; "the SQLite file is copied" is not evidence on its own:

- append the rung under [`contracts/migrations/`](../../contracts/migrations) — **never edit an existing one, including its comments** — and prove a fresh file and a migrated file land on the same schema with a clean `foreign_key_check`;
- regenerate `contracts/schema/vault-ddl.sql` (`export-ladder-ddl`) and let [`ladder_ddl.rs`](../../crates/vault/tests/ladder_ddl.rs) confirm it is still derivable;
- seed the new data in the drill and assert the exact rows and references are readable after recovery;
- confirm the base carries the table — a base is the whole file, so it does, but a table added outside the ladder would not be in the census;
- verify an older binary refuses a newer file before mutating recovery material.

## What not to do

- `cp` the phone's live `vault.db` as a backup. See [../traps/wal-checkpoint.md](../traps/wal-checkpoint.md).
- Delete objects from the laptop's store to "clean up". Retention is the gateway's and deletes go through it, subject to the floor, the size guard and the rate limit.
- Treat the laptop as a second copy of the vault. It holds no key and nothing that opens one.
- Rely on the laptop alone. **A laptop-only backup is a local backup** — fire or theft takes both ([Q-1029-6](../decisions.md#open-questions-for-the-owner-1029)).

## Related

- [../gateway.md](../gateway.md) · [pairing.md](pairing.md) · [vault-erase.md](vault-erase.md)
- [ARCHITECTURE.md](../../ARCHITECTURE.md) — backup and recovery in context
- [`crates/vault/src/backup/`](../../crates/vault/src/backup) — capture, base, segment, manifest, spool, restore, drill
