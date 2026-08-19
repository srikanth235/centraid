# Photos day-one switcher walkthrough (D3)

This is the current day-one script for a Google Photos refugee. Every step carries an honest shipped, partial, or gap status; a gap names the current owner or reason.

Photos' north star is **iOS Photos** ([blueprint seats](../blueprint-seats.md)): when a design question has no answer, the north star's behaviour is the default answer. The walkthrough starts from Google because Takeout is a common escape hatch.

1. **Export the library from Google Takeout.**
   - Google ships a zip: media files plus a `.json` sidecar per item carrying the real capture time, geo, and description — and the only place album structure survives.
   - **Status: SHIPPED** — the importer reads the archive directly; sidecar beats EXIF beats nothing (a zip's file mtimes date the export, not the photograph, so they are deliberately not a tier).

2. **Import into Centraid.**
   - Drop the archive on the import surface. It stages as a draft batch on the existing import spine (draft → review → publish): media bytes land in the content-addressed blob store, sidecar metadata rides the rows, albums are reconstructed from the folder structure, Live Photo pairs share a capture group.
   - Review shows the batch's rows and dispositions; publish writes assets with provenance receipts. A photograph already in the vault by bytes dispositions as _skip_, so re-importing the same archive is idempotent — which is also the resumability story: an import that dies partway re-imports as exactly the missing rows.
   - **Status: SHIPPED** — staged Takeout import with sidecar capture time, geo, captions, favorites, album reconstruction, Live Photo pairing, and structural resumability. A dedicated first-run "bring in my phone's camera roll" flow remains open.

3. **Open the timeline and browse.**
   - Day sections, month headers, pinch rungs, justified packing, scrub rail. Photographs with no capture date live in an explicit Undated section, never interleaved as lies.
   - **Status: SHIPPED**.

4. **Find a 2019 photograph by year.**
   - The Years / Months / All grain control narrows to 2019; the scrub rail jumps.
   - **Status: SHIPPED**, exercised by adversarial fixtures for date-line crossings, wrong camera clocks, 10k photographs in one day, all-undated libraries, and the registered 50k scale rig.

5. **Search by caption, person, place, album.**
   - Grouped hits with counts and a door into the owning surface; caption matches ride device-local FTS, so this works offline.
   - **Status: SHIPPED** for captions, places, albums, and the consent-gated people pipeline.

6. **Search by what is _in_ the picture (semantic and text-in-photo).**
   - Type "beach sunset"; scored matches appear as a "Photos that look like…" hit group and join the grid. Type a word that appears as text inside a photograph (a sign, a receipt) and it can match too.
   - **Status: SHIPPED when the local model assets are installed** — the derived ledger, bundled recognition handlers, semantic-search route, and mobile hit group are live. Each handler reads and writes through `ctx.vault`; there is no service to configure. Photo OCR ([recognition automations](../recognition-automations.md)) accepts images and PDFs and lands extracted text in the same FTS plane as captions. Without embedding assets the gateway answers `unavailable` and omits only the semantic hit group. Offline semantic ranking over replicated vectors remains open; devices do not run model inference ([derived ledger](derived-ledger.md)).

7. **Share one photograph, or a whole album.**
   - Share is a standing grant through the one shared kit ([#825](https://github.com/srikanth235/centraid/issues/825)): the viewer shares the photograph (`media.asset`), an album's bar shares the album (`core.collection`), and both are _view_ — the declared subject registry offers no `edit` here, so album co-contribution is a deliberate v1 non-goal. Custody marks stay honest per seat.
   - **Status: SHIPPED** for one subject at a time; a multi-photograph selection refuses and names the album instead.

8. **Back up, then free up space.**
   - Backup is consent-gated per-photograph; `CloudOff` marks what the gateway does not hold.
   - **Status: SHIPPED** for the per-photograph motion. **Gap:** the large-library offload pass remains open because scale changes what "on this device" means.

9. **Set a key photo.**
   - In an album: select a photograph → "Make cover". From the viewer: overflow menu → "Make key photo" (offered when the photograph is in an album). The chosen cover shows everywhere covers render, including the Collections rails.
   - **Status: SHIPPED** for album covers; year/month key photos have no schema seat yet.

10. **Browse by media type.**
    - A Videos shelf sits in Collections as first-class navigation.

- **Status: PARTIAL** — Videos ship (`kind === "video"` is an honest signal). **Screenshots and Panoramas are deferred** because the bulk metadata path exposes no media-subtype field and per-asset async lookups violate the timeline engine's bounded-read contract. **Selfies are deferred** because there is no honest signal. The shelf code records these reasons.

11. **Review faces, name people.**
    - "Is this the same person?" confirmation, never a wall of unlabelled clusters. Confirm a proposal onto a party, name an unnamed cluster, or forget a person entirely.
    - **Status: SHIPPED** — consent-gated detection → embedding → party-anchored matching → stranger clustering on the bundled YuNet/SFace pair; `media.forget_person` provides the delete cascade required by [SECURITY.md](../../SECURITY.md). **Partial: People shelf wiring** ([`PhotosPeopleView.tsx`](../../apps/mobile/src/apps/photos/PhotosPeopleView.tsx)); the roster, review queue, and forget-person command work while shelf-wiring polish remains open.

12. **Edit a photograph.**
    - Crop, rotate, straighten — non-destructive, round-tripping with desktop.
    - **Status: SHIPPED** for geometry. **Gap:** light/colour adjustment, auto-enhance, and video/Live-Photo playback depth remain open.

## Summary

| Step | Status |
| --- | --- |
| Takeout export → import | **SHIPPED**; camera-roll first-run remains open |
| Timeline, grain, scrub | **SHIPPED**; 50k scale rig is registered |
| Caption/person/place/album search | **SHIPPED** |
| Semantic + text-in-photo search | **SHIPPED with local model assets**; offline semantic ranking remains open |
| Sharing, backup, custody | **SHIPPED**; large-library offload pass remains open |
| Key photo | **SHIPPED** for albums |
| Media-type shelves | **PARTIAL**: Videos ship; Screenshots/Panoramas/Selfies are deferred honestly |
| Faces | **SHIPPED**; People shelf wiring is partial |
| Enhance / video depth | **GAP** |

## Related

- [blueprint seats](../blueprint-seats.md) — seats, custody, and the north-star rule.
- [dogfood ritual](dogfood.md) — the real-library discovery checklist.
- [derived ledger](derived-ledger.md) — the substrate behind steps 6 and 11.
- [recognition automations](../recognition-automations.md) — local recognition handlers and assets.
