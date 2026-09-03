#!/usr/bin/env bash
# Shared preamble for every Android device lane: build-or-restore the apk,
# install it, prove the right package landed, and silence the emulator's ANR
# dialogs. SOURCED (not executed) by its three callers (#915 Wave 2):
#
#   android-emulator-pr-gate.sh   ci.yml `mobile-device-gate` — rung 2, ONE leg,
#                                 the `pr-gate` suite at eight minutes warm
#   android-emulator-canary.sh    candidate.yml `mobile-canary-android` — rung 3
#   android-emulator-roster.sh    e2e.yml `mobile-e2e-android` — rung 4, depth
#
# The retired `android-emulator-pr-gate-resilience.sh` was the gate's second leg
# until #915 Wave 1 cut the gate to one; its three members are the `resilience`
# suite on rung 3 now.
#
# WHY ONE SCRIPT PER LANE SHAPE RATHER THAN ONE SCRIPT WITH A SUITE SWITCH
# (#890 W4). The earlier shape was one script branching on
# `CENTRAID_MOBILE_SUITE`, which reads fine and is wrong for one reason:
# `scripts/lint-e2e-wiring.mjs` derives what each lane schedules by reading the
# lane's job block and the committed scripts it hands off to. A script holding
# every branch makes every lane look like it runs every journey, so the linter
# could no longer tell a blocking lane from a nightly one — and its `promoting`
# and `exploratory` rules are exactly the rules that depend on that distinction.
# One script per lane shape keeps the shipped wiring readable by the thing that
# checks it.
#
# #890 W1 — THESE LANES DRIVE THE RELEASE ARTIFACT, NOT THE DEV CLIENT.
# This used to build `assembleDebug`, install `dev.centraid.mobile.debug`, and
# serve its JS live from Metro over `adb reverse`. Every assertion — including
# every perf probe — was therefore made against a `__DEV__` Hermes build fetching
# a bundle over a socket, which is not the thing a member installs. Half the
# harness's caveats (the dev-launcher URL wiped by clearState, the developer-menu
# explainer sheet, the 300s bundle prewarm, the ~43s cold-bundle launch) were
# infrastructure for testing the dev harness. A release build with an embedded
# Hermes bundle has none of them.
#
# Contract for every caller:
#   - CWD is the repo root (the emulator action's default working directory).
#   - ANDROID_CACHE_HIT is "true" when the fingerprinted apk cache was restored.
#   - CENTRAID_MOBILE_BUILD selects `release` (default) or `debug`. `debug` is
#     kept only for a local operator reproducing a dev-client-specific problem;
#     no lane sets it, and it still needs Metro, which this does not start.
#   - GITHUB_OUTPUT receives `built=true` only when this run actually compiled a
#     fresh apk, so the cache-save step knows there is something new to bank (a
#     cache-hit run must not re-save what it just restored).
#   - GITHUB_OUTPUT receives `gradle_ran=true` as soon as this run COMMITS to a
#     gradle invocation, whether or not that invocation ends in an apk. It gates
#     the gradle/native-directory save, which is a different question from
#     `built`: a build that dies in the C compiler still leaves a warm `.cxx` and
#     warm module build directories worth banking, and a run that restored the
#     apk leaves nothing at all (#916).

build_type="${CENTRAID_MOBILE_BUILD:-release}"

# #892 Phase 0 — BELT AND BRACES AGAINST A STALE-JS APK. Every lane's cache key
# now carries `js<hash>` alongside the native fingerprint, so a restored apk is
# supposed to be this commit's. That is a property of three hand-written key
# expressions in three workflow files, and the failure mode when one of them
# drifts is silent: the gate installs another commit's bundle, drives it, and
# reports green. So the apk banks the hash it was BUILT from, and the warm path
# refuses a mismatch here — where the cause is one line of output — instead of
# letting it surface as a journey asserting on copy this commit changed.
js_bundle_hash="$(node apps/mobile/scripts/js-bundle-fingerprint.mjs)"
test -n "$js_bundle_hash" || {
  echo "::error::empty JS bundle fingerprint; refusing to install an unverifiable apk"
  exit 1
}
js_stamp="$HOME/.cache/centraid-mobile-e2e-android/js-bundle.hash"

