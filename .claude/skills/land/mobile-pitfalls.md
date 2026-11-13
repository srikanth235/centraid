# Mobile build and test pitfalls

Use these diagnostics when the corresponding layer is part of the change; they are not a checklist to run for every mobile edit. The canonical commands and prerequisites are in [mobile-commands.md](mobile-commands.md).

## A shell can link an old core

The iOS project links `libcentraid_core_ffi.a` by path, and Android loads a copied `.so` from `mobile/androidApp/src/main/jniLibs/`. Neither build notices that Rust changed. Rebuild the core for the target before debugging the shell, then compare the archive or `.so` modification time with the Rust edit. The JVM test builds its own cdylib and cannot hit this stale-file problem.

Phone core builds include `--features llama`; the JVM and PR builds omit it. An old or feature-mismatched phone core can load correctly while Chat reports `NO_ENGINE`. Check an archive with `nm <archive> | grep -c llama_` (zero means the engine is absent). The build needs CMake. iOS builds must export `IPHONEOS_DEPLOYMENT_TARGET`; Cargo does not rebuild `llama-cpp-sys-2` just because that variable changed, so clean that package for the target first when changing the deployment target. The Android core script currently points at the macOS NDK toolchain, even though Gradle can compile Compose on Linux with an Android SDK.

## Android packaging and release builds

JNA must resolve from its Android `@aar` artifact. A desktop jar may let the app build and install, then fail on the first `centraid_open` with `dlopen failed: library "libjnidispatch.so" not found`. Inspect the APK with `unzip -l`: a desktop resource such as `com/sun/jna/win32-x86-64/jnidispatch.dll` with no `lib/arm64-v8a/libjnidispatch.so` indicates the jar was packaged. Including both jar and AAR instead fails `checkDebugDuplicateClasses`.

Debug builds are not shrunk; release builds use R8. If a path reached by name works in debug and fails in release, check `androidApp/proguard-rules.pro`. This applies to JNA's dispatcher and the `CentraidLibrary` methods whose names are the exported C symbols.

Gradle warnings are errors, and dependency versions are locked. Versions belong in `mobile/gradle/libs.versions.toml`. After changing a dependency, rewrite lockfiles in both modes as documented in [`mobile/README.md`](../../../mobile/README.md): from `mobile/`, resolve dependency reports with `--write-locks` once without the Android flag, then again with `ANDROID_HOME` and `-Pcentraid.android=true`.

## Android emulator snapshot settings

There is no cached AVD RAM snapshot in the current workflow. If a future lane restores one, a successful `adb shell settings put global ...` may still not change a setting cached by `system_server`. `hide_error_dialogs` is one example: `mShowDialogs` is latched at boot or configuration change. A night-mode round trip after the setting write forces a re-latch; read and restore the previous mode so this remains a net no-op. Check whether the framework observes the setting or caches it before relying on it. A lane should classify a system error dialog as infrastructure so it does not masquerade as a product failure.

## Screenshots, iOS builds, and test fixtures

Roborazzi dependencies are present, but the Gradle plugin is not applied and no `captureRoboImage` test or reference image is committed. There are no Roborazzi `record` or `verify` tasks today. If a suite is added, review recorded images for a deliberate visual change; verification should compare with committed references. Do not record over a failed verification without inspecting the image. Swift snapshot testing is also not installed; snapshot work is an owner hand-off until the dependency exists.

There is no `swift test` route: the iOS sources import UIKit and link the core archive. Use the simulator test bundle on macOS. Give concurrent `xcodebuild` invocations distinct `-derivedDataPath` values. A new Swift file or proto needs XcodeGen regeneration because the project is generated and uncommitted.

Use `mobile/scripts/demo-vault.sh` for seeded app checks. Never copy a live `vault.db` into a test.
