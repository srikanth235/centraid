# Mobile offline data

Centraid's native Photos and Docs surfaces are vault-free views: they read one device-local projection assembled from every enrolled vault on the current gateway. A focused vault is only the default write target. It is not a read filter and switching it does not tear down or reopen the read plane.

## Mounted read plane

The phone keeps one replica SQLite file per vault and mounts at most four into one read-only op-sqlite connection with `ATTACH DATABASE`. Each result carries its source vault, source label, and whether the current owner may write there. Content rows with the same SHA are displayed once with all source badges. Search runs the same bounded FTS query in every attached database, then merges ranked results locally.

SHA dedupe never separates authority from identity. The canonical row retains one source vault and that source's item id as a pair; a writable source wins when the same bytes also exist in a read-only source. Other sources are badges, not candidate write targets. Favorite/star/archive/trash/move affordances use that canonical role and degrade together when it is read-only; Add may still copy a readable item into another writable target.

The four-scope cap is deliberate. It bounds file descriptors, query fan-out, radio fan-out, and frame work for the 10-year/50k-item performance envelope. The gateway exposes additional enrolled scopes, but the active vault and the first three remaining scopes in stable registry order are the mounted set.

## Bootstrap and freshness

Bootstrap asks for newest items first. Page one is committed as a crash-safe partial preview so the grid can paint while the canonical walk continues. The complete walk still commits at page one's cursor and replays the change log from there; this closes insert/delete holes created by reading different pages from different SQLite snapshots.

Pairing can grant several vaults through one short-lived ticket. The gateway redeems that ticket atomically, while the phone records one `VaultLink` and one replica lifecycle per returned vault. The first grant is only the initial focus; all other granted vaults remain independently mountable and retain their own cursor, freshness, intent outbox, and revocation state.

## Replica correctness and durability

The replica wire has four invariants that every client observes:

- A canonical SQLite write transaction gets one `commitId`. Delta pages extend through the end of that commit group, so a page boundary never exposes half of one transaction. Retention cutoffs use the same boundary rule.
- Projected changes carry the row's canonical `rowVersion` when it is nonzero; an omitted version means version zero. Local application ignores an older upsert or delete when a newer version is already stored, which makes overlapping bootstrap convergence and reconnect replay safe.
- Offline intents may carry `baseVersions`. The gateway compares those preconditions before dispatch, returns a structured conflict with expected and actual versions, and the client removes the optimistic overlay while retaining the conflict outcome for the activity/attention surface.
- `coverage` and `durability` are explicit status/result fields. A partial preview is readable and searchable, but it is labeled partial and is never treated as a completed cold start; a memory fallback is labeled non-durable and cannot create a remembered replica identity.

The browser intent store upgrades additively to its outcome journal: pending IndexedDB intents are preserved while the journal is added. Native SQLite uses the same settle-then-scrub contract. Settled outcomes retain status, reason, conflict details, and settlement time, but never the sensitive queued input. Foreground and background catch-up follow `hasMore` with a bounded sequential loop; an interrupted loop resumes from the last committed cursor.

One gateway SSE connection multiplexes independent vault cursors. A frame never combines cursors or data across vaults. Foreground UI reports human states (`Offline on this phone`, `Gateway asleep`, `Syncing recent changes`, and `Updated …`) plus a timestamp for every source. Revocation produces a scoped tombstone: the local cursor and rows for that source are purged without affecting other mounted vaults.

Freshness is stored independently per `(gateway, vault)` and advances only after that source successfully pulls or produces a cursor frame. Offline startup restores those values rather than stamping every source with launch time. Scoped revocation detaches the mounted database, purges that replica's rows/intents and cross-scope placement work, removes its pinned thumbnail pack, and deletes only that scope from the cached mount/freshness manifests.

The aggregate multi-vault cursor is conservative: it is the minimum sequence across every mounted source, including a source that has no completed bootstrap yet. Any missing or partial source therefore keeps the aggregate result partial instead of allowing a fast source to make the mounted read plane look complete.

