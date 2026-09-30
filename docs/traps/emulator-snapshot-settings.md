# Trap — settings the CI emulator latches at boot

An Android emulator lane that restores a **cached AVD RAM snapshot** rather than cold-booting — an `AVD cache` step paired with `force-avd-creation: false` on `reactivecircus/android-emulator-runner` — resumes a memory image captured during a different workflow run. No workflow in this repository runs such a lane today; the lesson applies to the next one that does.

That makes `adb shell settings put global …` a half-measure for any setting `system_server` reads once and caches. The write lands in the settings provider, the cached copy in the restored RAM image does not change, and nothing on the lane says so — the command exits 0 and the behaviour is unchanged.

## The one that cost a lane

`hide_error_dialogs` suppresses Android's "isn't responding" (ANR) and "has stopped" system dialogs. `system_server` does not consult it per-ANR: it latches it into `mShowDialogs` inside `updateShouldShowDialogsLocked()`, which runs only on a **configuration change or at boot**. The snapshot's boot happened with the setting at 0, so the restore brings that `false` back and `settings put` updates a row nobody re-reads.

The dialog #535 fixed therefore came back: the Pixel Launcher ANR'd, its dialog covered the app, and a Maestro flow failed its first visibility assertion with zero assertions run — a system window with no app content, reported as a product regression ([#905](https://github.com/srikanth235/centraid/issues/905)).

The fix is a night-mode round trip after the write: the cheapest configuration change that forces the re-latch, read-then-restored so it is a net no-op.

## Before adding another `settings put global`

Ask whether the framework re-reads it or caches it. A setting the framework observes (a `ContentObserver`, or a read at each use) is fine after a snapshot restore; one latched at boot or on configuration change needs the same round trip. A setting that appears to have no effect on this lane but works on a locally booted emulator is this trap, not a typo.

## The second-order lesson

A guard nobody has watched fail is a guard nobody has tested. `hide_error_dialogs` was inert from the day the snapshot cache landed and stayed green the whole time, because the launcher happened not to ANR. A lane that restores a snapshot should also classify a system error dialog as infrastructure (#905 added an `android-system-error-dialog` signal for this) — a backstop that makes the failure legible, never a substitute for the suppression.
