# Photos day-one switcher walkthrough (D3)

Settled **2026-08-07** (issue #721). The written script for day one of a Google Photos refugee, walked end to end. Every step carries an honest status; every gap names the umbrella workstream that owns it. The point of writing it down is the inverse of a demo: a step with no answer is a gap not yet on the list.

Photos' north star is **iOS Photos** ([docs/blueprint-seats.md](blueprint-seats.md)): when a design question has no answer, the north star's behaviour is the default answer. The walkthrough below is the switching member's actual motion, which starts from Google because Takeout is the more common escape hatch.

1. **Export the library from Google Takeout.**
   - Google ships a zip: media files plus a `.json` sidecar per item carrying the real capture time, geo, and description — and the only place album structure survives.
   - **Status: SHIPPED (A1)** — the importer reads the archive directly; sidecar beats EXIF beats nothing (a zip's file mtimes date the export, not the photograph, so they are deliberately not a tier).

2. **Import into Centraid.**
   - Drop the archive on the import surface. It stages as a draft batch on the existing import spine (draft → review → publish): media bytes land in the content-addressed blob store, sidecar metadata rides the rows, albums are reconstructed from the folder structure, Live Photo pairs share a capture group.
   - Review shows the batch's rows and dispositions; publish writes assets with provenance receipts. A photograph already in the vault by bytes dispositions as _skip_, so re-importing the same archive is idempotent — which is also the resumability story: an import that dies partway re-imports as exactly the missing rows.
   - **Status: SHIPPED (A1)** — staged Takeout import with sidecar capture time (epoch-zero and missing timestamps stay honestly absent, never 1970), geo (Takeout's zero-filled `(0,0)` is treated as absence), captions, favorites, album reconstruction (year-folders excluded), Live Photo pairing, and structural resumability. A dedicated first-run "bring in my phone's camera roll" flow is **A2, open**.

3. **Open the timeline and browse.**
   - Day sections, month headers, pinch rungs, justified packing, scrub rail. Photographs with no capture date live in an explicit Undated section, never interleaved as lies.
   - **Status: SHIPPED** (pre-#721; scale now measured — see step 4).

4. **Find a 2019 photograph by year.**
   - The Years / Months / All grain control narrows to 2019; the scrub rail jumps.
   - **Status: SHIPPED**, and now exercised by adversarial fixtures: date-line-crossing captures, wrong-camera-clock libraries, 10k-photographs-in-one-day, all-undated, and a registered 50k scale rig (C1/C2/D1, this PR).

5. **Search by caption, person, place, album.**
   - Grouped hits with counts and a door into the owning surface; caption matches ride device-local FTS, so this works offline.
   - **Status: SHIPPED** (pre-#721). People hits name only consent-named people; there is no face pipeline behind the naming UI yet (E4, below).

6. **Search by what is _in_ the picture (semantic).**
   - Type "beach sunset"; scored matches appear as a "Photos that look like…" hit group and join the grid.
   - **Status: PARTIAL (E1/E2/E3 shipped, this PR)** — the derived ledger, the gateway indexer (opt-in external embedder via `CENTRAID_EMBEDDER_PATH`), the semantic-search route, and the mobile hit group are all live. Without a configured embedder the gateway answers honestly `unavailable` and the group is simply absent — search never degrades elsewhere. Offline semantic ranking over replicated vectors is **E6, next version**; OCR text search is **B4, open** (the consent rails exist; the OCR sweep does not — see [docs/photos-derived-ledger.md](photos-derived-ledger.md)).

7. **Share one photograph.**
   - Copy to a shared vault; custody marks stay honest per seat.
   - **Status: SHIPPED** (pre-#721).

8. **Back up, then free up space.**
   - Backup is consent-gated per-photograph; `CloudOff` marks what the gateway does not hold.
   - **Status: SHIPPED** for the per-photograph motion. **Gap: C3** — a library that is 90% iCloud-offloaded on the phone quietly changes what "on this device" means at scale; that pass is open on the umbrella.

9. **Set a key photo.**
   - In an album: select a photograph → "Make cover". From the viewer: overflow menu → "Make key photo" (offered when the photograph is in an album). The chosen cover now shows everywhere covers render — including the Collections rails, which previously always showed newest.
   - **Status: SHIPPED (B5, this PR)** — album covers only; year/month key photos have no schema seat yet.

10. **Browse by media type.**
    - A Videos shelf sits in Collections as first-class navigation.
    - **Status: PARTIAL (B3, this PR)** — Videos shipped (`kind === "video"` is an honest signal). **Screenshots and Panoramas are deferred**: the bulk metadata path the 50k-asset timeline walk uses exposes no media-subtype field, and per-asset async lookups across a library are the round-trip pattern the timeline engine forbids. **Selfies are deferred** with no honest signal at all. The deferral and its reasons are recorded in the code where the shelves would live.

11. **Review faces.**
    - "Is this the same person?" confirmation, never a wall of unlabelled clusters.
    - **Status: GAP (E4)** — the consent-gated naming UI exists; the detect → embed → cluster pipeline does not. Scheduling is blocked on clearing a permissively-licensed detector/embedder pair (weights carry their own licences), and [SECURITY.md](../SECURITY.md) commits E4 to a proven delete-this-person cascade before it ships.

12. **Edit a photograph.**
    - Crop, rotate, straighten — non-destructive, round-tripping with desktop.
    - **Status: SHIPPED** for geometry. **Gap: B1** — light/colour adjustment and auto-enhance (the edit iOS members actually reach for) are open, as is video/Live-Photo playback depth (**B2**).

## Summary

| Step | Workstream | Status |
| --- | --- | --- |
| Takeout export → import | A1 | **SHIPPED (this PR)**; A2 camera-roll first-run open |
| Timeline, grain, scrub | — | SHIPPED; now fixture-proven at 50k (C1/D1) |
| Caption/person/place/album search | — | SHIPPED |
| Semantic search | E1/E2/E3 | **SHIPPED (this PR)**, embedder opt-in; E6 device-side next version; B4 OCR open |
| Sharing, backup, custody | — | SHIPPED; C3 offloaded-at-scale pass open |
| Key photo | B5 | **SHIPPED (this PR)** (albums) |
| Media-type shelves | B3 | **PARTIAL (this PR)**: Videos shipped; Screenshots/Panoramas/Selfies deferred honestly |
| Faces | E4 | GAP — blocked on model licensing + delete cascade |
| Enhance / video depth | B1/B2 | GAP |

## Related

- [docs/blueprint-seats.md](blueprint-seats.md) — seats, custody, and the north-star rule (Photos' north star is iOS Photos).
- [docs/photos-dogfood.md](photos-dogfood.md) — the ritual that walks this script against a real library.
- [docs/photos-derived-ledger.md](photos-derived-ledger.md) — the E1/E2/E3 substrate behind steps 6 and 11.
