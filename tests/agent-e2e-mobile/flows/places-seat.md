# places-seat

**Goal:** prove the phone's Places seat against the real replica columns — the seeded vault's `core_place` rows carry physical `geo_lat`/`geo_lng` (no web-handler rename), the seam #787 broke: the map drew pins while the shelf read "No places yet".

**Setup:** `ctx.ensureDemo("photos")` runs before pairing, so the initial replica clone contains the located Tahoe-roll frames; the flow then pairs fresh via `ctx.configureGateway()`.

**Steps:** open Photos, scroll Collections to the Places section, open its shelf, observe the non-zero "Places · N" header and at least one "<name>, N photographs" card, open the map from the head chip, observe the resting privacy sentence and the "drawn of held" count, press a pin, and observe its readout replace the resting sentence.

**Verdict:** PASS only if the shelf counts at least one place from the seeded rows AND the map both rests on its privacy sentence and reads out a pressed pin. A full map above an empty shelf is the #787 defect and must fail on the shelf assertion.

**Selectors** ([#890](https://github.com/srikanth235/centraid/issues/890) W2): every step of the route is taken by handle — `photos-collections`, `photos-shelf-places` (the shelf key, because `Open Places, N` carries the vault's count and so changes on every seed), `places-shelf`, `places-card-0`, `places-map-open`, `places-map`, `places-pin-0`, `places-readout`. Both sentences and both counts stay asserted as copy: the non-zero `Places · N`, the `<name>, N photographs` card label, the map's resting privacy sentence and its `drawn of held` count are exactly the claims #787 broke, and the handles are only how the flow reaches them.