# `bundle_rerun` is the one task a warm build directory is NOT allowed to
# shortcut. See the long note above the gradle invocation in the cold path.
case "$build_type" in
  release)
    gradle_task=":app:assembleRelease"
    bundle_rerun=(":app:createBundleReleaseJsAndAssets" "--rerun")
    apk_glob='*/outputs/apk/release/*.apk'
    cached_apk="$HOME/.cache/centraid-mobile-e2e-android/app-release.apk"
    expected_package="dev.centraid.mobile"
    ;;
  debug)
    gradle_task=":app:assembleDebug"
    # `debug` is a debuggable variant, so the React Native gradle plugin never
    # registers a bundle task for it — the JS comes from Metro at runtime. There
    # is nothing to force.
    bundle_rerun=()
    apk_glob='*/outputs/apk/debug/*.apk'
    cached_apk="$HOME/.cache/centraid-mobile-e2e-android/app-debug.apk"
    expected_package="dev.centraid.mobile.debug"
    ;;
  *)
    echo "::error::CENTRAID_MOBILE_BUILD must be release or debug, got '$build_type'"
    exit 1
    ;;
esac

if [ "${ANDROID_CACHE_HIT:-}" = "true" ] && [ -f "$cached_apk" ]; then
  # Warm path: skip gradle entirely and install the banked apk — but only after
  # the apk itself agrees it was built from this commit's JS.
  banked="$(cat "$js_stamp" 2>/dev/null || true)"
  if [ "$banked" != "$js_bundle_hash" ]; then
    echo "::error::the restored apk was built from JS bundle '${banked:-<unstamped>}' but this commit is '$js_bundle_hash'."
    echo "::error::the apk cache key has drifted from apps/mobile/scripts/js-bundle-fingerprint.mjs — fix the key rather than the stamp; installing this apk would test another commit's JS."
    exit 1
  fi
  echo "Android cache hit - installing $cached_apk (js $js_bundle_hash, skipping gradle)"
  adb install -r "$cached_apk"
