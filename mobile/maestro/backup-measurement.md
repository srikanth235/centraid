# The backup measurement

The protocol that says whether the backup does the job the product exists to do, on real phones ([#1080](https://github.com/srikanth235/centraid/issues/1080), Validation: device hand-offs). It replaces the iOS background-transfer experiment of [#1020](https://github.com/srikanth235/centraid/issues/1020): that experiment compared two transports, and #1080 ruling 2 settled the transport — HTTPS to the member's own gateway, carried on iOS by the system's background `URLSession` while the app is suspended. What is left to measure is whether the pipeline built on it delivers.

**None of this has been run.** There is no phone, no Xcode and no Android SDK on the machines that built it. Every number below is the owner's to take, on a **named reference device**, never a simulator or an emulator ([R-1020-20](../../docs/decisions.md#v1-platform--rust-core-kmp-shell-electron-seat-gateway-anywhere-1020)): a simulator's background scheduler and its `nsurlsessiond` are not a phone's, and a number from one would be worse than no number.

---

## The three claims

| # | Claim | Platforms | Pass when |
| --- | --- | --- | --- |
| 1 | **The first backup of a 2,000-asset library finishes in one evening.** | the reference iPhone and the reference Android | every content hash the vault knows is confirmed by the gateway (`content_confirmed == content_total`, `pending_bytes == 0`) within **5 hours** of pairing, the phone charging on Wi-Fi |
| 2 | **A night's photos are confirmed by morning with the app closed.** | the reference iPhone (Android runs the same night as its control) | every photograph and video taken the day before is confirmed when the app is first opened the next morning, with the app **not opened** between the evening and the morning |
| 3 | **A fresh phone shows the full grid within minutes of the words.** | both | after the 24 words and the gateway's pairing payload are entered on a wiped phone, every derivative of the restored library is drawn within **10 minutes**; one original fetched on demand verifies |

## The corpus

**2,000 assets, made on the device**, so `PHAsset` local identifiers, `MediaStore` rows and capture dates are the device's own: at least 20 Live Photos, 20 videos over 100 MB, **one video over 64 MiB** (so at least one file is uploaded as several parts), **one video over 2 GiB** (larger than any spool's budget, so it backs up a window at a time, [R-1080-C39](../../docs/decisions.md#the-phone-core-and-the-cut-over-1080-lane-c)), 20 edited photographs (the walker backs up each one's current rendition, the edit as Photos draws it; whether the camera original and its adjustment data go beside it is the owner question #1080 A20 recorded, and an edited photograph is never offered to free up space), and the rest ordinary photographs. On iOS, turn **Optimise iPhone Storage off** for claims 1 and 3, and run claim 2 once with it on: an iCloud-only original is counted as waiting (`WAIT_REASON_ICLOUD`) rather than backed up, and the run records how many.

## The gateway

One `centraid-gateway serve` on the owner's laptop, on the same Wi-Fi, paired by the QR its `pair` prints. Record its version and the data directory's disk. The gateway's own object list is the second witness for every claim:

```sh
centraid-gateway pairings --data-dir <dir>          # the pairing and its safety number
centraid-gateway health --data-dir <dir>            # what it holds
```

## Running each claim

### 1 — the first evening

1. Install the build under test, open Centraid, make a vault from the words, grant full photo access (and, on Android, the location in photos, which rides with it).
2. Pair the gateway by scanning the QR its `pair` prints, from the More sheet's pairing row (or, once a gateway is paired, from the Backup screen's add control for a second one).
3. Plug the phone in, leave it on Wi-Fi with the screen off. On iOS do **not** force-quit the app: a force-quit cancels its background uploads, which is the platform's rule and not a failure of the pipeline. On Android, tap **Back up now** once, which starts the user-initiated job (API 34+) or the foreground service (below 34).
4. Every 30 minutes, read the Backup screen's line and record `content_confirmed`, `content_total`, `pending_bytes` and `spool_bytes`. Record the time the line first reads complete.

### 2 — the night, iOS with the app closed

1. During the day, take **50 photographs and 5 videos** with the system camera. Do not open Centraid after 18:00.
2. Leave the phone charging on Wi-Fi overnight, Centraid in the app switcher but not on screen.
3. The next morning, before opening Centraid, record the gateway's object count (`health`). Then open Centraid and read the Backup screen **before** the foreground pass changes anything: record `content_confirmed`, `content_total`, `last_ack_ms` and `last_snapshot_ms`.
4. Pull the night's evidence of the OS's work: the background `URLSession`'s relaunches and the processing windows granted.

```sh
# on the Mac the phone is attached to, for the night's window
log collect --device --start "<yesterday 18:00>" --output centraid-night.logarchive
log show centraid-night.logarchive --predicate 'process == "Centraid" OR process == "nsurlsessiond"' \
  | grep -E 'dev.centraid.uploads|dev.centraid.upload-pass|dev.centraid.sync-pass' > centraid-night.txt
```

To exercise the processing window by hand during development (not a substitute for the night):

```
(lldb) e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"dev.centraid.upload-pass"]
```

### 3 — the fresh phone

1. Erase a second reference phone of the same platform, install the build, and choose restore: enter the 24 words and the gateway's pairing payload.
2. Start a stopwatch at the restore's confirm. Record when the vault opens (rows), when the Photos grid has no placeholder left (every derivative fetched in bundles), and the time to open one original full-size (fetched by name, verified against its hash).
3. On the **old** phone, make one edit: it must be refused and the vault drawn as moved (read-only), because the restore claimed the writer epoch.

## What to record

One JSON file per claim per device, under fixed names, so the device lane that checks the evidence can name them:

```
receipts/experiments/backup/<device>-<osVersion>-evening.json
receipts/experiments/backup/<device>-<osVersion>-night.json
receipts/experiments/backup/<device>-<osVersion>-restore.json
```

- `*-evening.json`: `{device, osVersion, build, corpus: {assets, bytes, videos, partsMax}, pairedAt, completeAt, hours, samples: [{at, contentConfirmed, contentTotal, pendingBytes, spoolBytes}], batteryDelta, gatewayObjects}`
- `*-night.json`: `{device, osVersion, build, taken: {photos, videos}, confirmedAtOpen, contentTotalAtOpen, waitingICloud, lastAckMs, lastSnapshotMs, gatewayObjectsBefore, gatewayObjectsAfter, sessionRelaunches, processingWindows, batteryDelta}`
- `*-restore.json`: `{device, osVersion, build, rowsAtSeconds, gridCompleteAtSeconds, originalAtSeconds, originalVerified, oldPhoneRefused}`

`batteryDelta` is Settings → Battery → Centraid on iOS and `adb shell dumpsys batterystats --charged dev.centraid` on Android, for the run's window. `sessionRelaunches` and `processingWindows` are counted from `centraid-night.txt` above.

## Where the result lands

| Result | Destination |
| --- | --- |
| claims 1–3 pass | the device rows of [`docs/release/v1-handoffs.md`](../../docs/release/v1-handoffs.md) section 8 move to done, with the files above named; #1080's Validation device hand-offs are met |
| claim 2 fails with few `sessionRelaunches` | the background session is being throttled: record the counts and the gateway's reachability, and the batch size (`handoff`'s ≤ 64 parts / ≤ 1 GiB) is the first thing re-judged |
| claim 1 or 3 misses its time | the hours and the samples are the evidence for re-judging the spool budget and the bundle size; neither threshold is lowered to pass |

A missed threshold is reported as missed. The thresholds are the product's promise, and a promise moved to fit a measurement is no longer one.
