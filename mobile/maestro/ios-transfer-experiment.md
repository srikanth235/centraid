# The iOS background transfer experiment

The protocol that decides how Centraid backs up a camera roll on iOS ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 3 lane E, D-1020-E5; open question 3).

**This experiment has not been run.** There is no device on the machines that built it. What is written below is the design, the measurements, the threshold and the **decision table** — so that the owner's run produces the number that decides, rather than a number somebody then has to interpret. The sentence that lands in [`docs/mobile-offline.md`](../../docs/mobile-offline.md)'s per-state promise is already written, once per outcome; the run picks one.

---

## The question

iOS does not let an app transfer a large number of files in the background on its own schedule. `BGProcessingTask` runs when the system decides, for as long as the system decides. `URLSession` background transfers continue outside the app but only over HTTP(S) and only to a URL. iroh-blobs is a QUIC transport with its own connection lifecycle and no `URLSession` equivalent.

So: **can Centraid back up a night's camera roll over iroh-blobs on iOS, or does it need an HTTPS door for the blob plane on that platform alone?**

The answer is a product promise, not a preference: it decides what Centraid can tell a member about when their photos will be safe.

## The threshold

**500 assets per night, charging, on Wi-Fi.**

From open question 3. It is a floor and not a target: a new iPhone's camera roll grows by roughly 20–40 assets on an ordinary day and by several hundred on a holiday, so a transport that clears 500 overnight never falls behind, and one that clears 50 falls behind permanently for a member who takes photographs.

A transport that clears the threshold on iroh-blobs makes the HTTPS door unnecessary. A transport that does not makes it required, and the door is then the smallest thing that can work: see _The door, if it is needed_ below.

## The matrix: 5 states × 2 transports

Five app states, because iOS treats each one differently and the differences are the whole question.

| # | State | How to get there | Why it is in the matrix |
| --- | --- | --- | --- |
| 1 | **Foreground, active** | app open, screen on | the control. Anything that fails here fails everywhere. |
| 2 | **Foreground, screen locked** | open the app, then lock the phone | the state a member is actually in when they plug the phone in at night |
| 3 | **Background, recent** | home-swipe out, leave the phone alone | iOS's most generous background state, and the one a `BGAppRefreshTask` gets |
| 4 | **Background, processing task** | `BGProcessingTask` submitted with `requiresExternalPower = true`, triggered with the debugger's `_simulateLaunchForTaskWithIdentifier:` | the intended overnight path |
| 5 | **Suspended, then relaunched** | force-quit, then let the task wake the app | the state that tests whether progress is durable, not whether it is fast |

Two transports:

| Transport | What it is | Feature |
| --- | --- | --- |
| **A — iroh-blobs** | the v1 blob plane, QUIC | default |
| **B — HTTPS blob door** | a `URLSession` background upload to a local TLS endpoint on the gateway | `--features blob-door` |

**Transport B is the ONE exception to `no-listening-socket`** — the xtask rule that refuses `TcpListener::bind` outside `#[cfg(feature = "blob-door")]` (lane C). It is off by default, and this experiment is the only thing that may turn it on.

**Build it only if it does not already exist.** `crates/net` and lane D2's work may already carry a door; `grep -rn 'blob-door' crates/` before writing one. If one exists, use it. If one does not, the smallest possible door is:

- a single `PUT /blob/<hash>` and `GET /blob/<hash>` over TLS, on the gateway;
- the cert is the gateway's own, pinned by the device at pairing — not a public CA, because the endpoint has no public name;
- no listing, no delete, no range requests, no auth of its own (the device is already enrolled and the connection is already mutually authenticated);
- `#[cfg(feature = "blob-door")]` on every line of it, including the `bind`.

If building the door is more than a day, **run transport A alone first**: a transport A result at or above the threshold makes the door unnecessary and makes building it wasted work.

## The measurements

Four numbers per cell, and one of them is the one that decides.

| Measurement | How | Why this one |
| --- | --- | --- |
| **assets transferred per session** | `BackupState.assets_transferred_this_session`, read from the diagnostics screen at the end of each state | the unit a member cares about |
| **assets transferred per night** | one 8-hour run per transport, charging, on Wi-Fi, phone untouched | **THE DECIDING NUMBER.** Everything else explains it. |
| **bytes transferred** | `BackupState.bytes_transferred_this_session` | separates "iOS stopped us" from "the photos were large" |
| **battery %** | Settings → Battery → the app's usage for the run window | a transport that clears the threshold and costs 20% overnight has not won |

**Read the counters, not a log.** The work counters under `BackupState` are integers and always on (`docs/mobile-offline.md:218`); the diagnostic spans are off unless `EXPO_PUBLIC_CENTRAID_TRACE=1` in v0 and behind the same kind of switch here. A measurement that needed tracing on would be measuring a traced build.

