# home-loads

**Goal:** prove the agent-e2e-mobile harness loop end-to-end on a clean
launch. Mirrors `tests/agent-e2e/flows/clone-template-and-reopen.md`'s
role as the canonical "does the whole thing run" smoke test.

**Setup:** the standalone dev build must be installed on a booted
iOS Simulator (`bun run --filter=@centraid/mobile ios` once), and Metro
must be running on `:8081` (the dev build fetches its JS bundle from there).

**Steps:**
1. Launch `com.centraid.mobile` with `clearState: true` → AsyncStorage
   wiped (pairing included), so Home renders in its `no-gateway` branch.
2. Wait up to 30s for `"Pair with your desktop"` text — only present after
   the JS bundle has downloaded from Metro and `<Home>` has mounted.
3. Take screenshot `home-fresh` (lands under `runs/<runId>/screenshots/`).
4. Assert `"Pair with your desktop"`, `"Open Settings"`, and
   `"Connect to your desktop."` are visible — the unique markers of the
   `no-gateway` state (issue #263 pairing-first copy).

**Expectations:** the run dir contains `screenshots/01-home-fresh-home-fresh.png`,
`flows/01-home-fresh.yaml`, `state.json`, and a PASS `verdict.md`.

**Verdict:** PASS if the assertions succeed. FAIL otherwise — common
causes: Metro not running on `:8081`, app not installed on the sim, or
the dev-client takes longer than 30s to download (bump the timeout).
