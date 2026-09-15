# A Kotlin/Native framework links a Rust archive nothing rebuilt

**The symptom.** You change `crates/core`, rebuild the XCFramework, rebuild the app, run it — and the change is not there. No error, no warning, no stale-build notice. The Kotlin recompiled, the Swift recompiled, the app installed. The behaviour is the one from whenever you last ran `cargo build --target`.

**The cause.** `mobile/shared/build.gradle.kts` links the Rust core with

```
linkerOpts("-force_load", "$slice/libcentraid_core_ffi.a")
```

where `slice` is a **path into `target/<triple>/<profile>/`**. It is a path and not a Gradle dependency, so nothing in the Gradle graph knows the archive exists, nothing declares it as an input, and nothing rebuilds it. Gradle's up-to-date check cannot see a file it was never told about, and the linker is perfectly happy to link a five-hour-old archive.

This is the same shape as the XCFramework's own `-force_load` lesson recorded beside it — a link that succeeds while being wrong — one layer further out.

**What it looks like when it bites.** The wave-A byte door was added to `crates/core` and wired through Kotlin and SwiftUI in one pass. Every layer compiled. On the simulator the Photos mosaic drew four empty cells. The Kotlin diagnostics showed the request being built correctly with the right content ids; the Rust probe against the same vault answered with real paths. The two could not both be true, and they were: the app was running a `libcentraid_core_ffi.a` built five hours earlier, which had never heard of the request.

**The fix, and it is a habit rather than a patch.** Build the slice first, every time the Rust core changes:

```sh
cargo build -p centraid-core-ffi --target aarch64-apple-ios-sim   # simulator
cargo build -p centraid-core-ffi --target aarch64-apple-ios       # device
cargo build -p centraid-core-ffi --target x86_64-apple-ios        # intel sim
```

then the XCFramework, then the app. `mobile/README.md`'s iOS hand-off carries this as step 0 for the same reason.

**Why it is not wired into Gradle.** `-Pcentraid.coreFfiLibDir` exists so CI can hand in a slice built by `lane-prebuilt-core.yml` rather than paying for a Rust build on a Mac runner, and a Gradle task that shelled out to `cargo` would fight that override every time. The trade is deliberate; this document is its other half.

**How to tell, in one command.** Compare the archive's mtime against your last Rust edit:

```sh
ls -l target/aarch64-apple-ios-sim/debug/libcentraid_core_ffi.a
```

If it predates the change you are looking for, the app cannot contain it — stop debugging the Kotlin.

**Android has the same shape**, through a different path: `mobile/androidApp/src/main/jniLibs/<abi>/libcentraid_core_ffi.so` is a **copied file**, so it is staler still — nothing updates it until `mobile/scripts/ android-core.sh` is run again.

## The same defect one layer out: Xcode links an XCFramework Gradle never assembled

**The symptom.** You change Kotlin in `mobile/shared` — or a sub-agent does — run the Gradle task, build the app, run it, and the change is not there. The Gradle task succeeded. The Swift recompiled. The app installed. What runs is whatever Kotlin was last turned into an XCFramework, which on a fresh tree is *nothing*: the framework dependency simply does not resolve, and on a tree where it was assembled once it is as old as that assembly.

**The cause.** `mobile/iosApp/project.yml` names its framework dependency by path:

```
- framework: ../shared/build/XCFrameworks/debug/CentraidShared.xcframework
  embed: true
```

`:shared:linkDebugFrameworkIosSimulatorArm64` does not write that path. It links a plain `.framework` under `shared/build/bin/`, which nothing in the Xcode project consumes, and it leaves `build/XCFrameworks/debug/` exactly as it found it. Both halves succeed and the two never meet — a path dependency again, with nothing on either side that could notice the mismatch.

**The fix.** Assemble the artifact the project actually consumes:

```sh
cd mobile && ./gradlew -Pkotlin.native.enableKlibsCrossCompilation=true \
    :shared:assembleCentraidSharedDebugXCFramework
```

The `-Pkotlin.native.enableKlibsCrossCompilation=true` flag is not optional on a Mac: cinterop needs an Apple toolchain, so klib cross-compilation is off by default and back on here. `mobile/README.md`'s iOS hand-off carries this as step 1 for the same reason it carries the Rust slice as step 0.

**How to tell, in one command.** The XCFramework's mtime against your last Kotlin edit:

```sh
ls -ld mobile/shared/build/XCFrameworks/debug/CentraidShared.xcframework
```

Absent, or older than the change you are looking for, and the app cannot contain it — stop debugging the Swift.
