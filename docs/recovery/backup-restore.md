# Recovery: backup / restore / recover

When backup, restore, or blank-machine `recover` strands mid-flight. Product paths live in `packages/server` backup service and `@centraid/backup`.

## Invariants (do not violate while recovering)

| Rule | Detail |
| --- | --- |
| Restore is **side-directory** | Never overwrite the live vault tree in place |
| **Lazy default** | Blobs may fetch on first access; `--full` is explicit |
| **Fencing** | Successful recover adopts with generation bump so the old machine's next register fails (no split-brain) |
| Keys | Sealing keys, the Locker key `K` and the recovery kit are outside casual vault copy — need the kit + provider credentials |
| A **snapshot never carries a key** | Long-lived key material stays out of every snapshot by construction (`packages/server/src/backup/backup-sources.ts` — the word "seal" does not occur in it). Locker key custody rides the kit, and only the kit ([#996](https://github.com/srikanth235/centraid/issues/996) R13). Enforced by `packages/server/src/backup/backup-sources.test.ts`, which asserts no `seal-key` entry from either a fresh or a sealed vault; `packages/backup/FORMAT.md` lists that manifest kind as read-only legacy for the same reason |
| A **kit passphrase meets a floor when it is written, and never when it is read** | Sealing a password-wrapped document (recovery kit, portable-custody kit) requires at least 12 characters or at least 4 words; the empty string was the only previous refusal, so `a` sealed a kit ([#1014](https://github.com/srikanth235/centraid/issues/1014) X13). `assertPassphraseFloor` in `packages/backup/src/password-wrap.ts` is the rule, called from the wrap itself and again at the export door so a weak passphrase is a 400 rather than a failed export. OPENING a document never applies it: a kit written before the floor existed, or under a policy that later tightens, must still open — a strength rule that can lock an owner out of their own recovery material is worse than the weak password it prevents |
| **One file** | Since [#916](https://github.com/srikanth235/centraid/issues/916) a vault dir holds one database, `vault.db` — the audit band and the conversation ledger are bands inside it, not a sibling `journal.db`. A manifest carries exactly one `db` entry, and the WAL stream is addressed by generation with one tick marker per tick ([traps/wal-checkpoint.md](../traps/wal-checkpoint.md)). A directory holding a pre-#916 two-file install is an old-format install: there is no migration, and its `user_version` is ahead of the ladder this build understands, so `openVaultDb` refuses it with `VaultSchemaAheadError` |
| The kit is an **export**, not a first-run artifact | Since issue #603 nothing mints a kit for you. Export it deliberately (`centraid-gateway backup kit --out …`, or the Backup screen) _before_ you need it |

## Schema-change recovery checklist

Every change that creates a durable table or column must complete this checklist in the same PR; “the SQLite file is copied” is not evidence on its own:

- state the shape in the baseline. Since [#916](https://github.com/srikanth235/centraid/issues/916) rung one is the whole baseline, stated rather than reconstructed, because v0 had no files in the field; [#929](https://github.com/srikanth235/centraid/issues/929) added **rungs two through four**, the first changes that had to reach a file that already existed, [#972](https://github.com/srikanth235/centraid/issues/972) added **rung five** so `share_authority_request` / `share_authority_use` reach files frozen at `user_version` 2, and [#996](https://github.com/srikanth235/centraid/issues/996) added **rung six**, the Locker key plane (`locker_key` and the `key_id` column on the three tables that hold ciphertext). A fresh vault stamps `PRAGMA user_version = 6`. `migrate.test.ts` proves the fresh file lands on 6, that reopening it is a no-op with no schema drift, and that `foreign_key_check` is clean. The forward-only ladder and its downgrade refusal (`VaultSchemaAheadError`) stay — they are what makes the FIRST post-v0 rung safe;
- seed the new data in the backup integration fixture, restore it to a side directory, and assert the exact rows and references are readable;
- seed the same data in the restore-after-erase recovery fixture and assert it survives kit/provider recovery after the live DEK has been destroyed;
- include new blob/content references in GC-root enumeration and integrity manifests where applicable;
- verify an older binary refuses a newer storage/protocol epoch before downloading or mutating recovery material.

`locker_auth_credential` (issue #630) is the preservation canary for the restore half of this rule. Backup and restore fixtures must seed the credential row as well as a Locker item: restoring only `locker_item` would silently reset the owner's user-presence boundary. The verifier is usable only with the restored vault DEK; neither its source passphrase nor any live Locker session/item permit belongs in a snapshot, recovery kit, audit band, or receipt.

Receipt capture extends that canary: recovery fixtures publish a real `tally.add_receipt_expense` and assert the canonical `role='receipt'` attachment on the expense (ruling O-attach retired the app-local `tally_expense_receipt` table), the reviewed OCR text derivative, the `tally_expense_line_item` rows whose `receipt_id` names that attachment, and the per-party allocations — after both side-directory restore and restore-after-erase. Restoring only the image blob or only `tally_expense` is data loss.

Push endpoint registrations are intentionally different from user data. Expo tokens, browser subscriptions, and the gateway VAPID private key are gateway/device capabilities in mode-0600 `gateway.db`; they are revoked on unlink and automatically re-registered after a device reconnects. Copying them into a vault snapshot would resurrect delivery authority after device revocation or blank-machine recovery, so they do not enter the vault backup plane. Reminder definitions and delivery state remain vault data and follow the normal checklist above.

## The Locker key `K` (#996, R13)

Locker secrets are ciphertext under one per-vault key `K`, and the gateway never serves the plaintext — a seat decrypts locally after its own unlock boundary. `K` is minted at vault founding into the gateway's `keys/` directory, the same custody as the vault DEK and the identity seed, and `locker_key` in the vault carries the key **id** and nothing else.

Three consequences for recovery, each with a test behind it:

- **The kit carries every live key file, and the snapshot carries none.** `recoveryKitDocument` fills `lockerKeys` from the `keys/` directory, as a **list**: a rotation writes `K′` to disk before the vault names it, so a kit written in that window that carried only the currently-live id would restore ciphertext that stops opening the moment the rotation completes.
- **A restore without a key file is refused, with the reason.** `recover()` fails before adopting rather than handing back a vault whose Locker never opens — the placebo restore FORMAT.md warns about, in its sharpest form.
- **A vault directory move must take the key files with it.** They are named `<vaultId>.locker.<keyId>.key`, so renaming the vault directory renames its key identity exactly as it does for `<vaultId>.sealkey`. Same documented gesture, same failure if it is skipped.

Rotation (which is what revoke IS) runs in a fixed order across two stores that share no transaction: write `K′` to `keys/`; in ONE database transaction retire the old `locker_key` row, insert the new one, re-encrypt every secret and bump every `key_id`; then delete the old key file. A crash in either window leaves both files on disk and the database as the sole authority on which is live, and `sweepRetiredLockerKeys` reconciles them at the next open. Ciphertext is never under two keys, and `locker_key_live_idx` makes "two live keys" unrepresentable rather than merely unlikely. The honest limit R13 states: rotation protects what comes after, not what a revoked device already read.

The recovery-kit passphrase wrap is **load-bearing key custody**, not a convenience. The kit contains the backup keyring, backed-up vault DEKs and every live Locker key file; without its password those keys remain unavailable even when the wrapped file and provider objects are both present. An UNWRAPPED kit is not accepted at all (issue #568) — accepting one also ignored the supplied password, which made possession of the plaintext file sufficient on three routes.

The **portable vault bundle** (`GET`/`POST /centraid/_vault/imports/export`) is a different artifact with the same custody rule (#630). Its canonical rows carry sealed cells as ciphertext; the vault DEK leaves only inside `custody/recovery-kit.json`, wrapped with the same scrypt→AES-256-GCM machinery as the backup kit, and only when the export is given a passphrase (`POST` with `{passphrase}` — never a query string). A bundle exported without one is `sealed: "ciphertext-only"`: still a complete, verifiable restore of everything that is not a secret, and its sealed cells are refused at import because nothing present can open them. Import takes the passphrase in the body, unwraps the key in memory, **re-seals every sealed cell under the target vault's own DEK**, and stamps the target's fingerprint — the source's stamp is never copied, which is what made a restored vault report success and then refuse to reopen. A bundle carrying the old plaintext `custody/seal-key.bin` is refused outright.

For an erase that stranded, or a restore that follows a completed erase, see [vault-erase.md](vault-erase.md) — erase destroys the vault DEK, so its recovery story is materially different from an ordinary restore.

## Symptoms

- Blank-machine `recover` stuck in `fetching` / `replaying`
- `recover` failed after partial download
- Two machines both think they are primary
- PITR / WAL replay error
- Disk full mid-restore

## Steps — restore-to-side stranded

1. **Stop** retry storms; note the job id / CLI invocation and logs ([logs.md](../logs.md)).
2. Identify `destDir` — if partial, **delete the incomplete side dir** only after confirming it is not the live vault path.
3. Free disk / fix provider credentials / network.
4. Re-run restore/recover with the same snapshot intent (`--at` / seq if used). Prefer lazy unless you need `--full`.
5. **Adopt** only when the service reports success; do not manually rename half trees into `vault/`.

## Steps — blank-machine `recover` failed mid-phase

Phases (conceptually): `discovering → fetching → replaying → fencing → adopting → warming`.

`recover` is an **offline CLI verb** — it takes `gateway.db`'s exclusive lock and refuses while the daemon runs. There is no founding UI and no `vaults:restore` route (issue #603): keep the daemon stopped for the whole sequence, and on a data dir whose `vault/` is empty do not restart it between attempts — auto-founding would create a fresh `Personal` vault and the dir would no longer be vault-free.

1. Read gateway logs and the `centraid-gateway recover` error output ([logs.md](../logs.md)).
2. If failure was before **adopting**, re-run `centraid-gateway recover --kit … --password-file … --api-key … --data-dir …`. Remove only the specifically named disposable cache/scratch path when instructed; never remove provider objects or the live vault root.
3. If failure was **during/after fencing**, treat as high risk of split-brain:
   - Do not start the old machine's gateway against the same vault without maintainer guidance.
   - Prefer completing recover on the new machine; old machine should see registration **409** / fence errors — that is success of fencing.
4. Confirm backup health metrics after adopt (inventory reconcile, seal verify).

## Steps — accidental live-tree copy / cp

1. Do not open the torn copy as production.
2. Prefer provider snapshot + `recover` / restore-to-side from last good snapshot.
3. See [traps/wal-checkpoint.md](../traps/wal-checkpoint.md).

## Steps — provider credentials lost

1. Without recovery kit + provider access, ciphertext is unrecoverable by design.
2. Rotate provider keys only via documented backup settings; update kit if the product stores grant material there.

## What not to do

- `cp -a` live `vault.db` as backup while gateway runs
- Delete remote WAL/snapshot objects to "clean up" a failed restore
- Run two gateways with the same vault id and write traffic after a partial recover

## Related

- ARCHITECTURE — restore/recover summary
- `packages/server/src/backup/recover.ts`
- `receipts/issue-439-restore-as-product.md`