Mobile reads `/centraid/_gateway/info` before constructing either foreground or background sessions. Both `multiVaultReplica` and `crossVaultPlacements` must be advertised. Missing flags produce one update wall instead of repeated multiplex/placement 404s; a successful judgment is cached for later offline cold starts.

## Offline changes and cross-vault placement

Ordinary writes stay in each replica's durable intent outbox. Add/Move uses a separate device outbox keyed by a durable link token. Reconciliation always:

1. commits or confirms the target projection;
2. records that target receipt in the gateway database;
3. for Move only, deletes the source item; and
4. records completion.

Replay is idempotent. A crash can leave a completed target and pending source removal, but cannot delete the source before the target exists. Queued changes may be cancelled. Permission denial, terminal failure, and parked retries remain visible until dismissed.

## Background work and push privacy

The Expo background task maps to BGTaskScheduler on iOS and WorkManager on Android. It runs the same pull, intent, placement, and upload queues as the foreground and calls the same metered/battery upload policy. Platform timing is opportunistic; correctness always comes from the durable outboxes and the next foreground pull.

The focused write target is ordered before the other cached scopes before the four-scope cap is applied. Upload rows persist that target vault, and headless reconciliation keeps the corresponding mounted sessions alive through canonical follow-up replay; transferred bytes therefore cannot settle without their app mutation merely because the app was backgrounded.

The gateway push relay is wake-only. Its payload contains no vault id, item id, title, content, cursor, or owner data. Push delivery can make a background pull happen earlier, but loss or throttling cannot lose data. iOS background push is therefore treated as an optimization, in line with Expo's delivery guidance.

## Thumbnail packs and budgets

Each source gets a pinned thumbnail pack containing the recent 90 days plus favorites, with an independent 128 MiB budget and oldest-first eviction. Displayed rows prefer those local pixels. One source cannot evict another source's offline pack. The Phone storage screen reports, per vault:

- replica database bytes;
- pinned thumbnail bytes; and
- pending upload bytes.

Database bytes mean the complete live SQLite family: the main file plus WAL, SHM, or rollback-journal sidecars. Pending bytes come from each upload row's durable target vault, never from whichever Space happens to be focused when the screen opens. Legacy pre-target rows are reported honestly as unassigned instead of being fabricated into a vault total. Tapping a vault total expands its database, thumbnail, and pending-upload components.

`Free thumbnail cache` removes only reproducible thumbnails. Replica rows and pending changes are not cache and are never removed by that action.

Low disk fails closed and preserves the last readable projection. op-sqlite's `SQLITE_FULL`/errcode 13 and OS `ENOSPC` variants are normalized into one actionable screen error: sync pauses, replica rows and pending intents remain untouched, and the person can free the reproducible thumbnail cache or other phone storage before retrying. Centraid never evicts canonical replica rows or queued writes to manufacture free space. The device contract test pins that classification and copy; the vault custody test fault-injects the same SQLite-full condition during `wal_checkpoint(TRUNCATE)` and requires the gateway disk-health tracker to turn red.

## Durable path and at-rest decision

Replica databases, pending intents, upload queues, and thumbnail packs live in a native module-owned durable directory:

- iOS: `Application Support/CentraidReplica`, excluded from iCloud backup and protected with `completeUntilFirstUserAuthentication`;
- Android: credential-encrypted `noBackupFilesDir/CentraidReplica`, excluded from Auto Backup and device-to-device backup.

These files survive OS cache eviction and disappear on uninstall. Centraid does not add SQLCipher or field encryption to the local projection in this version. That decision preserves one attached SQLite/FTS read plane and the cold/search budgets, while relying on iOS Data Protection and Android credential encryption for at-rest protection. The projection is consent-minimal, backup-excluded, and contains no blob originals; a future stronger app-layer scheme must preserve cross-database search and publish measured cold/search costs before replacing this decision.