else
  # Cold path: build with gradle directly, then install — the SAME handoff the
  # warm path uses, so both paths end with the apk installed and Maestro driving
  # the launch.
  #
  # We deliberately do NOT use `expo run:android`. After a successful build it
  # runs a launch check for the base applicationId, which a debug build does not
  # satisfy (it installs as `dev.centraid.mobile.debug`, applicationIdSuffix in
  # android/app/build.gradle — J1/#501), aborting the job with "No development
  # build ... is installed" even though the apk built and installed fine (#535).
  # Maestro launches the real package itself, so expo's launch step is both
  # broken for this build and unnecessary. android/ is a committed native
  # project, so `assemble*` needs no prebuild.
  #
  # The release variant is DEBUG-SIGNED here on purpose: android/app/build.gradle
  # falls back to the debug signing config when CENTRAID_UPLOAD_STORE_FILE is
  # unset and CENTRAID_REQUIRE_RELEASE_SIGNING is not "1". A test lane must never
  # hold the Play upload key (J1), and the signature is not what these journeys
  # assert — the embedded bundle, the R8/Hermes configuration and the absence of
  # __DEV__ are. The store lanes set CENTRAID_REQUIRE_RELEASE_SIGNING=1 and get
  # the real key; this one deliberately does not.
  # #890 W1 — the perf-flavored release. `scroll-frames` and `cold-start` were
  # measuring a __DEV__ Hermes build because the frame sampler only existed under
  # __DEV__ at all, so the probes could not have run against the artifact even in
  # principle. Metro inlines EXPO_PUBLIC_* at export time and gradle's
  # `createBundleReleaseJsAndAssets` task is where that export happens, so the
  # flag has to be on THIS process, not on the Maestro run below. A store build
  # never sets it, so the probe stays absent from what members install.
  # `--stacktrace` because this build's failures are otherwise undiagnosable at
  # the price of a full cold rebuild. `mobile-device-gate` spent 34m55s to report
  # exactly this and nothing more:
  #
  #   > Task :app:packageRelease FAILED
  #   > A failure occurred while executing
  #     com.android.build.gradle.tasks.PackageAndroidArtifact$IncrementalSplitterRunnable
  #
  # — no cause, because gradle prints one only when asked. The next person then
  # pays another 35 minutes to learn what this run already knew. Stack traces are
  # emitted on failure only, so a green build's output is unchanged.
  #
  # ONE ABI, because exactly one is ever executed. gradle.properties declares
  # `reactNativeArchitectures=armeabi-v7a,arm64-v8a,x86,x86_64` — right for a
  # store artifact, and four times the native compile a test lane needs. Every
  # emulator this script feeds is x86_64 (`arch: x86_64` in all four workflows,
  # pinned in device-matrix.json), so the three ARM ABIs are compiled on every
  # cold build and never run. The matrix already records the divergence as
  # deliberate: only x86_64 is KVM-accelerated on the Linux runner, and the
  # arm64 evidence a member's phone produces is a device-farm spend deferred in
  # #890's non-goals. Building them here does not narrow that gap by one line —
  # it only spends the gate's wall clock, and this lane's whole problem is that
  # a JS-only PR misses the apk cache (the key names the JS, #892) and pays a
  # full release build inside the twelve-minute suite's own step.
  #
  # Overridden here rather than edited into gradle.properties: that file is the
  # STORE build's configuration too, and a store artifact that ships x86_64 only
  # is the one mistake this must not make. `-P` scopes it to the lanes that
  # source this script.
  # NO ANDROID LINT ON A TEST ARTIFACT. AGP wires `lintVital<Variant>` into
  # `assembleRelease`, so a cold gate build runs Android Lint across every
  # module before it can hand Maestro an apk: measured at 4m37s over 35 tasks
  # on run 33418649297, inside a 16m21s build, inside a 12-minute suite's own
  # step. It is not this lane's claim to make — `bun run lint` is a gate of its
  # own and runs on every PR in `static`, where a lint failure names itself in
  # seconds instead of costing a device lane.
  #
  # Excluded by task NAME (unqualified, so it matches in every module) rather
  # than by turning the check off in the DSL: `lint { checkReleaseBuilds }` is
  # the STORE build's configuration too, and a store artifact that skips lint
  # is the one mistake this must not make — the same reasoning as the ABI
  # override below. If AGP ever renames these tasks the build fails loudly with
  # "Task not found" rather than quietly resuming a 4-minute lint, which is the
  # failure mode to want.
  #
  # ALL THREE, NOT TWO (#916). `lintVitalRelease` is the CONSUMER — an
  # `AndroidLintTextOutputTask` whose `returnValueInputFile` and
  # `textReportInputFile` are written by the two analyze/report tasks excluded
  # beside it. Excluding only the producers left it in the graph with its inputs
  # deleted, and gradle refuses that at validation rather than skipping it:
  # "An input file was expected to be present but it doesn't exist" →
  # `WorkValidationException` → BUILD FAILED after an 18m19s compile, on run
  # 33711841127. The omission has been latent since #905 added the exclusions:
  # this lane hard-failed on an apk-cache miss until #916 reversed that, so no
  # PR had reached a cold gradle build to trip it, and a warm build skipped
  # every one of these tasks. It is unmasked by this branch, not caused by it.
  #
  # THE JS BUNDLE IS THE ONE TASK A WARM BUILD DIRECTORY MAY NOT SHORTCUT
  # (#916). Since the caching restructure, the three Android lanes restore
  # `apps/mobile/android/.gradle` alongside the build directories, so gradle
  # arrives with an execution history and can legitimately report tasks
  # UP-TO-DATE. `createBundleReleaseJsAndAssets` declares its sources as a file
  # tree under `apps/mobile` ONLY — that is React Native's own annotation, in
  # `BundleHermesCTask.sources` — while `js-bundle-fingerprint.mjs` correctly
  # counts `packages/{core,client,design,blueprints}` and `bun.lock` as bundle
  # inputs too. A PR that changes only a workspace package therefore moves the
  # apk key (so the apk cache misses, so we are here) without moving that task's
  # declared inputs, and a restored, history-vouched bundle would be reused: a
  # stale Hermes bundle inside a freshly packaged apk, which is exactly the
  # false pass #892 built the JS fingerprint to prevent, re-entering through the
  # other cache.
  #
  # `--rerun` is a built-in task option (gradle 7.6+), so it applies to the task
  # it follows and to nothing else: the bundle and hermesc always run against
  # this checkout, every other task in `assembleRelease` stays eligible for
  # UP-TO-DATE and FROM-CACHE. The guarantee is structural — it does not depend
  # on a dependency's input annotations being right.
  #
  # Announce the compile BEFORE it starts. `built=true` below says "an apk
  # exists"; `gradle_ran=true` says "this runner produced native output worth
  # banking", which is a different question and is answered even by a build that
  # fails halfway. The lanes gate their gradle-directory save on this one, so an
  # apk-cache HIT no longer re-banks a barren directory over a warm one
  # (receipts/issue-905-client-e2e-escape-hatch.md, run 33370541215).
  echo 'gradle_ran=true' >> "$GITHUB_OUTPUT"
  ( cd apps/mobile/android \
    && EXPO_PUBLIC_CENTRAID_FRAME_PROBE=1 ./gradlew "${bundle_rerun[@]}" "$gradle_task" \
      -PreactNativeArchitectures=x86_64 \
      -x lintVitalAnalyzeRelease -x lintVitalReportRelease -x lintVitalRelease \
      --console=plain --stacktrace )
  # Bank the apk under the content-addressed cache path. Fail hard if it is
  # missing rather than caching nothing (a later hit would install nothing and
  # fail obscurely at flow time).
  apk="$(find apps/mobile/android -type f -path "$apk_glob" -print -quit 2>/dev/null || true)"
  test -n "$apk" || { echo "::error::built $build_type apk not found under $apk_glob"; exit 1; }
  adb install -r "$apk"
  mkdir -p "$(dirname "$cached_apk")"
  cp "$apk" "$cached_apk"
  # Stamp what this apk's JS actually is, so the warm path above can refuse a
  # mismatch without trusting the key expression that restored it.
  printf '%s' "$js_bundle_hash" > "$js_stamp"
  echo 'built=true' >> "$GITHUB_OUTPUT"
