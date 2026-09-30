# The four device-lane bodies for `gate-nightly.yml`

Lane G owns `gate-nightly.yml` and its `device-lanes` step, which today reports a loud `Skipped` with the self-hosted-runner contract for four named lanes: `ios-transfer-experiment`, `android-macrobenchmark`, `ios-xctest-metrics`, `battery-per-background-pass`. These are the `run:` bodies for when a runner exists ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 3 lane E).

**The `Skipped` stays until a runner does.** A body that ran on `ubuntu-latest` and reported nothing would be worse than the refusal it replaced: R-1020-20 says a parked `_`-prefixed ceiling in `tests/journeys.json` is promoted by the first run on a **named reference device**, never by a simulator, and a nightly that quietly produced simulator numbers is exactly how a parked ceiling gets promoted by accident.

---

## `ios-transfer-experiment`

The protocol is `mobile/maestro/ios-transfer-experiment.md`. It is **not** a nightly: it is an 8-hour overnight run per transport on a charging device, and it happens once per transport rather than every night. The nightly cell should assert the EVIDENCE exists and is fresh, not re-run it.

```yaml
- name: ios-transfer-experiment
  run: |
    set -euo pipefail
    evidence=receipts/experiments/ios-transfer
    if [ ! -d "$evidence" ]; then
      echo "SKIPPED ios-transfer-experiment: no evidence in $evidence."
      echo "The protocol is mobile/maestro/ios-transfer-experiment.md; it is an"
      echo "8-hour overnight run on a named reference device, not a nightly."
      exit 0
    fi
    # The ruling depends on ONE number per transport. A stale one is worse than
    # none: the transport may have changed underneath it.
    newest=$(find "$evidence" -name '*-overnight.json' -newermt '-90 days' | wc -l)
    test "$newest" -ge 1 || {
      echo "FAILED: the transfer evidence is over 90 days old and the ruling rests on it."
      exit 1
    }
    node -e '
      const fs = require("node:fs");
      const dir = "receipts/experiments/ios-transfer";
      for (const file of fs.readdirSync(dir).filter((n) => n.endsWith("-overnight.json"))) {
        const run = JSON.parse(fs.readFileSync(`${dir}/${file}`, "utf8"));
        for (const key of ["assets", "bytes", "hours", "batteryDelta", "transport", "device", "iosVersion", "corpus"]) {
          if (run[key] === undefined) throw new Error(`${file} is missing ${key}`);
        }
        if (/simulator/i.test(run.device)) throw new Error(`${file} names a simulator (R-1020-20)`);
        console.log(`${run.transport} on ${run.device}/${run.iosVersion}: ${run.assets} assets/night`);
      }
    '
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
    echo "  2. run the transfer experiment's overnight cell for one transport"
    echo "  3. read Settings -> Battery -> Centraid for the run window"
    echo "  4. record batteryDelta in the *-overnight.json evidence file"
    echo
    echo "It is a row in mobile/maestro/ios-transfer-experiment.md's"
    echo "measurement table, not a CI step."
```
