# The phone's backup

What the phone does to back its vault up and to get it back. Wording and rules a member sees: [product.md](./product.md). Code: [`crates/vault/src/backup/`](../../../crates/vault/src/backup/mod.rs) (the plane, written against one `Store` trait) and [`crates/core/src/phone/`](../../../crates/core/src/phone/mod.rs) (the doors over it and the gateway client).

## State, and where it lives

- The device state (`<stem>.state.db`) and the spool (`<stem>.spool/`) sit beside the vault file, never inside it, and so does `<stem>.scratch/`, which exists only while "Check my backup" restores into it. The shells keep them out of OS backup.
- The state and the spool are derived. Lose them and the phone re-pairs and re-asks each gateway what it holds. The backup is not lost.
- The core writes no key to disk. Keys arrive through the open configuration. A core without them reads and writes the vault but cannot back up.

## Snapshot

- The vault's pages are read through `sqlite_dbpage` on a pinned read-only connection (`pagesource::walk`, one WAL read transaction), cut into 64 KiB ranges. **No plaintext copy of the vault is written to disk.** Each range is named from its own content; a range the newest head already names, at every gateway of the pass, is not sealed; a changed one is sealed into the spool as it is read, one range in memory at a time. One manifest names them all: a **root** (the census, counters, `db_hash`) listing **leaves** of up to 1024 ranges each (`{i, name, len, d}`, `d` the BLAKE3 of each sealed chunk as it opens), so a changed range rewrites one leaf. Version 4; a v3 manifest is refused. Leaves are named from their own bytes, so a leaf the gateway already holds is not sent again and a wrong leaf is refused by name. A range the previous head named carries that head's digests; a range sealed by an earlier pass has its digests read back out of its part.
- The pin never spans a gateway call: what the last head named is asked of the gateways before the walk, what the walk sealed is asked about after it (`pagesource::live_pins()` is zero at both). The writer is never held for the walk. A vault that is not WAL, or whose build lacks `SQLITE_ENABLE_DBPAGE_VTAB`, refuses with a typed error.
- The census, `user_version`, the write counter and `quick_check` are read on the same pin. A damaged vault is refused before any manifest exists, so no head is signed over it; the pass answers `ERROR_CODE_VAULT_DAMAGED`.
- The spool's byte budget bounds a first snapshot: a range it will not admit is deferred, the manifest waits with it, and the status says "no room" when the phone's free space set that budget. `db_hash` is BLAKE3 over the pages in order; it is not equal to a hash of an online-backup copy.
- The manifest carries the write counter and a per-table row census. A vault whose counter and `user_version` match the newest snapshot, held whole at every gateway, is not walked again.
- Settle moves the head only when every range and the manifest are confirmed. It is a compare-and-set on the head this phone last set there.

## Device state

