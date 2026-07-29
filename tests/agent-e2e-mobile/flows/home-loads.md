# home-loads

**Goal:** prove the agent-e2e-mobile harness loop end-to-end on a clean
launch and verify the mandatory ticket-only onboarding entry point. It is the
canonical "does the whole thing run" smoke test, with the same process-boundary
posture as the desktop Playwright journeys.

**Setup:** the standalone dev build must be installed on a booted
iOS Simulator (`bun run --filter=@centraid/mobile ios` once), and Metro
must be running on `:8081` (the dev build fetches its JS bundle from there).

**Steps:**
1. Launch the platform-specific development app with `clearState: true`, wiping
   the device profile and any prior pairing.
2. Wait up to `FIRST_LAUNCH_TIMEOUT_MS` for `"Connect your gateway."`.
3. Assert the pairing-code field and `"Continue with pasted code"` action.
4. Take screenshot `ticket-only-onboarding`.

**Expectations:** the run dir contains
`screenshots/01-home-fresh-ticket-only-onboarding.png`,
`flows/01-home-fresh.yaml`, `state.json`, and a PASS `verdict.md`.

**Verdict:** PASS if the assertions succeed. FAIL otherwise — common
causes: Metro not running on `:8081`, or the app not installed on the sim.

**On the timeout:** the budget used to be 30s, which is what made this flow
fail in the nightly lane — on a cold Metro the first `clearState` launch has
to rebuild the whole JS bundle, and that alone exceeded 30s on the CI runner.
The copy was correct all along. `setup()` now prewarms the bundle before the
flow's clock starts, and the budget is deliberately generous: it covers a
bundle fetch, not product latency, so nothing is proven by tightening it.
