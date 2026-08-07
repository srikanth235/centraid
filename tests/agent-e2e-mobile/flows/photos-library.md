# photos-library

**Goal:** prove the seeded Library timeline, gesture-layer hit testing, and Years/Months/All drill-down on a real device.

**Setup:** `ctx.ensureDemo("photos")` runs before pairing, so the initial replica clone contains the deterministic multi-year corpus.

**Steps:** open Photos, choose Library, observe the loaded grid, scroll to summon the zoom drawer, choose Months, open the current seeded month, then wait for the All-grain drawer to withdraw.

**Verdict:** PASS only if the month period opens and the temporary drawer disappears. This owns the recognizer-versus-sibling layering claim that the RN gesture-handler mock cannot prove.
