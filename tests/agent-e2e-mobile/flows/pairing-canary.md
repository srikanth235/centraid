# pairing-canary

**Claim:** the three prerequisites every committed mobile journey shares are working — the gateway is reachable and mints a one-time pairing ticket, the device is booted with the dev build installed, and that ticket redeems through onboarding to a ready Home.

**Why it exists:** a break in any of those three currently costs the entire nightly before anyone learns pairing was the problem. Each of the committed journeys discovers the same broken prerequisite independently, pays its own timeout doing so, and reports it as its own unrelated-looking failure — so the run ends with a wall of red whose common cause has to be reconstructed from nineteen verdicts. This flow runs first, alone, and answers that question in one verdict before anything fans out.

**Setup:** none of its own. `setup()`'s existing preconditions — a booted iOS Simulator or Android emulator, the dev build installed, Metro reachable — throw before the flow body runs, which is claim (2) enforced by the harness rather than restated here. `MAESTRO_GATEWAY_URL` (and `MAESTRO_GATEWAY_DATA_DIR` on the real-daemon lane) must be set, as for every paired journey.

**Steps:**

1. `ctx.configureGateway({ homeCommands })` — mint a ticket, clear the client, redeem it through the real ticket-only onboarding UI, and complete the profile. The canary supplies its own Home assertion and `paired-home` screenshot as final commands in that same safe driver session.

**Expectations:** it asserts **nothing app-specific**, on purpose. The moment the canary knows about Photos or Docs it acquires a second reason to go red, and a canary with two reasons to fail no longer answers the question it was asked. Everything below the Home marker belongs to the journey that claims it.

The Home commands remain visibly owned by this flow, so the verdict cannot pass on an implicit helper contract. The helper executes them in its final safe checkpoint, avoiding a second iOS driver launch after Home was already proved.

**Budget:** five minutes, asserted on the flow's own wall clock after the fact — a budget, not an interrupt. Over budget with the claims intact is still a FAIL, because the canary's value _is_ its speed; a slow canary has stopped being a canary and become the first flow of the nightly. The honest limit: a genuinely unreachable gateway or an unpaired device fails in seconds to two minutes, which is the case this exists for, but a wedged Maestro driver is still bounded by the harness's `MAESTRO_CHUNK_TIMEOUT_MS` and the canary cannot shorten that without making an honest slow-CI pairing flake.

**Verdict:** PASS only if a fresh ticket redeems to a ready Home inside the budget. FAIL means no journey downstream can be trusted to be reporting on its own claim — fix the prerequisite before reading any other verdict from the run.
