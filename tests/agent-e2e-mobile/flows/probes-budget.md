# Probe journey budget

The five journeys `cold-start`, `home-loads`, `native-v0-resilience`, `places-seat` and `scroll-frames` run under the `probes-suite` suite. The runner fails when aggregate wall time is **twenty-six minutes or more**, measured from the first flow process start through the fifth verdict. Every journey writes an independent verdict, including after an earlier failure.

Unlike its two sibling suites, this one shares **nothing**. `home-loads` must run on a cleared client and `native-v0-resilience` restarts the app process, so `MAESTRO_REUSE_PAIRED_STATE` is never set and four of the five pair fresh against the gateway. That is not waste to be optimized away — it is what these five claim — but it dominates the number below, and any future attempt to shrink this budget has to start there.

**Where twenty-six minutes came from.** This is a FIRST-LAND ceiling: **derived arithmetic, not yet observed**. None of these five has ever run under one aggregate clock, so there is no distribution to sit on top of. It is built from the same two rates the neighbouring budgets used — a fresh pairing at roughly **four minutes** on the reviewed CI runner (the figure `MAESTRO_CHUNK_TIMEOUT_MS` in `lib/harness.mjs` is sized against, and the one `flows/home-apps-budget.md` prices its own base with), and navigation at **fifteen seconds a unit** (`home-apps-budget.md`'s two-minutes-across-eight-units rate).

|  | Pairing | Marginal work | Derived |
| --- | --- | --- | --- |
| `cold-start` | 4 min | 8 launch cycles × 15 s | 6 min |
| `home-loads` | — (cleared client) | one cleared-state launch, whose own `FIRST_LAUNCH_TIMEOUT_MS` bundle-fetch ceiling is 120 s | 2 min |
| `native-v0-resilience` | 4 min | 10 units — Settings, the airplane arc's offline write and reconnect, four process restarts | 6.5 min |
| `places-seat` | 4 min | 4 units — seed, shelf, map, pin readout | 5 min |
| `scroll-frames` | 4 min | 4 units — arm the sampler, the fling block, the report read, the People leg | 5 min |
|  | **16 min** | **8.5 min** | **24.5 min** |

Rounded up to twenty-six, because a ceiling built on a rate nobody has measured should round against itself rather than in its own favour — the same reasoning `home-apps-budget.md` applies to each of its added minutes.

Two honest limits on that arithmetic. It prices a relaunch cycle at the same fifteen seconds as a tap-and-assert, which is probably mean for `cold-start`'s eight cold relaunches. And it uses a per-flow pairing cost measured as a single chunk, not as one of five paid in sequence on a runner that is warming up. Both are reasons the number is a placeholder for a measurement, not a considered ceiling.

**It becomes a measured ratchet.** The harness now appends every flow's wall clock, verdict and failure class to the run ledger ([`../ledger/README.md`](../ledger/README.md)). Once **three real runs** of this suite exist per platform, re-derive this ceiling from the ledger's observed p95 and **tighten** it, citing the sample count. A budget nothing has ever come close to is not a budget.

**When it is breached.** Never raise it to buy time. In order: first combine adjacent Maestro chunks and remove duplicate arrival assertions, the same first move the other two suites make. If that is insufficient, the pairing floor is the sixteen minutes to attack — four flows each paying a fresh four-minute pairing for want of any shareable state. Do not add retries, do not weaken a structural assertion, and do not move a flow out of the suite to get under the number: an unbudgeted journey is exactly the state this suite was created to end.
