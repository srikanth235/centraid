# pairing-canary

**Claim:** the three prerequisites every committed mobile journey shares are working — the gateway is reachable and mints a one-time pairing ticket, the device is booted with the dev build installed, and that ticket redeems through onboarding to a ready Home.

**Why it exists:** a break in any of those three currently costs the entire nightly before anyone learns pairing was the problem. Each of the committed journeys discovers the same broken prerequisite independently, pays its own timeout doing so, and reports it as its own unrelated-looking failure — so the run ends with a wall of red whose common cause has to be reconstructed from nineteen verdicts. This flow runs first, alone, and answers that question in one verdict before anything fans out.

**Setup:** none of its own. `setup()`'s existing preconditions — a booted iOS Simulator or Android emulator, the dev build installed, Metro reachable — throw before the flow body runs, which is claim (2) enforced by the harness rather than restated here. `MAESTRO_GATEWAY_URL` (and `MAESTRO_GATEWAY_DATA_DIR` on the real-daemon lane) must be set, as for every paired journey.

**Steps:**

1. `ctx.configureGateway({ session: true, homeCommands })` — mint a ticket, clear the client, redeem it through the real ticket-only onboarding UI, and complete the profile. The three short phases run in one Maestro/XCUITest session; the canary supplies its own Home assertion and `paired-home` screenshot after the capability has been consumed.

**Expectations:** it asserts **nothing app-specific**, on purpose. The moment the canary knows about Photos or Docs it acquires a second reason to go red, and a canary with two reasons to fail no longer answers the question it was asked. Everything below the Home marker belongs to the journey that claims it.

The Home commands remain visibly owned by this flow, so the verdict cannot pass on an implicit helper contract. The helper executes them in the final phase of the same driver session. The retained evidence is limited to explicit screenshots from before ticket entry and after Home; the session's hierarchy and command report are discarded because they span the live capability.

**Budget:** five minutes of product latency from the completed `onboarding-connect` action to the completed Home-ready assertion, asserted after the fact from Maestro's command receipt. XCUITest installation, driver handshake, and app launch are infrastructure setup; counting them as pairing latency made the budget measure the test runner three times. Over budget with the claims intact is still a FAIL. A wedged driver remains bounded by the harness's `MAESTRO_CHUNK_TIMEOUT_MS` and the suite's absolute deadline.

**Verdict:** PASS only if a fresh ticket redeems to a ready Home inside the budget. FAIL means no journey downstream can be trusted to be reporting on its own claim — fix the prerequisite before reading any other verdict from the run.