fi

# Prove the package the flows will drive is actually installed, by the id the
# harness resolves for this build type. A silent id mismatch is how #535 turned a
# working build into an obscure flow-time failure; assert it where the cause is
# obvious instead.
adb shell pm list packages "$expected_package" | grep -q "package:$expected_package" || {
  echo "::error::$expected_package is not installed after the $build_type install step"
  adb shell pm list packages dev.centraid || true
  exit 1
}

# Suppress Android's "isn't responding" (ANR) / "has stopped" system dialogs.
# Under the emulator's software GPU the Pixel Launcher intermittently ANRs while
# our app is foregrounded, and Android pops a system dialog OVER it. Maestro then
# queries that system window (which has no app content) and every `visible`/tap
# against the app fails — a flaky non-repro that blocked the onboarding "Skip"
# even though the app had rendered it (#535; screenshot: launcher ANR over the
# Welcome screen). `hide_error_dialogs 1` lets the launcher ANR silently in the
# background instead of stealing the window.
adb shell settings put global hide_error_dialogs 1 || true

# WRITING THAT SETTING IS NOT ENOUGH, AND HAS NOT BEEN SINCE THE SNAPSHOT CACHE
# (#905). `system_server` never reads HIDE_ERROR_DIALOGS at ANR time: it latches
# it into `mShowDialogs` inside `updateShouldShowDialogsLocked()`, which runs
# only on a configuration change or at boot. This lane RESTORES A CACHED AVD RAM
# SNAPSHOT (`.github/workflows/ci.yml`, the `AVD cache` step feeding
# `force-avd-creation: false`), so the latch was taken during a different run's
# boot with the setting still at 0 and the restore brings that `false` back in
# the RAM image. `settings put` then updates a row nobody re-reads, and the
# guard #535 added has been inert on this lane ever since — which is how the
# launcher ANR dialog covered onboarding again on run 33512726935 and failed
# `Assert that "Connect your gateway." is visible` with zero assertions run.
#
# A night-mode round trip is the cheapest configuration change that forces the
# re-latch. It is a net no-op: the current value is read first and restored, and
# no app is running to observe either edge. Best-effort throughout — on an image
# whose `cmd uimode` refuses, the classifier signal in
# tests/agent-e2e-mobile/lib/failure-class.mjs is what keeps the dialog from
# being recorded as a product regression.
# `|| true` on the read too: the caller runs under `set -euo pipefail`, so a
# pipeline `adb` fails would abort the whole lane on a diagnostic round trip.
night_now="$(adb shell cmd uimode night 2>/dev/null | tr -d '\r' | awk '{print $NF}')" || true
case "$night_now" in
  yes) night_other=no ;;
  *) night_other=yes ;;
esac
adb shell cmd uimode night "$night_other" >/dev/null 2>&1 || true
adb shell cmd uimode night "${night_now:-no}" >/dev/null 2>&1 || true

