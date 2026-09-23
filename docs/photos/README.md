# Photos documentation

This directory is the current-state register for the Photos application. Each file serves a different reader moment, so the directory is clustered rather than merged into one long document.

| Document | Current contract |
| --- | --- |
| [Derived ledger](derived-ledger.md) | Model-derived rows, provenance, consent, sqlite-vec loading, Memories, and face deletion |
| [Places](places.md) | Member-named locations, one shared projection, geometry, and the no-basemap boundary |
| [Dogfood](dogfood.md) | The real-library discovery ritual, release cadence, and known regression classes |
| [Switcher walkthrough](switcher-walkthrough.md) | The day-one Google Photos refugee journey and the shipped/partial boundaries it exercises |

## The phone viewer's layout

The phone viewer is **image first**: the stage runs the full window, so a photograph is aspect-fitted and centred in the whole viewport, and every control floats on top of it — three plates at the head (close · capture stamp · more), and one foot overlay carrying the status line, a refused write's sentence, a video's transport, the 58pt filmstrip, the previous/next chevrons and the verb row (Send a copy · Favorite · Info · Edit · Archive · Trash), with the write refusal on its own line under the row (`PhotoLightboxView.swift`, `PhotoLightboxScreen.kt`). The refusal is one rung, `PhotoLightboxMachine.writeRefusal`: a photograph with no vault row says it is not in a vault yet. The read-only rung v0 carried is not duplicated there — the one read-only vault left is one that moved to the member's other phone, and `ScreenRuntime`'s `readOnly` supplier answers that at the moment of the write ([#1014](https://github.com/srikanth235/centraid/issues/1014), [#1029](https://github.com/srikanth235/centraid/issues/1029)). A **single tap on the photograph puts the chrome away and another brings it back**; `chrome_visible` is reduced state, the viewer opens with it drawn, and it never hides while a screen reader is running or during the slideshow, whose one way out is Leave. The editor is its own screen pushed over the viewer, not a mode of it. There is no standing gesture-teaching sentence — the status line draws only when it has something true to say (a receipt for what the member just did, where the original is and an offer to load it, a video whose file is not here), and swipe keeps its pointer equivalent in the chevrons rather than a label.

## Where a grid cell's photograph comes from

**A cell's `thumbnail_path` is in its own row.** The grid's page read asks the door for `with_held_thumbnail` and the door appends the column, resolved against the seat's `seat_blob_held` table — one row per whole blob this device holds, written by the byte pass and rebuilt from the byte store at every core open ([D-1025-S7-20](../decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025)). The thumbnail TIER wins (`thumb`, then `poster`) and the ORIGINAL is the fallback, which is the case for every library seeded from originals.

There is no per-screenful `content_urls` trip any more. There was exactly one, in Home's four-cell mosaic, and the grid made none — so a device that had synced nineteen photographs drew nineteen placeholders while the launcher tile drew four of the same photographs correctly. `content_urls` itself stands, for the viewer and the doc surfaces that ask for one item at a time.

**A path is only ever handed out for bytes a surface may embed.** The byte door refuses to call `image/svg+xml` embeddable — a renderer executes it in the embedding page's origin — and a video's ORIGINAL is not a frame; both refusals are decided in `crates/seat` where the path is produced and stored as one `drawable` column, so the read filters on a column and cannot spell the media-type question at all. A cell with no path draws one of the two honest empty sentences.

## What a cell says this device has

**Five states, one closed enum, derived in the read** ([D-1025-S7-62](../decisions.md#slice-s4s5--the-members-transfer-rule-and-fetch-this-one-now-1025)). "A path present means held" was true for one slice and could not tell three different things apart — a photograph still on its way, one the member's own rule is holding back, and a device that has nothing of it — so all three drew the same placeholder and the download arrow had nowhere to go.

| `PhotoCell.Held` | what it means | what the cell draws |
| --- | --- | --- |
| `HELD_ORIGINAL` | the full-size file is on this device | the thumbnail, nothing over it |
| `HELD_THUMBNAIL_ONLY` | a thumbnail is here; nothing is holding the original back | the thumbnail, nothing over it |
| `HELD_FETCHING` | the member tapped it and the bytes are moving | a spinner |
| `HELD_WITHHELD_BY_RULE` | the member's own transfer rule is why the original is not here | **the download arrow** |
| `HELD_ABSENT` | nothing of this photograph has reached this device | an empty-cell sentence |

The read is given two more computed columns beside `thumbnail_path`: `original_hash` (what a tap names) and `original_held`. **`original_held` is its own column and is never inferred from the path**, because `thumbnail_path` falls back to the ORIGINAL's hash on a vault with no derivative rows — so a path means the original on some libraries and a `thumb` on others, and a cell that guessed would tell a member their full-size photograph is here whenever a thumbnail was. An empty `original_hash` draws no arrow: an affordance nothing can serve is worse than none.

`HELD_FETCHING` is the reducer's and never the read's — a tap is not a fact a page read can see — and it is the only in-place cell patch the grid makes, which is safe because a held state is not an order column.

**Tapping the arrow is `seat.bytes.fetch`** ([D-1025-S7-63](../decisions.md#slice-s4s5--the-members-transfer-rule-and-fetch-this-one-now-1025)): `seat.sync` with a one-item window that suspends the tier rules for that one blob. It lands `seat_blob_held` like any other byte, so the cell redraws through the ordinary `RowsChanged` below — there is no second path for a byte to become a row. It refuses by code (`notPaired`, `alreadyHeld`, `nothingWanted`) and an unreachable gateway is not a refusal at all: the window runs, does what it can, and reports it.

**A blob landing is a row change on the asset that owns it** ([D-1025-S7-21](../decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025)): the seat joins the completed hash through to `media_asset.asset_id` and the core emits an ordinary `RowsChanged`, so the grid and Home refresh through the path they already had. The separate `BytesArrived` event is deleted; it existed only because the ids the core had were content ids and matched nothing a screen was showing.

**Both shells draw the same view.** The grid and Home's mosaic both render `ContentImage(path)` ([D-1025-S7-22](../decisions.md#slice-s7--one-loop-one-file-one-page-one-report-1025)). The grid used to draw an SF Symbol on iOS and a text label on Android even when a path was present, which is why the defect was first reported as an empty grid rather than as a grid that was not drawing.

## Derivatives

**The gateway makes them, at commit, and they travel as rows** ([D-1025-S7-50](../decisions.md#slice-s3--derivatives-at-the-gateway-1025)). Every door that commits an image — `media.add_asset`, `core.add_document`, the link doors, a desktop import, the demo seeder — goes through one choke point in `crates/vault`, and that point writes the tiers in the same commit as the original. A seat generates nothing: a derivative is a gateway-derived fact and reaches every replica as ordinary `core_content_derivative` log rows, which is why `needed_blobs`, the planner's tier ladder and `held_thumbnail` needed no change to start seeing them.

| variant | long edge | format | notes |
| --- | --- | --- | --- |
| `thumb` | 360 px | JPEG q80 | the grid cell; the first tier the planner fetches, over any link |
| `preview` | 2048 px | JPEG q80 | a full-screen view without the original's weight |
| `poster` | — | — | **not produced in this build**; a video cell falls back and keeps its badge |

Aspect ratio is preserved — the long edge is the bound, so a 4000×3000 original gives a 360×270 thumb and a portrait one gives 270×360. A source already smaller than the edge is re-encoded at its own size rather than skipped: a tier that is missing because the camera happened to be small would make the planner's first pass depend on the camera.

**Upright, and stripped** ([D-1025-S7-51](../decisions.md#slice-s3--derivatives-at-the-gateway-1025)). The EXIF/`eXIf` orientation tag is read off the decoder and applied to the pixels _before_ scaling, so a photograph shot with the camera turned is not a sideways thumbnail. Nothing else survives: a derivative is re-encoded from decoded pixels, so EXIF, XMP and ICC are gone by construction. That is a privacy property — `thumb` is the rendition that travels first, to every admitted device, ahead of any rule about originals, and one carrying the GPS of a member's home is worse than no thumbnail.

**A failure costs nothing.** Bytes that do not decode — an unsupported format, a corrupt or truncated file — produce no derivative rows and a `warn`. The original still commits, and the grid cell still draws, because `held_thumbnail` falls back `thumb` → `poster` → the original's own hash.

**Deferred, by name, not by omission** ([D-1025-S7-52](../decisions.md#slice-s3--derivatives-at-the-gateway-1025)): video posters (a frame extractor is a native dependency the gateway does not carry) and HEIC/HEIF decoding (the recommendation is the phone transcoding to JPEG at upload, where the hardware decoder already is, rather than a `libheif` binding on the gateway). Both are owner questions on [#1025](https://github.com/srikanth235/centraid/issues/1025).

**An older vault gains its tiers by a sweep, not a migration** ([D-1025-S7-53](../decisions.md#slice-s3--derivatives-at-the-gateway-1025)). `media.derive_missing` runs once at gateway start, bounded at 200 items, resumable and idempotent; it writes ordinary log rows a tailing seat receives like any other commit.

**No dimensions are stored on the row** ([D-1025-S7-54](../decisions.md#slice-s3--derivatives-at-the-gateway-1025)). `core_content_derivative` has no width or height column and this slice adds none — nothing reads them, and the DDL is unchanged.

## The app's screens, and where v0's fourteen routes went

The mobile shell is SwiftUI and Compose over one Kotlin state machine per screen ([#1020](https://github.com/srikanth235/centraid/issues/1020) D-1020-E3). v0's React Native Photos declared **fourteen routes** in `PhotosStackParamList`; this shell declares **eleven screens** — ten for those fourteen routes, the four that collapsed doing so under the band doctrine (_a destination is a parameter, not a screen_) read one step further than wave 3 read it, and the editor, which v0 drew as a mode of the viewer.

| v0 route | here | why |
| --- | --- | --- |
| `PhotosHome`, `PhotosLibrary` | `photos.grid` | the library band; `PhotosLibrary` was the same rows one push deeper |
| `PhotoStateView` (favorites, archive, trash, videos, person) | `photos.shelf` |  |
| `AlbumDetail` | `photos.shelf` | **the library under a predicate.** One page of `media_asset` in `captured_at DESC`, one `PhotoCell`, one held state, one download arrow. v0 wrote four and they drifted: only `AlbumDetail` grew a selection mode, only `PhotoStateView`'s trash a purge countdown, and `PlaceDetail` had an empty sentence of its own |
| `PlaceDetail` | `photos.shelf` |  |
| (a memory's members) | `photos.shelf` |  |
| `PhotoLightbox` | `photos.lightbox` | one asset, not a page: its content is a detail, it owns chrome visibility, and its events are verbs |
| (the viewer's edit mode) | `photos.editor` | a route pushed over the lightbox, not v0's in-place mode: it owns a screen machine, and the lightbox stays mounted under it so Cancel lands on the same photograph. A save is a **new** photograph that keeps the original's date, place and caption ([R-1029-PH-5](../decisions.md#photos-what-the-port-builds-and-what-it-does-not-1029)) |
| `PlacesView`, `PlacesMap` | `photos.places` | one read, two draws. Cards or map is a `Presentation` parameter, so moving between them is not a push and back does not walk through the presentations a member happened to tap |
| `PhotosPeople` | `photos.people` | confirmed identities — a list of answers |
| `FaceReview` | `photos.faces` | a queue of questions, worked one at a time. Its state is a cursor and a verdict, not a page |
| `DuplicatesShelf` | `photos.duplicates` | listing clusters |
| `DuplicateReview` | `photos.duplicate` | choosing within one. Two screens, because they are two jobs with two writes |
| `PhotosMemories` | `photos.memories` | computed memories; their members are a shelf |
| `PhotoPicker` | `photos.picker` | **not a shelf in selection mode.** The picked set is the picker's own and the album is a route param; a shelf that could be picked from would carry an album id on every surface that shows one |
| (the Collections band) | `photos.collections` | a list of shelves, not of assets |
| (the Search band) | `photos.search` | a query, its hits, and a resting state that is neither |

The state and event messages are `centraid.screen.v1`, in the section _Photos: the rest of the miniapp_ of [`screen.proto`](../../crates/api-proto/proto/centraid/screen/v1/screen.proto), whose comments carry the reasoning per field. Destinations are Kotlin and never cross the ABI ([`Navigation.kt`](../../mobile/shared/src/commonMain/kotlin/dev/centraid/shared/nav/Navigation.kt)): where a member is standing is the shell's own business.

**One cell renderer serves every surface that draws photographs** — `PhotoCells.swift` and `kit/PhotoCells.kt`. The library grid, a shelf, the picker and search hits all draw the same `PhotoCell` from the same page read, so the tile, the two empty-cell sentences, the held overlay and the download arrow are written once. The library packs its tiles into justified rows from each photograph's own `width`/`height` (v0's `justify.ts`) — `PhotoTile`, with the same overlays as the square the other surfaces draw — and its day grouping comes from `PhotoCell.day`, derived once in `PhotosReads` so the two shells cannot file one photograph under two dates. The library's grains, rail, menu and selection are `PhotosGridState`; their layout is `PhotosLibraryView.swift` and `PhotosLibraryTimeline.kt`. v0 had four and they disagreed; its picker's cells never showed held state at all, so a member could pick a photograph this device did not have.

## What these screens cannot answer, and why

Porting the miniapp surfaced a set of gaps between what a screen wants to show and what the read door can produce. They are recorded here rather than papered over, because in every case the shell's alternative was to fabricate a number or a boolean that a member would read as a fact.

**The read door has no join and no `COUNT(*)`.** `PageQuery` names one table, real columns only, with computed columns (`with_held_thumbnail`, `with_document_size`) appended by the door. So:

- **Every count is a floor.** `ShelfRow.item_count`, `CollectionsDoor.count`, `PersonRow.photo_count`, `DuplicateCluster.member_count`, `PlaceRow.asset_count` and `PlacesData.unplaced_count` are counted from the rows one page returned, and each carries a `_capped` sibling saying so. A capped count renders "at least 84", following `HomeState.ThingCount`. `needs_attention` deliberately has no such flag: a badge means "there is work", and a floor and a total draw the same dot.
- **A screen that needs two tables runs two reads**, through [`HomeSession.attachReads`](../../mobile/shared/src/commonMain/kotlin/dev/centraid/shared/shell/HomeSession.kt) — which is `attachScreen` without `changes.route`, because routing is registration with no removal and a second route would multiply every sync re-read. Which of the two shapes a screen takes is ruled on there: a second read that ENRICHES rows the first produced amends through its own event arm; a screen whose data case cannot be CONSTRUCTED from one table folds in its bridge and sends one event, as `HomeRuntime` does. A `content` oneof cannot hold `loading` and `data` at once — Wire throws — so there is no third option.
- **`with_held_thumbnail` is refused AT PREPARE over a table with no `content_id`**, taking the whole read down rather than answering nulls. That is why `media_face_region` and `media_asset_phash` cannot ask for a thumbnail, and why `FaceReviewEvent.ThumbnailsArrived` and `DuplicateCluster.member_asset_ids` exist.

**Two things the vault cannot yet tell a shell.** Each is a core-side gap, not a shell one:

| gap | what the screen does instead |
| --- | --- |
| **Nothing computes memories.** `derived-ledger.md` states it: "No command in `crates/` writes the projection." | `PhotosMemoriesData.computed` is derived conservatively, so an empty shelf always reads _"Centraid has not looked for memories yet"_ and never _"there are none"_ |
| **Nothing records the duplicate pass's progress** — no watermark, cursor or sweep-state row | `DuplicatesData.scan_complete` is false on every read this build can make. "Centraid has not finished looking" is true; "your library is clean" would be a claim nobody checked |

**Two more, smaller.** `DuplicateMember.byte_size` needs `content_id` on the wire to attribute a size leg's rows to a member, so the suggestion currently ranks by pixels and `suggestion_reason` says so. `PlaceRow.name` is the raw column, not `place_phrase`'s ladder — rungs 2 and 3 need a gazetteer parse and a home anchor that a reducer must not do, so a gazetteer-named place reads as unnamed on the phone; the fix is a phrase on the door.

**How the lightbox reaches the original.** No `ScreenEffect` carries a byte-door request, so `PhotoDetail.original_path` is not a page read: the lightbox's content leg brings the original's `content_id`, and `PhotoLightboxBridge.locate` asks `api::content_urls` for it (owner `media.asset`) once the photograph is `HELD_ORIGINAL`, landing the path, `embeddable` and media type as `OriginalLocated`. The stage draws the original only when `embeddable`; "Send a copy" and "Download" read the same path. An original this device does not hold stays unlocated, and fetching one is still the unserved hop `ScreenEffect.FetchOriginal`'s own comment documents.

**Naming a new person in face review is one step.** `core.add_party` mints the `party_id` and answers it in `CommandOutcome.output`; `FaceReviewBridge` reads it there and hands it back as `FaceReviewEvent.PersonCreated`, and the confirm follows. The picker stays open until then, so a failed create loses nothing — v0 created the party first and lost the answer when the create failed. **Skip writes nothing** (v0's `triageSkip`): the face moves to the back of the queue; "Keep unnamed" is the `dismiss` answer.

**Search reaches people, places, albums, labels and captions** (v0's `search-hits.ts`). `PhotosSearchBridge` runs the legs — confirmed parties, every place (matched on its name, its gazetteer name and the home band), albums and tagged concepts, each with a count — and one `media_asset` page whose predicate reaches all of them through `IN (SELECT …)`. The people, places and albums a query names stand above the grid as `SearchTopHit`s, three of each, each opening its shelf; the resting page is the vault's own vocabulary. `crates/search`'s FTS index is still unreachable (no search arm on `Request`), so a caption is matched with `LIKE`.

**One thing that is a decision, not a gap.** Photos' Backup row in the More sheet deep-linked, in v0, to the frame's `Settings → BackupHealth`, keeping a link rather than a copy because that policy governs Docs' scans and Notes' attachments too. This shell has no frame Settings — `Destination.Settings` is declared and nothing renders it — so the row opens `SHEET_BACKUP_DETAIL` and reports this device's own pass. The deep link returns when the frame screen does.

## Keeping originals, and freeing space

**An album can be kept on this phone** (v0's "Keep originals on device"). The album shelf draws a switch — "Keep originals on this phone" — whose line says what it does: "Kept out of Free up space" or "Included in Free up space", and "Checking this album's originals" until the keep list has answered for that album, when the switch is disabled. The list is the core's `originals` request ([`originals.proto`](../../crates/api-proto/proto/centraid/core/v1/originals.proto)) and lives beside the vault file as `<stem>.keep-originals.json`, not in the vault — "on this phone" is a fact about one disk ([R-1029-PH-2](../decisions.md#photos-kept-originals-and-freeing-space-1029)). A flip shows at once and holds the switch still until the list confirms it; an answer that lands after the member moved to another album settles nothing there. A list that will not parse is refused, never read as empty, and the row says so.

**"Free up space" is a statement, not a button** ([R-1029-PH-1](../decisions.md#photos-kept-originals-and-freeing-space-1029)). The More sheet counts, each time it opens, the originals whole on this phone — live photographs only; the trash has its own purge — with their size and the share in kept albums (`originals::census`, one listing of the content store and one read of the rows), and says why none can be freed: the laptop's backup holds the vault's rows and no original ([Q-1029-10](../decisions.md#open-questions-for-the-owner-1029)), so each original here is the only copy. "Not counted yet" is a core with no content store, never a zero. There is no release verb and no `freeable` total anywhere, and the Download arrow's `ScreenEffect.FetchOriginal` stays unserved for the same reason — there is nothing on the gateway to bring back.

## The app's shape

Photos is the largest app in the product. It lives in [`crates/apps/photos`](../../crates/apps/photos/README.md): the read plane and the action table, with the writes in `crates/vault`'s `media` schema and the bytes in [`crates/media`](../../crates/media/README.md). Four facts the documents above do not carry:

- **Places stays inside Photos.** There is no separate Places app crate and there should not be one: the phrase logic is the load-bearing half, a location is a phrase before it is a pin, and in a **shared** context the relative rung is skipped because "5.2 km NW of Home" hands a stranger a bearing to the member's house. `printable_name` refuses a coordinate-shaped name at every rung ([D-1020-P5](../decisions.md#wave-4-lane-rulings-1020)).
- **The library walks the whole library as the member scrolls, in two walks** ([#1029](https://github.com/srikanth235/centraid/issues/1029), superseding D-1020-DC10's one-page clause in [decisions.md](../decisions.md#supersessions-closed-by-1029)). The sort column is nullable and a keyset continued over a NULL drops rows silently, so the first walk is every dated row (`captured_at IS NOT NULL`, newest first) and the second is the undated tail keyed on `asset_id` alone — v0's "Undated" section, after every dated photograph. `PhotosGridMachine` keeps **one page read in flight**, because `DataArrived` cannot say which request it answers; a write, a sync or a return to the band re-reads every page already scrolled into `restage` and swaps it in whole, so the grid neither blanks nor loses its place. The Favorites filter is a different statement (the favourites shelf's `STARRED` predicate), read from its first page.
- **Recognition placement is a fourth tier value, not a re-meaning** — `off < on-device < sealed-gateway < gateway`, with a stored `device` read forward as `sealed-gateway` and never written back. The device half of that plan (the derivation stamp's `site` and `device_id`, the ask, the submit command) is named scope and is **not built** ([D-1020-AU3-1](../decisions.md#wave-4-lane-rulings-1020), [recognition-automations.md](../recognition-automations.md)).
- **`media.forget_person` erases the party's own faces and clears the judgements the party made.** It deletes regions on `party_id` and nulls `confirmed_by_party_id` elsewhere, so in a single-member vault "forget me" does not erase everyone's confirmed faces ([R-1020-35](../decisions.md#decisions--lane-v-1020)). It carries `confirm: true`, which parks a non-owner invocation while an owner credential — the only one a single-seat vault has — walks straight through; whether the surface should ask is an owner question in [release/v1-handoffs.md](../release/v1-handoffs.md).

The files describe current behaviour, deliberate absences, and the issue that settled each non-obvious boundary. Historical implementation sequences belong in the linked issues and receipts.

Related current-state registers: [blueprint seats](../blueprint-seats.md), [recognition automations](../recognition-automations.md), and [design machinery](../design-machinery.md).
