# home-loads

**Goal:** prove the agent-e2e-mobile harness loop end-to-end on a clean
launch. It is the canonical "does the whole thing run" smoke test, with the
same process-boundary posture as the desktop Playwright journeys.

**Setup:** the standalone dev build must be installed on a booted
simulator/emulator (`bun run --filter=@centraid/mobile ios|android` once),
and Metro must be running on `:8081` (the dev build fetches its JS bundle
from there).

**Steps:**
1. Launch the installed app id (`ctx.state.appId`) with `clearState: true` →
   AsyncStorage wiped (pairing + onboarded flag included), so the founding
   onboarding screen paints.
2. Wait up to `FIRST_LAUNCH_TIMEOUT_MS` for debug-only **"Skip for now"** and
   tap it. Production has no skip (ceremony is mandatory); debug builds expose
   this so e2e can reach the springboard without a live pairing ticket.
3. Wait for the stable Home rail label **`"YOUR APPS"`** — first paint marker
   for the springboard launcher (the greeting above is time-of-day dependent).
4. Take screenshot `home-fresh`.
5. `scrollUntilVisible` the **"Connect your computer"** attention card with
   `visibilityPercentage: 100`, then assert it and **"Pair desktop"**. The
   card can sit below the fold; Maestro matches off-screen nodes, so the
   scroll is what makes the assertion mean something.

**Expectations:** the run dir contains screenshots for both steps,
`flows/*.yaml`, `state.json`, and a PASS `verdict.md`.

**Verdict:** PASS if the assertions succeed. FAIL otherwise — common
causes: Metro not running on `:8081`, or the app not installed / not a
debug build (no "Skip for now").

**On the timeout:** the budget covers cold Metro bundle fetch after
`clearState`, not product latency.