### The harness

Two pieces, both written and neither run:

1. **`mobile/maestro/flows/`** drives the foreground states (1 and 2) and reads the counters off the screen. The CLI is pinned to `MAESTRO_VERSION=2.6.1`, v0's pin, for the reason v0's README gives.
2. **An XCTest metric harness** for states 3, 4 and 5, because Maestro cannot drive a backgrounded app:

   ```swift
   // mobile/iosApp/Tests/BackgroundTransferMetrics.swift — TO BE WRITTEN ON A MAC
   //
   // `XCTOSSignpostMetric` over the signposts the transfer emits, plus
   // `XCTMemoryMetric` and `XCTClockMetric`, with
   // `measure(metrics:) { ... }` around one drain of N assets. The
   // background states are entered with
   // `XCUIDevice.shared.press(.home)` and, for state 4, with the debugger
   // command below rather than by waiting for the scheduler.
   ```

   ```
   (lldb) e -l objc -- (void)[[BGTaskScheduler sharedScheduler] \
       _simulateLaunchForTaskWithIdentifier:@"dev.centraid.sync-pass"]
   ```

   That command is why state 4 is measurable at all: waiting for `BGProcessingTask` to fire on its own takes hours and is not reproducible. **It is a simulation of the LAUNCH, not of the budget** — the task still gets the real expiration handler, which is the half that matters.

### The reference device

**One named device, and its name goes in the result.** R-1020-20: a parked `_`-prefixed ceiling in `tests/journeys.json` is promoted by the first run on a **named reference device**, never by a simulator. A simulator's background scheduler is not iOS's, and a number from one would be worse than no number.

The corpus: **2,000 assets, 6 GB**, generated on the device rather than copied, so that `PHAsset` local identifiers and capture dates are the device's own. Exact SHA-256 is identity; the corpus must include at least twenty Live Photo pairs (one `capture_group_id` each) and twenty videos over 100 MB, because a transport that clears 500 small JPEGs and stalls on one 400 MB video has not cleared the threshold.

### Evidence file names

The run writes four files per transport, and the names are fixed so the decision table can name them:

```
receipts/experiments/ios-transfer/<device>-<iosVersion>-transportA-states.json
receipts/experiments/ios-transfer/<device>-<iosVersion>-transportA-overnight.json
receipts/experiments/ios-transfer/<device>-<iosVersion>-transportB-states.json
receipts/experiments/ios-transfer/<device>-<iosVersion>-transportB-overnight.json
```

Each `*-states.json` is `{state: {assets, bytes, seconds, batteryDelta}}` for the five states; each `*-overnight.json` is `{assets, bytes, hours, batteryDelta, transport, device, iosVersion, corpus}`.

## The decision table

Three outcomes, three sentences. **The sentence is already written**; the run chooses which one stays in `docs/mobile-offline.md`.

| Outcome | Measured | The ruling | The per-state promise that lands |
| --- | --- | --- | --- |
| **1 — iroh wins** | transport A clears ≥ 500 assets/night, battery ≤ 10% | iroh-blobs is the blob plane on every platform. **The `blob-door` feature is deleted**, and `no-listening-socket` loses its exception. | _"Backed up overnight: plug the phone in on Wi-Fi and Centraid finishes the night's photos before morning."_ |
| **2 — iroh works, slowly** | transport A clears 100–499 assets/night | iroh-blobs stays the blob plane and the promise is honest about the rate. The door stays unbuilt. | _"Backed up over a few nights: Centraid moves your photos while the phone is charging on Wi-Fi, oldest first, and tells you how many are left."_ |
| **3 — iOS refuses** | transport A clears < 100 assets/night AND transport B clears ≥ 500 | **The HTTPS blob door ships on iOS only**, behind `blob-door`, as the smallest thing described above. `no-listening-socket` keeps its exception and gains a test that the door is off by default. | _"Backed up overnight: plug the phone in on Wi-Fi and Centraid finishes the night's photos before morning. On iPhone, Centraid uses a direct connection to your gateway for photo files."_ |

**A fourth outcome is possible and is not a promise**: both transports under 100. That is not a transport problem — it is iOS declining to run the app — and the ruling is then that **the camera-roll backup requires the app to be open**, with the promise _"Backed up while Centraid is open: leave it on screen while the phone charges."_ It is the worst outcome and it must be sayable, because the alternative is a promise the product cannot keep.

## What the owner hands back

1. The four evidence files above.
2. The device name and iOS version.
3. One line: which outcome row the numbers land in.

That is all the ruling needs. Everything else is written.
