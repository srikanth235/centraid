# issue-816 — Place as a first-class dimension of memory

<!-- governance: allow-receipt-per-issue umbrella receipt in progress across waves; finalized with full shape, crosswalk and audit in the closing commit of #816 -->

GitHub issue: https://github.com/srikanth235/centraid/issues/816

Umbrella receipt for the waved Photos location rework. Waves land as sequential commits on this branch; this receipt is completed (checklist crosswalk, file coverage, decisions, verification, audit) in the final integration commit.

Waves landed so far:

- Wave 0 — rulings recorded, react-native-maps removed JS-side.
- Wave 1 — place-phrase ladder, phrase-first info panels, OSM link gone.
- Native fingerprints refreshed for the JS-side dependency removal (maintainer-authorized `ci:native-state --write`, 2026-08-17); the macOS `pod install` pass re-runs it after regenerating `Podfile.lock`.
- Wave 2 — naming conversations: `media.name_place`, "Name this place?" + "This is home" on both surfaces, retroactive re-phrasing verified.
- Wave 3 — opt-in offline gazetteer: vendored GeoNames cities15000 (CC-BY 3.0, snapshot 2017-02-27), `place-names` automation off by default, `media.set_place_gazetteer` writes address_json only.
- Root seam fixes after Waves 2–3: `name_place` act scope + pending-overlay declaration, `borders.hairline` in PlaceDetail, one-sentence place-names Settings blurb.
- Wave 4 — place as a search term (member names, gazetteer names, home vocabulary) and the "No location yet" bucket, both surfaces.
- Wave 5 — Trips: pure trips.ts titles trip cards through the ladder ("Weekend in South Lake Tahoe, CA"), route-sketch covers off the offline projection on both surfaces, grouping.ts stops printing coordinate names.

## User impact

Location in Photos becomes a phrase, everywhere: the lightbox info panels (web and phone) say "A place with no name yet", a member-given name, "near <settlement>", or "3.4 km NE of Home" — never a raw coordinate, and never an external map link. The exact coordinate survives only behind an explicit "Copy exact location" action. Later waves add naming prompts, an opt-in offline gazetteer, place search, auto-named Trips, and the default-on real map on mobile with a "Use real maps" switch back to the private sketch.

First-run: nothing to configure — the phrase ladder applies to the existing library at once; the gazetteer automation ships off and is opt-in from Automations.

Evidence: `artifacts/e2e/ui-impact/issue-816-place-phrase-info.png`, published by `tests/agent-e2e-mobile/flows/photos-viewer.mjs` (the phrased info sheet on the seeded roll, mobile-first).

## Session

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-17 | claude-code | 071fd468-b67d-569b-a64f-f6b9b4c676cd |
- Hygiene-ratchet fix: the bucket-card navigation asserted as call data, keeping the down-only mock-call budget at 800.
