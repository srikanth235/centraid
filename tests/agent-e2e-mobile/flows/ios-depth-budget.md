# iOS release app-roster budget

`run-ios-depth-suite.mjs` runs 19 ordered journeys on the iOS Release artifact:
the pairing prerequisite, empty-Photos permission denial, a fully seeded replica
bootstrap, native resilience, the six non-Photos app covers, Sharing, Places,
Locker, the remaining Photos journeys, and the cold-start/scroll probes. The
runner fails when aggregate wall time is **seventy-five minutes or
more**, measured from the first flow process start through the final verdict.

This is an intentionally bounded increase from the former 25-minute native-
depth envelope. It pays for direct app-level evidence on iOS; it is not a retry
or a relaxed per-assertion timeout. The workflow's macOS job backstop remains
140 minutes, leaving time for a cold native build, setup, artifact handling,
and evidence upload.

`pairing-canary` runs first and short-circuits, for the same reason it does on
the PR gate: it is the shared prerequisite. `photos-permissions` then pairs a
clean, empty-Photos profile so its refusal claim is not contaminated by seeded
content. `ios-roster-bootstrap` drives Home's real sample-content action, which
seeds every seedable app and forces a fresh replica rebuild; every later app flow
runs with `MAESTRO_REUSE_PAIRED_STATE=1` against that complete profile. This is
why Home tile and app-content assertions are real: the phone observes the same
product seed-and-rebootstrap path a member would use, rather than relying on
host-side writes appearing in an already-cloned replica.

## Why these 19 flows

The iOS lane now answers two separate questions against the same shipped
artifact:

1. Does the OS-specific shell and native integration work on iOS?
2. Do the first-party app journeys actually render and act correctly on iOS?

The first question is owned by `native-v0-resilience`, `photos-permissions`,
`locker-gate`, `cold-start`, and `scroll-frames`. The second is explicit in
`docs-drive`, `agenda-week`, `notes-library`, `tasks-board`, `people-roster`,
`tally-derived`, `sharing-invite`, `places-seat`, and the remaining Photos
journeys. Android-only offline and external-share branches remain guarded by
their flows and are not falsely claimed as iOS evidence.

## Where seventy-five minutes came from

**Derived, not observed.** The expanded envelope is an initial CI scope budget;
the first three successful runs will replace these allowances with measured
p95s from [`../ledger/durations.json`](../ledger/README.md).

| Component | Minutes | Why it is included |
| --- | ---: | --- |
| Fresh pairing (`pairing-canary`) | 5 | The existing product-latency budget; pairing remains a prerequisite, not an unbounded setup allowance. |
| Empty-Photos permission journey | 5 | A second fresh pairing preserves the iOS refusal claim before any Photos seed. |
| Product-driven replica bootstrap | 5 | Home seeds seven deterministic app scenarios and rebuilds the phone replica. |
| Native depth (`native-v0-resilience`, `locker-gate`) | 10 | OS-mediated navigation, Keychain/process survival, and the required restart. |
| App-level covers (Docs, Agenda, Notes, Tasks, People, Tally, Sharing, Places) | 24 | Eight direct product journeys, with iOS accessibility/render headroom per journey. |
| Photos app-level journeys | 10 | Library, viewer, search, select/write, plus the separately established denied-permission path. |
| Performance probes (`cold-start`, `scroll-frames`) | 10 | Eight cold launches batched in one driver session, plus frame sampling on both surfaces. |
| CI/accessibility headroom | 6 | Serialized XCUITest and evidence overhead inside the 140-minute job backstop. |

The rows sum to the 75-minute aggregate ceiling. The five-minute increase is
the proportional allowance for the explicit fresh-replica lifecycle boundary;
it is below the scope-aware budget ratchet and is not a timeout for any product
assertion. The rows are not individual
timeouts: `lib/run-suite.mjs` enforces one absolute deadline, and the harness
clamps each Maestro chunk to the time remaining.

## What to do when it is breached

First classify the failure. A driver disconnect, missing receipt, or zero
assertions is an infrastructure signal; an app assertion timeout remains a
product failure and must not be retried into green. Then inspect the CI ledger
and artifacts before changing the envelope:

- If a chunk is needlessly paying a driver handshake, batch only adjacent
  phases that preserve the same state and evidence boundary.
- If a journey is genuinely slow, fix its app or harness cause and retain its
  assertion; do not hide it with a larger chunk timeout.
- After three real iOS runs, ratchet the aggregate budget to the observed p95
  plus explicit bounded headroom. If the envelope still does not fit under the
  140-minute job backstop, split the native/performance probes from the app
  roster as a separately reported CI job rather than silently widening again.

Do not add retries, skip flags, permission grants, or allowlist exceptions to
make a product assertion green. The requested budget increase buys named iOS
app coverage and nothing else.
