# Photos documentation

This directory is the current-state register for the Photos application. Each file serves a different reader moment, so the directory is clustered rather than merged into one long document.

| Document | Current contract |
| --- | --- |
| [Derived ledger](derived-ledger.md) | Model-derived rows, provenance, consent, sqlite-vec loading, Memories, and face deletion |
| [Places](places.md) | Member-named locations, one shared projection, geometry, and the no-basemap boundary |
| [Dogfood](dogfood.md) | The real-library discovery ritual, release cadence, and known regression classes |
| [Switcher walkthrough](switcher-walkthrough.md) | The day-one Google Photos refugee journey and the shipped/partial boundaries it exercises |
| [Design notes](../design-divergences.md#photos--sanctioned-design-divergences) | Sanctioned copy, control, colour-role, and metric-perfect divergences (shared register) |

## The phone viewer's layout

The phone viewer is **image first**: the pager is an absolute layer running the full window, so a photograph is aspect-fitted and centred in the whole viewport (a square one is 402pt tall on a 402×874 screen) and every control floats on top of it — three plates at the head (back · capture stamp · more), the pager chevrons at the sides, and one foot overlay carrying the status plate, the 58pt filmstrip and the chip · capsule · chip action row, with the write refusal on its own plate under the row — one ladder (`viewerWriteRefusal`, shared with the `···` menu and the lightbox's `writeReason`): a photograph the seat has no vault row for yet says it is not in a vault yet — that answer comes FIRST, because `canWrite` is a property of a vault row and its absence is not a refusal — and only a row the gateway answered read-only for says the vault is read-only, which is also the only case that offers "ask its owner" as the remedy ([#1014](https://github.com/srikanth235/centraid/issues/1014)). A caption typed on a device-only photograph is merged into its queued upload's own follow-up and travels with it. Nothing is stacked in a flex column with the photograph any more: the filmstrip's `ScrollView` carries a `flexGrow: 1` of its own that a `height` does not cancel, and in the old column it absorbed half the free height into a band of black while the photograph shrank to a 313pt letterbox ([#1011](https://github.com/srikanth235/centraid/issues/1011)). A **single tap on the photograph puts the chrome away and another brings it back**; the viewer opens with it drawn, any navigation re-draws it, and it never hides while a screen reader is running or while the editor or the slideshow is the mode. There is no standing gesture-teaching sentence — the status line draws only when it has something true to say (a zoom readout, an offer to fetch the original, what a video is playing), and the gestures keep their pointer equivalents on the stage rather than a label.

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

**Upright, and stripped** ([D-1025-S7-51](../decisions.md#slice-s3--derivatives-at-the-gateway-1025)). The EXIF/`eXIf` orientation tag is read off the decoder and applied to the pixels *before* scaling, so a photograph shot with the camera turned is not a sideways thumbnail. Nothing else survives: a derivative is re-encoded from decoded pixels, so EXIF, XMP and ICC are gone by construction. That is a privacy property — `thumb` is the rendition that travels first, to every admitted device, ahead of any rule about originals, and one carrying the GPS of a member's home is worse than no thumbnail.

**A failure costs nothing.** Bytes that do not decode — an unsupported format, a corrupt or truncated file — produce no derivative rows and a `warn`. The original still commits, and the grid cell still draws, because `held_thumbnail` falls back `thumb` → `poster` → the original's own hash.

**Deferred, by name, not by omission** ([D-1025-S7-52](../decisions.md#slice-s3--derivatives-at-the-gateway-1025)): video posters (a frame extractor is a native dependency the gateway does not carry) and HEIC/HEIF decoding (the recommendation is the phone transcoding to JPEG at upload, where the hardware decoder already is, rather than a `libheif` binding on the gateway). Both are owner questions on [#1025](https://github.com/srikanth235/centraid/issues/1025).

**An older vault gains its tiers by a sweep, not a migration** ([D-1025-S7-53](../decisions.md#slice-s3--derivatives-at-the-gateway-1025)). `media.derive_missing` runs once at gateway start, bounded at 200 items, resumable and idempotent; it writes ordinary log rows a tailing seat receives like any other commit.

**No dimensions are stored on the row** ([D-1025-S7-54](../decisions.md#slice-s3--derivatives-at-the-gateway-1025)). `core_content_derivative` has no width or height column and this slice adds none — nothing reads them, and the DDL is unchanged.

## The v1 port ([#1020](https://github.com/srikanth235/centraid/issues/1020))

Photos is the largest app in the product — 21,348 lines of v0 TypeScript, 8 queries, 18 actions, 38 scopes over five schemas. Its v1 half is [`crates/apps/photos`](../../crates/apps/photos/README.md): the read plane and the action table, with the writes in `crates/vault`'s `media` schema and the bytes in [`crates/media`](../../crates/media/README.md). Four facts the documents above do not carry:

- **Places stays inside Photos.** There is no `crates/apps/places` and there should not be one: the phrase logic is the load-bearing half, a location is a phrase before it is a pin, and in a **shared** context the relative rung is skipped because "5.2 km NW of Home" hands a stranger a bearing to the member's house. `printable_name` refuses a coordinate-shaped name at every rung ([D-1020-P5](../decisions.md#wave-4-lane-rulings-1020)).
- **The library takes one page and does not walk its window**, which is the opposite of the drive's answer and is deliberate: the library's sort column is nullable, so a keyset walk would silently drop every undated asset ([D-1020-D3-10](../decisions.md#wave-2-lane-rulings-1020), [D-1020-DC10](../decisions.md#wave-4-lane-rulings-1020)). An undated asset rides the end of a newest-first page, where its real instant put it.
- **Recognition placement is a fourth tier value, not a re-meaning** — `off < on-device < sealed-gateway < gateway`, with a stored `device` read forward as `sealed-gateway` and never written back. The device half of that plan (the derivation stamp's `site` and `device_id`, the ask, the submit command) is named scope and is **not built** ([D-1020-AU3-1](../decisions.md#wave-4-lane-rulings-1020), [recognition-automations.md](../recognition-automations.md)).
- **Two v0 behaviours are reproduced and filed rather than quietly fixed.** `media.forget_person` deletes on `party_id` **or** `confirmed_by_party_id`, so in a single-member vault "forget me" erases every confirmed face of everyone; and it carries `confirm: true`, which parks a non-owner invocation while an owner credential — the only one a single-seat vault has — walks straight through. Both are owner questions in [release/v1-handoffs.md](../release/v1-handoffs.md), with recommendations.

The files describe current behaviour, deliberate absences, and the issue that settled each non-obvious boundary. Historical implementation sequences belong in the linked issues and receipts.

Related current-state registers: [design divergences](../design-divergences.md), [blueprint seats](../blueprint-seats.md), [recognition automations](../recognition-automations.md), and [design machinery](../design-machinery.md).
