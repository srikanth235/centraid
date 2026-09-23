# Photos day-one switcher walkthrough (D3)

This is the current day-one script for a Google Photos refugee. Every step carries an honest shipped, partial, gap or not-in-v0 status; a gap names the current owner or reason, and a not-in-v0 step names its ruling.

Photos' north star is **iOS Photos** ([blueprint seats](../blueprint-seats.md)): when a design question has no answer, the north star's behaviour is the default answer. The walkthrough starts from Google because Takeout is a common escape hatch.

1. **Export the library from Google Takeout.**
   - Google ships a zip: media files plus a `.json` sidecar per item carrying the real capture time, geo, and description — and the only place album structure survives.
   - **Status: GAP** — this tree has no Takeout importer. v0's staged import (draft → review → publish, sidecar beats EXIF, album reconstruction, Live Photo pairing) went with the v0 TypeScript tree in [#1020](https://github.com/srikanth235/centraid/issues/1020), and the phone that is the vault ([#1029](https://github.com/srikanth235/centraid/issues/1029)) has no import surface yet.

2. **Bring the phone's own library in.**
   - The camera roll backs up on its own once photo access is granted: a keyset walk with a durable cursor per vault, idempotent on the content hash, under the member's one transfer rule ([D-1025-S7-70](../decisions.md#slice-s6--the-camera-roll-goes-up-1025) – S7-75). A denied grant draws the sentence and Open Settings; a partial one draws the limited-library picker on iOS and "Select more photos" on Android.
   - **Status: SHIPPED**. There is deliberately no first-run "bring in my camera roll" offer — the backup already does it ([R-1029-PH-4](../decisions.md#photos-what-the-port-builds-and-what-it-does-not-1029)).

3. **Open the timeline and browse.**
   - Day sections under pinned months, justified rows packed from each photograph's own aspect, a scrub rail, a skeleton while the first page reads, and paging through the whole library as the member scrolls. Photographs with no capture date live in an explicit Undated section after every dated one, never interleaved as lies ([README](README.md#the-apps-shape)). Tile size is in the library menu, and a pinch steps it on Android.
   - **Status: SHIPPED** on both shells.

4. **Find a 2019 photograph by year.**
   - The Years / Months / All grain control narrows to 2019; the scrub rail jumps.
   - **Status: SHIPPED**. The read side is exercised by `crates/apps/photos/tests/year3.rs` (the registered `year3-50k-assets` axis, and a keyset walk over tied capture times) and `crates/apps/photos/tests/parity.rs` (undated rows).

5. **Search by caption, person, place, album, label.**
   - The people, places and albums a query names stand above the grid as top hits, three of each, each opening its shelf; the matching photographs follow. The resting page, before a query, is the vault's own vocabulary. It works offline because the vault is on the phone.
   - **Status: SHIPPED** for captions, labels, people, places and albums. A caption is matched with `LIKE`: `crates/search`'s FTS index has no arm on `Request` yet ([README](README.md#what-these-screens-cannot-answer-and-why)).

6. **Search by what is _in_ the picture (semantic and text-in-photo).**
   - Type "beach sunset" and get scored matches; type a word printed inside a photograph and match it.
   - **Status: GAP** — nothing in this tree computes embeddings or runs OCR. The `enrich.*` commands and the worker behind them were deleted in [#1029](https://github.com/srikanth235/centraid/issues/1029); the derived tables remain ([derived ledger](derived-ledger.md)).

7. **Share one photograph, or a whole album.**
   - **Status: NOT IN v0** — Photos offers no sharing with another person and no "Save to my vault" ([R-1029-PH-3](../decisions.md#photos-what-the-port-builds-and-what-it-does-not-1029)). What ships is **Send a copy**: from the viewer, a shelf's selection or the library's, a copy goes to the system share sheet with its location taken out of the bytes unless the member keeps it; **Download** saves the original to the device's own photo library.

8. **Back up, then free up space.**
   - The vault drains to the member's laptop; an album can be marked "Keep originals on this phone"; the More sheet counts the originals on the phone, their size and the kept share.
   - **Status: PARTIAL** — the backup carries the vault's rows and **no original** ([Q-1029-10](../decisions.md#open-questions-for-the-owner-1029)), so every original on the phone is the only copy and "Free up space" is a statement, not a button ([R-1029-PH-1](../decisions.md#photos-kept-originals-and-freeing-space-1029)).

9. **Set a key photo.**
   - In an album: select one photograph → "Make key photo". From the viewer: `···` → "Make key photo" (offered when the photograph was opened from an album). The album choice sheet draws the chosen cover.
   - **Status: SHIPPED** for album covers. Collections' album tiles stand on the key photo, or on the album's newest photograph when none is chosen (`PhotosCollectionsReads.albumCoversQuery`, a second read over `media_asset` because `with_held_thumbnail` cannot correlate on `core_collection`); year/month key photos have no schema seat.

10. **Browse by media type.**
    - A Videos shelf sits in Collections as first-class navigation. A video plays in the viewer (AVPlayer on iOS, Media3 on Android), and a Live Photo plays its movie.
    - **Status: PARTIAL** — Videos ship. **Screenshots, Panoramas and Selfies are deferred**: `media_asset.kind` is `photo | video | audio | scan` and no column carries a media subtype, so there is no honest signal to shelve on.

11. **Review faces, name people.**
    - "Is this the same person?" confirmation, never a wall of unlabelled clusters. Confirm a proposal onto a person, name a new person in one tap, skip (which writes nothing), keep a face unnamed, or forget a person entirely.
    - **Status: PARTIAL** — People, face review and `media.forget_person` ship over the `media_face_region` rows a vault holds, but nothing in this tree detects faces: `upsert_faces` went with the enrichment worker in [#1029](https://github.com/srikanth235/centraid/issues/1029). "Prioritise faces" is not offered ([R-1029-PH-6](../decisions.md#photos-what-the-port-builds-and-what-it-does-not-1029)).

12. **Edit a photograph.**
    - Crop, rotate, straighten, flip and fixed ratios. The original is never touched: a save is a new photograph that keeps the original's date, place and caption and names it as its source ([R-1029-PH-5](../decisions.md#photos-what-the-port-builds-and-what-it-does-not-1029)).
    - **Status: SHIPPED** for geometry. **Gap:** light/colour adjustment and auto-enhance.

## Summary

| Step | Status |
| --- | --- |
| Takeout import | **GAP**: no importer in this tree |
| Camera-roll backup | **SHIPPED**, automatic; no import offer by decision |
| Timeline, grain, scrub | **SHIPPED**; the 50k axis is registered |
| Caption/label/person/place/album search | **SHIPPED**; captions by `LIKE` until FTS has a request arm |
| Semantic + text-in-photo search | **GAP**: nothing computes embeddings or OCR |
| Sharing | **NOT IN v0**; Send a copy and Download ship |
| Backup, free up space | **PARTIAL**: no original is in the backup, so nothing is released |
| Key photo | **SHIPPED** for albums |
| Media-type shelves | **PARTIAL**: Videos ship; Screenshots/Panoramas/Selfies are deferred honestly |
| Faces | **PARTIAL**: review and naming ship; nothing detects faces |
| Enhance | **GAP** |

## Related

- [blueprint seats](../blueprint-seats.md) — seats, custody, and the north-star rule.
- [dogfood ritual](dogfood.md) — the real-library discovery checklist.
- [derived ledger](derived-ledger.md) — the tables behind steps 6 and 11.
- [recognition automations](../recognition-automations.md) — local recognition handlers and assets.
