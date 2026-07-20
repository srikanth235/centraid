# home-loads

**Goal:** prove the agent-e2e-mobile harness loop end-to-end on a clean
launch. It is the canonical "does the whole thing run" smoke test, with the
same process-boundary posture as the desktop Playwright journeys.

**Setup:** the standalone dev build must be installed on a booted
iOS Simulator (`bun run --filter=@centraid/mobile ios` once), and Metro
must be running on `:8081` (the dev build fetches its JS bundle from there).

**Steps:**
1. Launch `dev.centraid.mobile` with `clearState: true` → AsyncStorage
   wiped (pairing included), so Home renders in its `no-gateway` branch.
2. Wait up to `FIRST_LAUNCH_TIMEOUT_MS` for the hero line
   `"Everything you build, in one place."` — the first thing `<Home>`
   paints once the JS bundle has downloaded from Metro. Note this waits on
   the hero, *not* on `"Connect your desktop"`: the pairing card only
   appears after the gateway probe resolves, so waiting on it would
   conflate "Home rendered" with "the probe finished".
3. Take screenshot `home-fresh` (lands under `runs/<runId>/screenshots/`).
4. Assert the hero plus the `"Built in"` section — `<Home>` rendered.
5. `scrollUntilVisible` the `"Connect your desktop"` card with
   `visibilityPercentage: 100`, then assert it and `"Pair desktop"`. The
   card sits **below the fold** on a phone-sized screen, and Maestro will
   happily match an element hidden behind the tab bar — so a bare
   `assertVisible` here passes while the pairing button is in fact
   untappable. The scroll is what makes this assertion mean something.

**Expectations:** the run dir contains `screenshots/01-home-fresh-home-fresh.png`,
`screenshots/02-home-fresh-pairing-home-fresh-pairing.png`,
`flows/01-home-fresh.yaml`, `flows/02-home-fresh-pairing.yaml`,
`state.json`, and a PASS `verdict.md`.

**Verdict:** PASS if the assertions succeed. FAIL otherwise — common
causes: Metro not running on `:8081`, or the app not installed on the sim.

**On the timeout:** the budget used to be 30s, which is what made this flow
fail in the nightly lane — on a cold Metro the first `clearState` launch has
to rebuild the whole JS bundle, and that alone exceeded 30s on the CI runner.
The copy was correct all along. `setup()` now prewarms the bundle before the
flow's clock starts, and the budget is deliberately generous: it covers a
bundle fetch, not product latency, so nothing is proven by tightening it.
