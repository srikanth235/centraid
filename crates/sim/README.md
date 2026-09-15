# `centraid-sim`

The deterministic simulation: one gateway, N seats, a scripted network. **#1020's primary sync proof** (wave 2 lane D2, D-1020-D2-4).

Test-only (`publish = false`). Nothing links it; it is the proof, not the product.

## Every host is real except the network

The gateway host opens a real `centraid_vault::Vault` on a real file and answers through the real `centraid_core::Handle::call`. Each seat host opens a real seat file cut from a real snapshot and runs the real `centraid_seat::sync::pass` over the real applier and the real outbox. What turmoil provides is the **network and the clock**.

That matters because a simulation over mocks proves the mocks agree. v0 could not run this at all: its seat was a phone, a browser worker and a Bun process, and there was no way to put three of them in one deterministic process.

## Why UDP and not TCP (D-1020-D2-11)

1. **It is what the product speaks.** Production is iroh — QUIC over UDP. A simulation over TCP would prove convergence for a transport no seat has: no reordering, no datagram loss, no head-of-line blocking, which are exactly the three things a sync loop must survive and exactly what TCP hides.
2. **The product may not open a listening TCP socket**, and the xtask rule `no-listening-socket` says so on every gate run. A simulated listener is not a real one, but a crate whose source reads `TcpListener::bind` is a crate somebody copies from. The rule stands unweakened and this crate never asks it to bend.

## The seven invariants

Asserted after every schedule, against the **files** rather than against anything the run reported — a run that reported its own success would be asserting its own bookkeeping.

1. **Convergence** — every seat's replicated tables equal the gateway's, values not bytes, over 100+ tables. Two empty files is a _finding_, not a pass.
2. **Outbox drained or terminal** — empty, or every remaining intent terminal or parked **with a recorded reason**.
3. **Log contiguous** — `seq` gapless above the floor; no two commits interleaved.
4. **One receipt per intent** — every executed intent has exactly one invocation and exactly one receipt.
5. **`commit_seq` monotonic.**
6. **The cursor never walks back.**
7. **Idempotency** — one ledger row per `(intent, payload_hash)`, and no intent id holding two hashes.

## Seeds

```sh
cargo test -p centraid-sim                  # 25 seeds (the `pr` count)
SIM_SEEDS=250 cargo test -p centraid-sim    # the `nightly` count
SIM_SEED=14 cargo test -p centraid-sim      # one seed, what a failure tells you
```

A failing seed prints `SIM_SEED=<n>`, the schedule as JSON and every seat's passes. `contracts/sim/failing-seeds.json` records **every seed that ever failed**, with the bug it found and the change that fixed it, and `tests/recorded_seeds.rs` replays each one.

## What it found

Two real bugs, both on its first run, neither reachable by reading:

- **A liveness bug in settlement.** `CommandOutcome` carried no `commit_seq`, so an `executed` answer had nothing a seat could settle against and every overlay stayed painted for the life of the seat. Convergence _passed_ throughout, which is what made it invisible to every other test.
- **The gateway was not reproducible.** `Core::open` had no way to be given a clock, so two runs of one seed produced identical rows and different timestamps — and the receipt hash over those timestamps then differed too.

And two harness findings that taught the product something now written down in it: `PassReport::behind` is a **display number** meaning "as of the last page fetched", and a caller that treats `behind == 0` as terminal stops early.

## Termination

A seat polls to **quiescence**, not to `behind == 0`, behind a shared barrier: nobody stops until every seat has emptied its queue and several passes have passed with no submission anywhere. In production a change event wakes a seat that has gone quiet; there is no change feed to a seat in wave 2, so the simulation needs the barrier instead.