An optional biometric app lock adds a user-presence layer before this read plane is mounted. Its gate is stored with SecureStore `requireAuthentication`; moving the app out of the foreground clears the decrypted credential cache, unmounts replica sessions, and paints an opaque switcher mask. This complements the OS at-rest controls above—it does not turn the replica into an independently encrypted database.

Locker is stricter than the ordinary replica plane. Its native cover performs authentication and reveal through online-only app queries. Passphrases, biometric device secrets, memory-session tokens, one-shot item permits, and revealed fields never enter replica rows or durable intents. The local biometric secret is random, device-only SecureStore material; only a vault-key-peppered verifier reaches the gateway database.

## Performance guardrails

The checked 50,000-row fixture spans 2016–2025 across four mounted household sources. On the 2026-07-29 development host it measured a 562.6 ms cold merged/sorted read, a 1.5 ms federated FTS lookup, and 22,188,032 projection bytes. At that observed density the 5,000-row bootstrap window is 2,218,804 bytes. The same evidence lane encodes twelve reproducible 256px/82%-quality thumbnail samples: the 13,726-byte p95 projects a 12,820,084-byte recent-90-day plus 5%-favorite pack for each 12,500-item source, within its 128 MiB ceiling. The lane enforces the 1,000 ms, 100 ms, 4 MiB bootstrap-page, and 128 MiB thumbnail ceilings. Native build/install/launch checks prove the new modules load on both platforms; the committed mobile journey lane remains the owner of React-frame, airplane-mode, and reconnect-drain evidence.

### Where 50,000 rows came from, and where it stops (#659)

50,000 is a measured fixture, not a product ceiling. A household that keeps a phone camera for a decade plausibly reaches 90,000 items by year three of using Centraid, so the envelope has to say what happens there rather than imply the number cannot be exceeded.

Scaling the 2026-07-29 measurement linearly — a projection from that run, **not** a new measurement — a 90,000-row set is about 39.9 MB of projection across four sources and about 1,013 ms of cold merged read. That is over the 1,000 ms ceiling, and it was over it for a structural reason: the mounted reader answered every request by selecting every row of the entity from every attached source, parsing each payload in JavaScript, and only then applying the caller's filters and limit. Cost tracked the size of the library instead of the size of the answer.

Since #659 the reader pushes the read grammar's filters, and the caller's limit where truncation is provably safe, into the attached SQLite databases, and runs the statement off the JS thread. What that changes about this envelope:

- **A bounded read costs what it returns.** The 5,000-row bootstrap window, a filtered lookup, and a keyed fetch no longer scale with the projection, so they hold at 90,000 rows and beyond.
- **An unbounded read still costs the whole entity.** Photos deliberately reads its full asset set to merge the camera roll against it. That path scales linearly and is the one that leaves the 1,000 ms budget somewhere between 50,000 and 90,000 rows on the reference host.
- **The limit is not pushed for content-hashed entities across several sources.** Equal bytes in two vaults collapse into one row carrying both source badges, and a per-source page could drop the duplicate that supplies a badge. Those entities read in full by design; the cheaper path is not worth a missing badge.

The honest ceiling today is therefore: **bounded reads are unbounded in library size; the full-projection Photos read is measured to 50,000 rows and projected to leave budget near 90,000.** Closing that gap means giving the timeline a windowed read rather than raising the number here. Storage scales without a cliff — projection bytes are linear, and the per-source 128 MiB thumbnail budget is unchanged because the pack is a 90-day-plus-favorites window, not a fraction of the library.

- merged cold view: under 1 second after page one is locally available;
- federated local search: under 100 ms for the supported mounted set;
- scrolling: reads bounded by the query, not by the library, and no 10k truncation;
- newest-first bootstrap page: 5,000 rows;
- attached sources: 4;
- FTS results: 1,000;
- pinned thumbnails: 128 MiB per source;
- measured library: 50,000 rows; projected budget edge for a full-projection read: ~90,000 rows.

Device/simulator runs remain the release evidence for 60 fps and the end-to-end time budgets; unit tests pin query behavior, provenance dedupe, cursor convergence, and outbox durability.