# THE FIRST LAUNCH AFTER AN INSTALL IS NOT A LAUNCH ANY FLOW CLAIMS TO MEASURE
# (#905). A just-installed apk has no AOT artifacts, so Android's first start of
# it verifies and compiles on the spot; on a SwiftShader emulator that pushed the
# very first launch past `FIRST_LAUNCH_TIMEOUT_MS` and red-lined `pairing-canary`
# on `Assert that "Connect your gateway." is visible` — an assertion about
# onboarding failing for a reason that has nothing to do with onboarding.
#
# THIS LANE USED TO GET THE WARM-UP BY ACCIDENT: the cold gradle build sat
# between `adb install` and the first flow, so the emulator had sixteen minutes
# to settle. Caching the apk (#905) removed the build and, with it, the pause
# nothing had ever named. The fix is to name it — this is device preparation,
# the same kind of thing as `hide_error_dialogs` above, not a retry.
#
# `compile -m speed` is what makes it deterministic rather than a wait-and-hope:
# it does the one-time ART work up front instead of leaving it to land inside
# whichever assertion runs first. It also moves the emulator TOWARD a member's
# phone, where the installer and background dexopt have long since done this —
# a freshly side-loaded apk is the unrepresentative case, not the compiled one.
# Best-effort: on an image whose `cmd package` refuses, the throwaway launch
# below still absorbs the cost.
adb shell cmd package compile -m speed -f "$expected_package" || true
# One throwaway launch for everything AOT cannot pre-pay — the first Hermes
# bundle evaluation, the cold page cache. The settle is a fixed budget, not a
# readiness signal: nothing is asserted here, so there is nothing to observe,
# and `am force-stop` hands the first flow a cold PROCESS over a warm install,
# which is exactly the state every flow already believes it starts from.
adb shell monkey -p "$expected_package" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
sleep 20
adb shell am force-stop "$expected_package" || true

# AND THEN GIVE THE LAUNCHER ITS OWN SETTLE, because the force-stop above is
# what resumes it (#905). The stop evicts our app and hands the foreground back
# to a Pixel Launcher that has been swapped out for twenty seconds on a runner
# that just finished a gradle build and a full dexopt; it then sits unscheduled
# while the seeder below saturates the CPU, and the `pm clear` broadcast that
# opens the first flow lands on a process that cannot answer inside the
# broadcast timeout. Run 33512726935 caught the result: `MainActivity EXITING`
# at 13:37:39.9 — this line — and "Pixel Launcher isn't responding" over the
# app twelve seconds later.
#
# A HOME keyevent plus a short settle draws and schedules the launcher while the
# machine is still idle, so the broadcast reaches a warm process. Nothing is
# asserted here and nothing branches on it: like the app warm-up above, this is
# device preparation, not a retry.
adb shell input keyevent KEYCODE_HOME >/dev/null 2>&1 || true
sleep 5

# WHAT THE RADIO SAYS, BECAUSE THE REPLICA ASKS IT (#905). Replica sync shares
# the byte-transfer rules — `nativeSyncAllowed` in
# apps/mobile/src/lib/upload/native-policy.ts is literally `canTransfer()` — and
# `DEFAULT_TRANSFER_POLICY` is `wifiOnly: true`. So on a device whose ACTIVE
# network is not Wi-Fi, a fresh phone pairs, draws Home, and never pulls a row:
# `pullScopes` returns `policyBlocked` and stamps no freshness. There is no
# error anywhere, and at flow time that is indistinguishable from a vault that
# is genuinely empty — the exact ambiguity that cost this lane days.
#
# Which state an emulator image is in is an accident of the CI image, not a
# property of the product, so it is recorded rather than assumed. Two lines,
# best-effort, no assertion: this names the transport the app will see, next in
# the log to the failure it would explain. Nothing branches on it — a lane that
# quietly relaxed a member's transfer rules to go green would be testing a
# device no member has.
echo "--- active network (what the transfer rules will be evaluated against) ---"
adb shell dumpsys connectivity 2>/dev/null | sed -n '/Active default network/,+8p' || true
adb shell dumpsys connectivity 2>/dev/null | grep -m2 -oE 'Transports: [A-Z_|]+' || true

node scripts/test-report/prepare.mjs

# #905 — THE CORPUS GOES IN BEFORE ANYTHING PAIRS.
#
# A lane is many flows sharing ONE pairing: the pr-gate pairs in
# `pairing-canary`, the roster pairs inside `run-probes-suite` and then runs
# three more suites against that profile. A flow's own `ctx.ensureDemo` writes
# to the gateway only, so every seed after that first pairing is invisible to
# the phone — the notes corpus was seeded (16 rows, in the log) and no row ever
# reached the replica. Home then saw every tile settled and empty, rendered
# `DayOne` instead of `LauncherGrid`, and twelve journeys failed at their first
# `Open <App>` tap while the app was behaving correctly.
#
# Seeding here, before the emulator script hands off to Maestro, is what makes
# the corpus precede the clone. It is idempotent, so the per-flow calls that
# document each journey's fixture stay and cost nothing.
node tests/agent-e2e-mobile/seed-demo-corpus.mjs

export MAESTRO_PLATFORM=android
# Read by lib/harness.mjs: it selects the installed applicationId for this build
# type and, on `release`, skips the Metro reachability wait and bundle prewarm
# entirely — a release artifact carries its own bundle and never talks to Metro.
export CENTRAID_MOBILE_BUILD="$build_type"
