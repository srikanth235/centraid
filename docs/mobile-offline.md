# Mobile offline data

Centraid's native Photos and Docs surfaces are vault-free views: they read one
device-local projection assembled from every enrolled vault on the current
gateway. A focused vault is only the default write target. It is not a read
filter and switching it does not tear down or reopen the read plane.

## Mounted read plane

The phone keeps one replica SQLite file per vault and mounts at most four into
one read-only op-sqlite connection with `ATTACH DATABASE`. Each result carries
its source vault, source label, and whether the current member may write there.
Content rows with the same SHA are displayed once with all source badges.
Search runs the same bounded FTS query in every attached database, then merges
ranked results locally.

SHA dedupe never separates authority from identity. The canonical row retains
one source vault and that source's item id as a pair; a writable source wins
when the same bytes also exist in a read-only source. Other sources are badges,
not candidate write targets. Favorite/star/archive/trash/move affordances use
that canonical role and degrade together when it is read-only; Add may still
copy a readable item into another writable target.

The four-scope cap is deliberate. It bounds file descriptors, query fan-out,
radio fan-out, and frame work for the 10-year/50k-item performance envelope.
The gateway exposes additional enrolled scopes, but the active vault and the
first three remaining scopes in stable registry order are the mounted set.

## Bootstrap and freshness

Bootstrap asks for newest items first. Page one is committed as a crash-safe
partial preview so the grid can paint while the canonical walk continues.
The complete walk still commits at page one's cursor and replays the change log
from there; this closes insert/delete holes created by reading different pages
from different SQLite snapshots.

One gateway SSE connection multiplexes independent vault cursors. A frame never
combines cursors or data across vaults. Foreground UI reports human states
(`Offline on this phone`, `Gateway asleep`, `Syncing recent changes`, and
`Updated …`) plus a timestamp for every source. Revocation produces a scoped
tombstone: the local cursor and rows for that source are purged without
affecting other mounted vaults.

Freshness is stored independently per `(gateway, vault)` and advances only
after that source successfully pulls or produces a cursor frame. Offline
startup restores those values rather than stamping every source with launch
time. Scoped revocation detaches the mounted database, purges that replica's
rows/intents and cross-scope placement work, removes its pinned thumbnail pack,
and deletes only that scope from the cached mount/freshness manifests.

Mobile reads `/centraid/_gateway/info` before constructing either foreground or
background sessions. Both `multiVaultReplica` and `crossVaultPlacements` must be
advertised. Missing flags produce one update wall instead of repeated
multiplex/placement 404s; a successful judgment is cached for later offline
cold starts.

## Offline changes and cross-vault placement

Ordinary writes stay in each replica's durable intent outbox. Add/Move uses a
separate device outbox keyed by a durable link token. Reconciliation always:

1. commits or confirms the target projection;
2. records that target receipt in the gateway database;
3. for Move only, deletes the source item; and
4. records completion.

Replay is idempotent. A crash can leave a completed target and pending source
removal, but cannot delete the source before the target exists. Queued changes
may be cancelled. Permission denial, terminal failure, and parked retries
remain visible until dismissed.

## Background work and push privacy

The Expo background task maps to BGTaskScheduler on iOS and WorkManager on
Android. It runs the same pull, intent, placement, and upload queues as the
foreground and calls the same metered/battery upload policy. Platform timing is
opportunistic; correctness always comes from the durable outboxes and the next
foreground pull.

The focused write target is ordered before the other cached scopes before the
four-scope cap is applied. Upload rows persist that target vault, and headless
reconciliation keeps the corresponding mounted sessions alive through
canonical follow-up replay; transferred bytes therefore cannot settle without
their app mutation merely because the app was backgrounded.

The gateway push relay is wake-only. Its payload contains no vault id, item id,
title, content, cursor, or member data. Push delivery can make a background
pull happen earlier, but loss or throttling cannot lose data. iOS background
push is therefore treated as an optimization, in line with Expo's delivery
guidance.

## Thumbnail packs and budgets

Each source gets a pinned thumbnail pack containing the recent 90 days plus
favorites, with an independent 128 MiB budget and oldest-first eviction.
Displayed rows prefer those local pixels. One source cannot evict another
source's offline pack. The Phone storage screen reports, per vault:

- replica database bytes;
- pinned thumbnail bytes; and
- pending upload bytes.

Database bytes mean the complete live SQLite family: the main file plus WAL,
SHM, or rollback-journal sidecars. Pending bytes come from each upload row's
durable target vault, never from whichever Space happens to be focused when the
screen opens. Legacy pre-target rows are reported honestly as unassigned
instead of being fabricated into a vault total. Tapping a vault total expands
its database, thumbnail, and pending-upload components.

`Free thumbnail cache` removes only reproducible thumbnails. Replica rows and
pending changes are not cache and are never removed by that action.

## Durable path and at-rest decision

Replica databases, pending intents, upload queues, and thumbnail packs live in
a native module-owned durable directory:

- iOS: `Application Support/CentraidReplica`, excluded from iCloud backup and
  protected with `completeUntilFirstUserAuthentication`;
- Android: credential-encrypted `noBackupFilesDir/CentraidReplica`, excluded
  from Auto Backup and device-to-device backup.

These files survive OS cache eviction and disappear on uninstall. Centraid does
not add SQLCipher or field encryption to the local projection in this version.
That decision preserves one attached SQLite/FTS read plane and the cold/search
budgets, while relying on iOS Data Protection and Android credential encryption
for at-rest protection. The projection is consent-minimal, backup-excluded, and
contains no blob originals; a future stronger app-layer scheme must preserve
cross-database search and publish measured cold/search costs before replacing
this decision.

## Performance guardrails

The checked 50,000-row fixture spans 2016–2025 across four mounted household
sources. On the 2026-07-29 development host it measured a 562.6 ms cold
merged/sorted read, a 1.5 ms federated FTS lookup, and 22,188,032 projection
bytes. At that observed density the 5,000-row bootstrap window is 2,218,804
bytes. The same evidence lane encodes twelve reproducible 256px/82%-quality
thumbnail samples: the 13,726-byte p95 projects a 12,820,084-byte recent-90-day
plus 5%-favorite pack for each 12,500-item source, within its 128 MiB ceiling.
The lane enforces the 1,000 ms, 100 ms, 4 MiB bootstrap-page, and 128 MiB
thumbnail ceilings. Native build/install/launch checks prove the new modules
load on both platforms; the committed mobile journey lane remains the owner of
React-frame, airplane-mode, and reconnect-drain evidence.

- merged cold view: under 1 second after page one is locally available;
- federated local search: under 100 ms for the supported mounted set;
- scrolling: bounded 100k local reads feeding FlashList, no 10k truncation;
- newest-first bootstrap page: 5,000 rows;
- attached sources: 4;
- FTS results: 1,000;
- pinned thumbnails: 128 MiB per source.

Device/simulator runs remain the release evidence for 60 fps and the end-to-end
time budgets; unit tests pin query behavior, provenance dedupe, cursor
convergence, and outbox durability.
