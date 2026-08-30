# photos-library

**Goal:** prove the seeded Library timeline, gesture-layer hit testing, and Years/Months/All drill-down on a real device.

**Setup:** `ctx.ensureDemo("photos")` runs before pairing, so the initial replica clone contains the deterministic multi-year corpus.

**Steps:** open Photos, choose Library, observe the loaded grid, scroll to summon the zoom drawer, choose Months, open the current seeded month, then wait for the All-grain drawer to withdraw.

**Verdict:** PASS only if the month period opens and the temporary drawer disappears. This owns the recognizer-versus-sibling layering claim that the RN gesture-handler mock cannot prove.

**Selectors** ([#890](https://github.com/srikanth235/centraid/issues/890) W2): the cover, the Library band destination and the grid are taken by handle (`photos-collections`, `photos-band-library`, `photos-grid`, `photos-select`); the month/weekday headers and the seeded month stay copy, because they are what the timeline publishes about the vault's own dates.

**Known gap:** the scroll-owned grain drawer (`Months` / `All`) carries no `testID`, so those three steps stay on copy. An id is not invented for them — `scripts/lint-mobile-testids.mjs` fails on an id no screen renders, and adding one is an `apps/mobile` change.
