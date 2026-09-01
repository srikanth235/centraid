# cold-start

**Claim:** the app still reaches a usable Home over EXISTING data, launch after launch, and does so within a stable time. If this passes when it should not, a release ships in which the app takes visibly longer to become usable — or, worse, comes up to a Home that is not usable at all.

**Why it exists:** cold start over a populated vault is the one latency a member feels on every single use, and it is the first thing that regresses when a read moves onto the launch path. Eight launches rather than one because a single sample cannot distinguish a slow launch from a slow runner; the median and p95 are what the drift budget will eventually ratchet against, once thirty durable samples exist.

**Setup:** reuses the lane's paired profile (`MAESTRO_REUSE_PAIRED_STATE=1`). It deliberately does NOT clear state — the claim is about launching over data that is already there, which is the case a member actually lives in.

**Steps:** stop the app, launch it, assert the Home marker, repeated eight times; then report median, p95 and slowest.

**Expectations:** a budget, not an interrupt. The drift budget stays inactive until thirty durable samples exist, so this flow currently reports a distribution and fails only on an assertion, never on a threshold.

## The honest limit, recorded rather than left to be rediscovered

**This flow's assertion is weaker than its claim.** It asserts `HOME_READY_MARKER` ("All apps and places"), which `lib/demo-corpus.mjs` documents as rendering in **both** of Home's branches — the `LauncherGrid` and the `DayOne` empty-vault fallback. So the marker proves the band mounted, not that Home is usable, and the second half of the claim above is currently unenforced.

That is not hypothetical. On run 33469364358 this flow **passed** — median 16074 ms — against a Home whose screen digest carried "Nothing in here yet", "Fill it with sample content" and not one `home-tile-*`, while `notes-library` and `native-v0-resilience` failed on that same screen a minute earlier. It reported green on a build that could not open a single app.

Closing it means asserting a launcher landmark (`launcher-grid`, or a tile handle from `apps/mobile/app-conformance.json`) instead of a band label. That is a strengthening, not a loosening — but it converts a currently-green flow into an honestly-red one for as long as the replica arrives empty, so it belongs in the change that fixes the replica rather than ahead of it. Tracked under #905; do not "fix" the symptom by weakening the marker further.
