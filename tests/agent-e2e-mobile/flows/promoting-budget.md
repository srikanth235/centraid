# Promotion suite budget

`op-sqlite-probe` and `share-intent-in` run under the `promoting-suite` suite on the nightly Android lane. The runner fails when aggregate wall time is **sixteen minutes or more**, measured from the first flow process start through the last verdict. Every journey writes an independent verdict, including after an earlier failure.

Both members pair for themselves. `op-sqlite-probe` restarts the app process mid-flow and `share-intent-in` needs a foregrounded, paired app before the intent is delivered, so `MAESTRO_REUSE_PAIRED_STATE` is never set here and the pairing cost is paid twice. That is what these two claim, not waste to be optimised away — but it is most of the number below, and any attempt to shrink this budget has to start there.

**Where sixteen minutes came from.** A FIRST-LAND ceiling: **derived arithmetic, not yet observed**, and weaker than the neighbouring derivations because neither member has run even once. Built from the same two rates the sibling budgets use — a fresh pairing at roughly **four minutes** on the reviewed CI runner (`MAESTRO_CHUNK_TIMEOUT_MS` in `lib/harness.mjs` is sized against it) and a navigation unit at **fifteen seconds** (`home-apps-budget.md`'s rate).

A **unit** here is one `ctx.run` chunk, counted from the flow rather than estimated, with a composer round trip priced at two because it opens a sheet, types, saves and re-reads the list.

|  | Pairing | Chunks | Units | Derived |
| --- | --- | --- | --- | --- |
| `op-sqlite-probe` | 4 min | 15 — 1 cover open, 5 composer round trips, 1 restart, 1 relaunch, 5 survival assertions, 1 recovery check, 1 screenshot | 20 (the 5 composer chunks count double) | 9 min |
| `share-intent-in` | 4 min | 3 — 1 paired-home assertion, the `am start`, 1 prefilled-capture assertion | 3 | 5 min |
|  | **8 min** | **18** | **23** | **14 min** |

Rounded up to sixteen, two minutes above the derivation rather than one. The cushion is deliberate and is **not** a licence to be slow: a composer round trip on a cold emulator is the least-measured unit in this repo, and `op-sqlite-probe` pays five of them back to back while the replica commits. Rounding against ourselves is the convention `probes-budget.md` applies; the extra minute is because this suite's arithmetic rests on zero observations rather than on rates borrowed from journeys that have run.

An earlier version of this table said "17 units" over an enumeration that summed to 18, omitted the relaunch and screenshot chunks entirely, and closed with "rounded up to sixteen rather than fourteen … with one more minute" — which is two. The counts above are taken from the flows (`grep -c "ctx.run(" `), not restated from memory.

**It becomes a measured ratchet.** The harness appends every flow's wall clock, verdict and failure class to the run ledger ([`../ledger/README.md`](../ledger/README.md)). Once **three real runs** exist, re-derive from the observed p95 and **tighten**, citing the sample count — `scripts/check-mobile-suite-budgets.mjs` starts enforcing that automatically at three samples and will name the number to tighten to. A budget nothing has come close to is not a budget.

**When it is breached.** Never raise it to buy time. In order: first shrink `op-sqlite-probe`'s burst — `BURST` is five because losing or duplicating one write should be unmistakable, and four still carries that property while removing two units. If that is insufficient, combine the five survival assertions into one chunk; they are five `ctx.run` calls today only so a failure names which write went missing, and that is a diagnosis convenience rather than a claim. Do not add retries, do not weaken a structural assertion, and do not move a member back onto the settled roster to escape this ceiling.

**This budget is temporary by construction.** A `promoting` member either graduates to `scheduled` — at which point it moves to the suite that owns its claim, and both budgets are re-derived — or it is deleted. If this file is still describing the same two flows in six months, the promotion pipeline has become a parking lot, which is the failure mode D3 names.
