# A shell links a Rust core nothing rebuilt

**The symptom.** You change `crates/core` or `crates/screens`, rebuild the app, run it — and the change is not there. No error, no warning, no stale-build notice. The Swift or Kotlin recompiled, the app installed. The behaviour is the one from whenever you last built the core for that platform.

**The cause.** Both shells take the Rust core as a _built file_, by path, and neither build system knows how it is made:

- **iOS** links `libcentraid_core_ffi.a` by a **path into `target/<triple>/<profile>/`** (`mobile/iosApp/project.yml`; the header is the committed `crates/core-ffi/include/centraid.h`, mapped to the Swift module `CentraidCoreC` by `iosApp/CoreBridge`). It is a path and not a dependency, so Xcode has no input to compare, nothing rebuilds it, and the linker is perfectly happy to link a five-hour-old archive. `mobile/scripts/ios-core.sh` is the one command that builds the slices.
- **Android** loads `libcentraid_core_ffi.so` by JNA from `mobile/androidApp/src/main/jniLibs/<abi>/`, a **copied file**, so it is staler still: nothing updates it until `mobile/scripts/android-core.sh` runs again.
- **The JVM tests** (`:core:jvmTest`) resolve the cdylib from `-Pcentraid.coreLibDir`, then `$CARGO_TARGET_DIR/debug`, then `<repo>/target/debug`, and the `mobile-jvm` gate builds it first, so they cannot go stale.

**What it looks like when it bites.** A byte door was added to `crates/core` and wired through both shells in one pass. Every layer compiled. On the simulator the Photos mosaic drew four empty cells. The request was built correctly with the right content ids; a Rust probe against the same vault answered with real paths. The two could not both be true, and they were: the app was running a `libcentraid_core_ffi.a` built five hours earlier, which had never heard of the request.

**The fix, and it is a habit rather than a patch.** Build the core for the platform first, every time Rust changes:

```sh
mobile/scripts/ios-core.sh                       # all three iOS slices
mobile/scripts/ios-core.sh aarch64-apple-ios-sim # the simulator only
mobile/scripts/android-core.sh                   # arm64-v8a into jniLibs (x86_64 for an Intel emulator)
```

then the app. `mobile/README.md`'s iOS hand-off carries this as step 0 for the same reason.

**`--features llama` is part of the habit, and leaving it off fails the same silent way.** The on-device chat's engine (llama.cpp) is off by default so that the PR gate's workspace build compiles none of it ([R-CHAT-10](../decisions.md#the-assistant)). Both scripts build with it. A core built without the feature links, loads and runs, and the chat reports every model file as `NO_ENGINE` — the screen that says this build cannot run the assistant. The check is the same `ls -l` below, and then `nm <archive> | grep -c llama_` (zero means no engine).

**Why nothing builds it for you.** `lane-prebuilt-core.yml` builds the slices for CI so a Mac runner does not pay for a Rust build on every app build, and a build step that shelled out to `cargo` would fight that. So building the core stays this habit.

**How to tell, in one command.** Compare the file's mtime against your last Rust edit:

```sh
ls -l target/aarch64-apple-ios-sim/debug/libcentraid_core_ffi.a
ls -l mobile/androidApp/src/main/jniLibs/arm64-v8a/libcentraid_core_ffi.so
```

If it predates the change you are looking for, the app cannot contain it — stop debugging the Swift and the Kotlin.
