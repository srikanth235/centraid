---
name: mobile-verify
description: Prove changes to the mobile shells or the Rust core they link; use for mobile/, crates/core, crates/screens, crates/core-ffi, the mobile-jvm gate, emulator/simulator runs, Maestro, screenshots, or honest device-check hand-offs.
---

# Verifying a mobile change

Centraid's shells are Compose on Android and SwiftUI on iOS. They draw the `ViewState` from the Rust core and perform its `Effect`s. Behaviour is proved in Rust first, then through the JVM binding where relevant, and finally in a platform build or device run when that evidence is needed.

Use [the mobile command and capability reference](references/mobile-commands.md) as the canonical source for what this environment can run, exact commands, prerequisites, and working directories. Other skills should link there rather than maintain their own platform command lists. Consult [mobile pitfalls](references/pitfalls.md) when the relevant build or test failure occurs.

## Verification order

1. Prove behavior in Rust: `cargo test -p centraid-screens` and `cargo xtask rules` where relevant.
2. Run `cargo xtask gate --profile mobile-jvm` for the real ABI round trip and emitted-artifact drift check when the binding or linked core changes.
3. If Rust changed, rebuild the core for the target platform before building or running that shell. The app links a file by path; it will happily load an older archive or copied library.
4. Build and run the shell, then use the Maestro flow nearest the change when a device or emulator is available.
5. State exactly which layers ran. A build, a simulator, an emulator, and a physical device prove different things; do not call an unrun layer verified.

## Invariants and common traps

- Generated theme, catalogue, and kit-word files come from their source. Re-emit them with `bun contracts/tools/export-native-theme.ts`, format, and commit generated results; never edit outputs by hand.
- The iOS Xcode project is generated from `mobile/iosApp/project.yml`. Regenerate it after adding a Swift source or proto file. Swift protobuf sources themselves are generated in the Xcode build.
- `mobile-jvm` loads the built real cdylib and fails if it is absent. It tests the JVM binding, not Compose, Kotlin/Native, SwiftUI, or a device.
- Android's application module is included only with `-Pcentraid.android=true`; that build needs the Android SDK and JDK 21. Apple builds and simulator runs need macOS and Xcode.
- Physical-device performance evidence must name the reference device. An emulator or simulator does not establish those performance ceilings.
- Use the demo vault for app checks. Never seed a test from a live vault copy.

For the C ABI's normative rules and boundary invariants, see [core-ffi](../core-ffi/SKILL.md) and [its contract](../../../crates/core-ffi/CONTRACT.md).

## Final checklist

- [ ] Behaviour proven in Rust (`cargo test -p centraid-screens`, `cargo xtask rules`) where it lives there
- [ ] `cargo xtask gate --profile mobile-jvm` green
- [ ] Core rebuilt for each platform you ran (`ios-core.sh`, `android-core.sh`), with the mtime or `nm` check if the change does not show
- [ ] Emitted design and word files regenerated and committed, not edited by hand
- [ ] New iOS source or `.proto` file: `xcodegen generate` re-run
- [ ] Same selector id on both platforms and listed in `flows/selectors.md`
- [ ] Anything not run (simulator, emulator, device, snapshots) named as such, with the commands to hand off
