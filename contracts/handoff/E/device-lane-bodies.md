# The four device-lane bodies for `gate-nightly.yml`

Lane G owns `gate-nightly.yml` and its `device-lanes` step, which today reports a loud `Skipped` with the self-hosted-runner contract for four named lanes: `backup-measurement`, `android-macrobenchmark`, `ios-xctest-metrics`, `battery-per-background-pass`. These are the `run:` bodies for when a runner exists ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 3 lane E).

**The `Skipped` stays until a runner does.** A body that ran on `ubuntu-latest` and reported nothing would be worse than the refusal it replaced: R-1020-20 says a parked `_`-prefixed ceiling in `tests/journeys.json` is promoted by the first run on a **named reference device**, never by a simulator, and a nightly that quietly produced simulator numbers is exactly how a parked ceiling gets promoted by accident.

---

## `backup-measurement`

The protocol is `mobile/maestro/backup-measurement.md` ([#1080](https://github.com/srikanth235/centraid/issues/1080)), which replaced the iOS background-transfer experiment once #1080 settled the transport. It is **not** a nightly: its three claims are an evening (the first backup), a night (the app closed) and a restore, each on a named reference device. The nightly cell asserts the EVIDENCE exists, is complete and is fresh; it does not re-run it. The body is `device_backup_evidence` in `crates/xtask/src/gate.rs` (`cargo xtask gate --profile nightly --lane backup-measurement`), and this is what it does:

```yaml
- name: backup-measurement
  run: |
    set -euo pipefail
    evidence=receipts/experiments/backup
    if [ ! -d "$evidence" ]; then
      echo "SKIPPED backup-measurement: no evidence in $evidence."
      echo "The protocol is mobile/maestro/backup-measurement.md: an evening, a"
      echo "night and a restore on a named reference device, not a nightly."
      exit 0
    fi
    # Every claim's file carries the keys the protocol's "What to record"
    # fixes, names no simulator or emulator (R-1020-20), and at least one is
    # under 90 days old: the pipeline may have changed underneath a stale one.
    cargo xtask gate --profile nightly --lane backup-measurement
```

---

## `android-macrobenchmark`

```yaml
- name: android-macrobenchmark
  run: |
    set -euo pipefail
    if [ -z "${ANDROID_HOME:-}" ] || ! adb devices | grep -q 'device$'; then
      echo "SKIPPED android-macrobenchmark: no attached Android device."
      echo "Needs a self-hosted runner with a NAMED physical device (R-1020-20):"
      echo "  export ANDROID_HOME=...; adb devices"
      echo "  cd mobile && ./gradlew -Pcentraid.android=true :androidApp:connectedBenchmarkAndroidTest"
      exit 0
    fi
    # AN EMULATOR IS NOT A DEVICE. `adb` reports both, and a benchmark on an
    # emulator promotes a ceiling nobody measured.
    model=$(adb shell getprop ro.product.model | tr -d '\r')
    case "$model" in
      *sdk*|*emulator*|*Emulator*|*generic*)
        echo "SKIPPED android-macrobenchmark: '$model' is an emulator (R-1020-20)."
        exit 0
        ;;
    esac
    cd mobile
    ./gradlew -Pcentraid.android=true :androidApp:connectedBenchmarkAndroidTest --no-daemon
    echo "device=$model" >> "$GITHUB_STEP_SUMMARY"
```

---

## `ios-xctest-metrics`

```yaml
- name: ios-xctest-metrics
  run: |
    set -euo pipefail
    if ! command -v xcodebuild >/dev/null; then
      echo "SKIPPED ios-xctest-metrics: no Xcode on this runner."
      echo "Needs a macOS runner with a NAMED physical device attached:"
      echo "  xcrun devicectl list devices"
      echo "  cd mobile/iosApp && xcodebuild test -scheme Centraid \\"
      echo "    -destination 'platform=iOS,name=<device>' -only-testing:CentraidTests/BackgroundTransferMetrics"
      exit 0
    fi
    devices=$(xcrun devicectl list devices 2>/dev/null | grep -c 'available' || true)
    if [ "$devices" = "0" ]; then
      echo "SKIPPED ios-xctest-metrics: Xcode is here and no device is."
      echo "A SIMULATOR IS NOT A DEVICE: its background scheduler is not iOS's,"
      echo "and states 3-5 of the transfer experiment are about that scheduler."
      exit 0
    fi
    cd mobile/iosApp
    CENTRAID_IOS_DEPLOYMENT_TARGET="$(cat ../ios-deployment-target)" xcodegen generate
    xcodebuild test -scheme Centraid \
      -destination "platform=iOS,name=${CENTRAID_REFERENCE_DEVICE}" \
      -only-testing:CentraidTests/BackgroundTransferMetrics \
      -resultBundlePath build/metrics.xcresult
```

---

## `battery-per-background-pass`

The one lane that **cannot be automated on either platform** and should say so rather than pretending.

```yaml
- name: battery-per-background-pass
  run: |
    echo "SKIPPED battery-per-background-pass: not automatable."
    echo
    echo "Neither platform exposes per-pass energy to an app. iOS reports it in"
    echo "Settings -> Battery, hours later and rounded to a percent; Android's"
    echo "BatteryStats is per-uid and per-wakelock, not per-pass. A number"
    echo "derived from a proxy — CPU seconds, wakelock duration — would be a"
    echo "number nobody could act on, and promoting a ceiling from one would be"
    echo "worse than having none."
    echo
    echo "The owner's procedure, which IS the measurement:"
    echo "  1. charge to 100%, note the time"
    echo "  2. run the backup measurement's evening or night on a reference device"
    echo "  3. read Settings -> Battery -> Centraid (iOS) or dumpsys batterystats"
    echo "     (Android) for the run window"
    echo "  4. record batteryDelta in that claim's evidence file"
    echo
    echo "It is a field in mobile/maestro/backup-measurement.md's evidence,"
    echo "not a CI step."
```
