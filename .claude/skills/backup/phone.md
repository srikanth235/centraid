# The phone's backup

What the phone does to back its vault up and to get it back. Wording and rules a member sees: [product.md](./product.md). Code: [`crates/vault/src/backup/`](../../../crates/vault/src/backup/mod.rs) (the plane, written against one `Store` trait) and [`crates/core/src/phone/`](../../../crates/core/src/phone/mod.rs) (the doors over it and the gateway client).

## State, and where it lives

- The ledger (`<stem>.backup.db`), the spool (`<stem>.spool/`) and the scratch copy (`<stem>.scratch/`) sit beside the vault file, never inside it. The shells keep them out of OS backup.
- All three are derived. Lose them and the phone re-pairs and re-asks each gateway what it holds. The backup is not lost.
- The core writes no key to disk. Keys arrive through the open configuration. A core without them reads and writes the vault but cannot back up.

## Snapshot

- A page-identical copy of the vault (SQLite online backup) is cut into 64 KiB ranges. Each range is sealed under a name derived from its own content, and one manifest names them. An unchanged range keeps its name, so `exists` says held and nothing is sealed.
- The copy runs on its own read-only connection in steps of 128 pages. The vault is held only to read its path and size, never for the copy, and it never runs `VACUUM`.
- The scratch directory is 0700 and its file 0600. It is deleted once the last range is spooled. A core removes a crash's leftover when it opens.
- The manifest carries the write counter and a per-table row census. A vault whose counter and `user_version` match the newest snapshot, held whole at every gateway, is not copied again.
- Settle moves the head only when every range and the manifest are confirmed. It is a compare-and-set on the head this phone last set there.

## Ledger

- Six tables: `destination`, `queue`, `confirmed`, `snapshot`, `local_bytes`, `meta`. Each caches somebody else's truth. `application_id` is `CBL1`, and a ledger a newer build wrote is refused.
- A part is confirmed when its `PUT` succeeded. `NAME_TAKEN` counts, because a name is a function of the plaintext.
- `local_bytes` records where a library original already is, so the phone keeps no second copy of it.
- The first pass of a core's life asks each gateway about every confirmed name. So does a pass that finds a gateway's head went backwards. A name no longer held goes back to unconfirmed.

## Mover and spool

- Every paired gateway is a full replica. A part leaves the spool when no paired gateway still owes it. The wait for a silent one is bounded to a day.
- Small parts go in bundles of up to 256 MiB, and their answers are confirmed in one transaction. An original goes alone. The manifest is queued after every range and goes alone.
- A part answered `DIGEST_MISMATCH` three times in a row by one gateway stops the pass to that gateway.
- A part is sealed once and the same file is re-sent on every retry. A file reaches its name by rename after fsync, so a crash leaves a whole part or a `.partial`, which opening the spool sweeps.
- Each sealed chunk has a digest: BLAKE3 of its payload as it opens (compressed bytes when the part is compressed), returned by `PartSealer` and recorded in the manifest. Read-back opens one sampled chunk and compares. Because a manifest is immutable and a part may be sealed again later, the workspace pins the `zstd` crate exactly and `contracts/crypto/chunk-digest-vectors.json` fails when zstd output moves; regenerate it only as a deliberate format change.
- The budget is the smaller of 2 GiB and a tenth of free space. One part over the whole budget is sealed alone into an empty spool, and only while 256 MiB would stay free.
- A core opens the spool once, under a lock, because opening sweeps partials.

## Retention

- Keep 7 daily, 4 weekly and 6 monthly snapshots, UTC. A period counts only if it holds a snapshot. The newest is always kept. A snapshot dated after now is judged as taken now.
- It runs after a head is set, and only when retention drops at least one snapshot. A dropped snapshot's manifest and ranges are deleted at once. Any other listed name that no kept manifest, vault content hash, queued part or not-yet-acknowledged snapshot implies is held back until every kept snapshot was taken after this phone first saw it unlive.
- A file the vault deleted stays until every kept snapshot was taken after this phone first saw it unlive. While any kept snapshot is future-dated, none of that held garbage is collected.

## The pass

- `drain` reaches every paired gateway, refuses with `VaultMoved` if one holds a later writer epoch, then takes a snapshot if one is due and moves the records. The head is set before media move.
- Media then go in interleaved rounds, one gateway at a time: prepare what it lacks (derivatives, then originals, newest first), then move it.
- A snapshot is due an hour after the newest snapshot a head named was taken, and not while a newer one is still on its way whole. It is due at once when asked, when a gateway has no head set by this phone, when its head went backwards, or when it no longer holds its head whole. A snapshot dated more than a few minutes ahead of now does not count as recent.
- If a pass confirmed files whose rows no snapshot covers, it takes another snapshot (or owes one to the next pass).
- Read-back: each pass opens 3 random acknowledged parts of at most 1 MiB per gateway, and streams the large part read back least recently, off a metered link. A part that is gone or will not open is unconfirmed and sent again.
- Originals only the OS library holds are named in `need_bytes` (at most 64). The shell streams them through the stage door, which seals them.
- What may be sealed and moved under each rule is `Conditions` in [`drain.rs`](../../../crates/core/src/phone/drain.rs). The rule itself is in product.md.
- On iOS `handoff` gives queued parts to the OS and `settle` records its report. A handoff unsettled for 25 hours that the gateway does not hold returns to the queue.

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
