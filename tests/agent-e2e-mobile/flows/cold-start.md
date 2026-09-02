# cold-start

**Claim:** the app still reaches a usable Home over EXISTING data, launch after launch, and does so within a stable time. If this passes when it should not, a release ships in which the app takes visibly longer to become usable — or, worse, comes up to a Home that is not usable at all.

**Why it exists:** cold start over a populated vault is the one latency a member feels on every single use, and it is the first thing that regresses when a read moves onto the launch path. Eight launches rather than one because a single sample cannot distinguish a slow launch from a slow runner; the median and p95 are what the drift budget will eventually ratchet against, once thirty durable samples exist.

**Setup:** reuses the lane's paired profile (`MAESTRO_REUSE_PAIRED_STATE=1`). It deliberately does NOT clear state — the claim is about launching over data that is already there, which is the case a member actually lives in.

**Steps:** stop the app, launch it, wait for the launcher grid (`home-grid`), repeated eight times; then report median, p95 and slowest.

**Expectations:** a budget, not an interrupt. The drift budget stays inactive until thirty durable samples exist, so this flow currently reports a distribution and fails only on an assertion, never on a threshold.

## What this flow measures, and why it is the launcher

The interval is **icon to usable**, not icon to band. The wait is on `home-grid`, the handle `LauncherGrid` alone publishes; `HOME_READY_MARKER` ("All apps and places") is the band's label and renders in **both** of Home's branches — the grid and the `DayOne` empty-vault fallback — so it cannot tell a Home that came up with the vault from one that came up without it.

That distinction was not theoretical. Asserting the band's label, this flow **passed** on run 33469364358 — median 16074 ms — against a Home whose screen digest carried "Nothing in here yet", "Fill it with sample content" and not one `home-tile-*`, while `notes-library` and `native-v0-resilience` failed on that same screen a minute earlier. It reported green on a build that could not open a single app. The launcher wait is what closed that.

Two consequences worth stating rather than rediscovering. The numbers are **longer** than the pre-#905 series, because they now include the replica reads settling — that is the honest reading, and no history is invalidated because the drift budget stays inactive until thirty samples exist. And this flow now **fails** when the vault does not arrive, where it used to pass; that is the point.

Still open: the launches run against whatever the lane seeded, not the declared year-3 volume (see the module header), so this bounds boot cost and cannot catch a launch that degrades with replica size.
