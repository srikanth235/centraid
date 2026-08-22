# released-binary-skew (W5.3, #842)

**Claim.** Tonight's gateway (built from source) still pairs and converges replicas with the **last published client artifact** — the release skew a household lives with when one device upgrades before another.

**Why it is not covered elsewhere.** Night Watch's L6 pins n−1 by **source** (it builds the previous commit). Members never skew by source; they skew by **release**. No other lane puts a released client on the wire against a source-built gateway.

**Shape.** `runFlow` boots tonight's source gateway and mints a ticket; the released client (resolved via `CENTRAID_SKEW_RELEASE_TAG` → `gh release download`, or a pre-extracted `CENTRAID_SKEW_CLIENT_DIR`) redeems it via its shipped `skew-driver.mjs`, then runs the pair + replica-convergence journey. The pure verdict lives in `../lib/skew.mjs` (`resolveReleasedClient`, `judgeSkewJourney`), unit-pinned in `../lib/skew.test.mjs`.

**Current state — blocked-external.** No client artifact has been published yet, so the lane **skips with citation** (green, but loud) every run.

**Unblock condition.** The **W6 release workstream** cutting the first client release. Then set `CENTRAID_SKEW_RELEASE_TAG` in the nightly job. Setting it without a real artifact does **not** pass vacuously — the judge fails an `available`-but-`ran:false` (or driver-less) result.