- Four tables, no key-value table: `gateway` (the pairing and what this phone knows of that gateway: epoch, head and its time, generation and writes, the blob cursor, reach, the snapshot in flight, the sample counter), `outbox` (per gateway, each name owed: range, leaf, manifest, directory or blob; sealed or waiting) `local_bytes` (where a hash's bytes are on this device, newest row per ref) and `undone` (names a member's Undo restored, kept from retention for a week). Each caches somebody else's truth. `application_id` is `CBS1`, and a state a newer build wrote is refused. A `<stem>.backup.db` found beside the vault is deleted unread.
- **Nothing is recorded as acknowledged.** An outbox row leaves when its `PUT` succeeds (`NAME_TAKEN` with the phone's own digest counts; with other bytes it never does). What a gateway holds is whatever it answers to `exists`.
- **No token is in the state.** The shell keeps `gateway-token.<vault>.<gateway>` in the device secret store and hands them to the core (`gateway_tokens`) at open; the core holds them in memory. A gateway with none is `pair_again`.
- **The blob cursor.** Each gateway has a cursor over `blob.seq`. A pass reads the claims past it a page at a time, asks `exists` about each part name, and writes an outbox row for each missing one, moving the cursor in the same transaction. An unchanged library costs one statement. A blob only lapsed entities rent leaves `lapsed` rows, looked at again each pass. The first pass of a core's life walks from the start again; so does a pass that finds a gateway's head went backwards.
- The member's rule and "Include videos" come with every `drain` request (the shell keeps them in the device secret store); a request without a rule is refused. The link (metered, charging) lasts for the pass.

## Mover and spool

- Every paired gateway is a full replica. A sealed part is written once and each gateway has a row for it; the file leaves the spool when no row names it. The wait for a silent gateway is bounded to a day, after which its rows go and its walk starts again.
- Ranges, leaves and derivatives go in bundles of up to 256 MiB, and their answers are let go in one transaction. An original goes alone. The manifest is queued after every range and goes alone.
- A part answered `DIGEST_MISMATCH` three times in a row by one gateway stops the pass to that gateway.
- A part is sealed once and the same file is re-sent on every retry. A file reaches its name by rename after fsync, so a crash leaves a whole part or a `.partial`, which opening the spool sweeps.
- Each sealed chunk has a digest: BLAKE3 of its payload as it opens (compressed bytes when the part is compressed), returned by `PartSealer` and recorded in the manifest. Read-back opens one sampled chunk and compares. Because a manifest is immutable and a part may be sealed again later, the workspace pins the `zstd` crate exactly and `contracts/crypto/chunk-digest-vectors.json` fails when zstd output moves; regenerate it only as a deliberate format change.
- The budget is the smaller of 2 GiB and a tenth of free space. One part over the whole budget is sealed alone into an empty spool, and only while 256 MiB would stay free.
- A core opens the spool once, under a lock, because opening sweeps partials.

## Retention

- Keep 7 daily, 4 weekly and 6 monthly snapshots, UTC. A period counts only if it holds a snapshot. The newest is always kept. A snapshot dated after now is judged as taken now.
- It runs after a head is set. The gateway is listed first; then the live set is worked out: every kept snapshot's root, leaves, ranges and the parts of every blob its blobs tree names, the parts of every blob the vault claims now (`content_names`), everything in the outbox, what an Undo lifted and what a snapshot in flight names. Anything listed and not live is deleted by signed delete (the gateway holds a live name for its week and frees a damaged one at once). A kept manifest that will not open stops collection for the round: doubt never deletes. The blobs tree's `d` for a part comes from the device state's `part_digests` table, recorded when the part is sealed (null for a part not yet sealed); retention forgets rows no longer live.

## The pass

- `drain` reaches every paired gateway, refuses with `VaultMoved` if one holds a later writer epoch, then takes a snapshot if one is due and moves the records. The head is set before media move.
- Media then go in interleaved rounds, one gateway at a time: prepare what it lacks (derivatives, then originals, newest first), then move it.
- A snapshot is due an hour after the newest snapshot a head named was taken, and not while a newer one is still on its way whole. It is due at once when asked, when a gateway has no head set by this phone, when its head went backwards, or when a read-back found it no longer holds its head whole. A snapshot dated more than a few minutes ahead of now does not count as recent.
- If a pass confirmed files whose rows no snapshot covers, it takes another snapshot (or owes one to the next pass).
- Read-back (E10, B13): before it writes, each pass draws 64 sealed chunks (8 of at most 1 MiB on a metered link) from the head manifest's ranges and its blobs tree (parts whose digests are known), keyed by `sample_key` from `K_backup`, the gateway row's counter and the draw number, never a clock; it stops at 64 MiB read. Each chunk is read by `Range` (the part's 30-byte header, then the one frame), opened and compared with the recorded digest. The library is no longer walked again from its start once a life: a lost original is found by this sample, which resets the cursor for that repair only. A part found wrong that the gateway does not already call damaged is sent to the gateway as a signed **check this name** (decision 34; at most one pass's sample size per gateway per pass): `damaged` joins the signed delete that frees it at once, `missing` is found by the walk's `exists`, and `intact` means the read-back and the gateway disagree, so nothing is deleted, the part counts as unverified and is read again next pass.
- Originals only the OS library holds are named in `need_bytes` (at most 64). The shell streams them through the stage door, which seals them.
- What may be sealed and moved under each rule is `Conditions` in [`drain.rs`](../../../crates/core/src/phone/drain.rs). The rule itself is in product.md.
- On iOS `handoff` gives queued parts to the OS and `settle` records its report. A handoff unsettled for 25 hours that the gateway does not hold returns to the outbox.

## Restore

- Fetch the manifest by the head's name, then the ranges 1000 names a fetch. Each part must open and its name must derive from its bytes. Write at `i x 64 KiB`, truncate to `db_len`.
- Then check `db_hash`, `integrity_check`, page size, `user_version` and the census table by table. The file is built as `.partial` and renamed only when all pass.
- The phone core derives vault ids by index and asks a gateway for a read grant for each. It stops after 20 misses. Every vault is checked before any writer epoch moves. Then each is claimed at epoch plus one, naming the head it checked.
- A claim that fails is reported unclaimed. A claimed vault is never dropped. The old phone's next write is `MOVED` and it freezes.
- A vault already on this phone is replaced, unless its copy is newer. Then it is left and reported unclaimed.
- If the newest snapshot will not open and an older one does, the older one is offered and nothing is claimed until the member agrees.
- Derivatives return in `fetch` bundles. Originals stay on the gateway until `fetch_original`.

## Drill and check

- `backup::drill::run` backs a vault up to a `MemoryStore`, destroys everything on the device, restores, and proves the census, `db_hash` and a row-for-row dump match. The `restore-drill` gate step runs it in every profile except `mobile-jvm`, with a second drill that runs the core against a real gateway: [`vault`](../../../crates/vault/tests/restore_drill.rs), [`centraid`](../../../crates/centraid/tests/restore_drill.rs).
- "Check my backup" (`phone/check.rs`) restores each reachable gateway's records into a scratch copy, confirms every file by name, and opens a sample (at most 40 files of 8 MiB, 128 MiB in all). It needs the vault's size plus a tenth plus 64 MiB free.
- A file a check finds missing or damaged is unconfirmed, so the next pass sends it again. That is the only thing a check writes.
