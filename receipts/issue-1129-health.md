# Issue #1129 — Health: the phone's daily totals in the vault

Worked as an umbrella by orchestration. One root agent planned it and ran five lanes as sub-agent sessions, each on its own branch and each merged into `claude/health-1129`:

- **R**: Rust, meaning the rung, the commands, the queries and the app crate.
- **K**: shared Kotlin, meaning the wire, the words, the follower, the machines and Home.
- **I**: iOS.
- **A**: Android.
- **Z**: this close.

The owner throttled the work to **one heavy build at a time** across the root and every lane, because the machine is shared with other umbrellas. Every Gradle run, `xcodebuild`, full `cargo test` and gate ran through one lock (`heavy.sh`).

The umbrella branched from `claude/phone-sync-1127` at c1a914ad8 and later merged #1127's two fixes (a6b891075, 2fa19cc23). The owner answered the issue's six questions on 2026-10-20. The rulings are R-1129-1 to 15 and the accepted lane proposals, recorded in [decisions.md](../docs/decisions.md#health-follows-the-phones-health-store-1129).

## What changed

- **Vault (lane R).** Rung three, `contracts/migrations/003_health.sql`, adds two tables:
  - `health_daily`: one stated total per subject, day and metric, with the unit in the metric's name.
  - `health_workout`: the health half of a `core_activity`.

  The rung also seeds the `health:workout-kinds` scheme's eight kinds under fixed ids, adds the page index `core_activity_started_page_idx`, and rebuilds `core_activity` as mutable. Rung two was amended in place to admit the `health` source, which maps to `core.activity`.

  Lane R also added three commands (`health.record_days`, `health.follow_workout`, `health.purge_workout`), six app queries on the wire (`health.proto`, arms 120 to 125), and the `centraid-apps-health` crate, which computes every figure a screen draws (typicals, ranges, series, trends, best bucket). It fixed three files the base left unformatted and two clippy findings. Files:
  - `contracts/migrations/002_phone_link.sql`, `contracts/migrations/003_health.sql` (new), `contracts/schema/v0-registries.json`, `contracts/schema/vault-ddl.sql` (regenerated)
  - `crates/vault/src/migrations.rs`, `crates/vault/src/commands/health.rs` (new), `crates/vault/src/commands/mod.rs`, `crates/vault/src/commands/core.rs`, `crates/vault/src/commands/phone.rs`, `crates/vault/src/commands/people.rs`, `crates/vault/src/commands/schedule.rs`, `crates/vault/README.md`
  - `crates/vault/tests/health_schema.rs` (new), `crates/vault/tests/health_commands.rs` (new), `crates/vault/tests/baseline.rs`, `crates/vault/tests/common/mod.rs`, `crates/vault/tests/people_commands.rs`, `crates/vault/tests/phone_link_schema.rs`, `crates/vault/tests/phone_commands.rs`, `crates/vault/tests/commands.rs`, `crates/vault/tests/schedule_commands.rs`, `crates/vault/tests/media_commands.rs`, `crates/ontology/tests/commitments.rs`
  - `crates/api-proto/proto/centraid/core/v1/health.proto` (new), `crates/api-proto/proto/centraid/core/v1/app_query.proto`, `crates/api-proto/build.rs`, `crates/api-proto/tests/roundtrip.rs`
  - `crates/apps/health/**` (new crate), `crates/core/Cargo.toml`, `crates/core/src/app_query.rs`, `crates/core/src/app_query/health.rs` (new), `crates/core/src/app_query/health_tests.rs` (new), `Cargo.toml`, `Cargo.lock`, `scripts/security/rust-unsafe-ledger.json`, `ARCHITECTURE.md`
- **Shared Kotlin (lane K, with K5 and K6).** Lane K put Health's screens on `screen.proto` and its words in `copy/health.json`, and added the `olive` hue (110) and its catalogue entry. It added the follower's fourth source (`PhoneSource.HEALTH`):
  - `HealthDays` sends only the days that moved.
  - Workouts follow through `PhoneSync`.
  - The window is derived from what the vault holds.

  Lane K also wrote the machines for Today, Trends, Workouts, a metric, a workout and Connect, and Home's tile. K5 keeps a workout that is gone from the phone, unlinked (R-1129-14). It also re-finds a lost `local:` workout by match in the same pass (R-1129-15, through `PhoneAction.Refind` and `PhoneStore.refindLost`). K6 gives each workout kind its own mark and keeps chart ticks from colliding. Files:
  - `copy/health.json` (new), `crates/api-proto/proto/centraid/screen/v1/screen.proto`, `DESIGN.md`, `contracts/tools/export-native-catalog.ts`, `design/native-catalog.json`, `design/native-theme.json`, `packages/design/src/apps.ts`, `packages/design/src/identity.test.ts`, `packages/design/src/palette.ts`, `mobile/README.md`, `mobile/iosApp/Design/Catalog.swift`, `mobile/iosApp/Design/Theme.swift`
  - New, under `mobile/shared/src/commonMain/kotlin/dev/centraid/shared/`:
    - `apps/health/`: `HealthBridges.kt`, `HealthConnect.kt`, `HealthConnectBridge.kt`, `HealthDays.kt`, `HealthFold.kt`, `HealthFollow.kt`, `HealthHome.kt`, `HealthImport.kt`, `HealthKinds.kt`, `HealthMetric.kt`, `HealthMetrics.kt`, `HealthQuery.kt`, `HealthRouting.kt`, `HealthStore.kt`, `HealthWorkoutPage.kt`
    - `kit/time/LocalDays.kt` and `shell/HomeHealthTile.kt`
  - Changed, under `mobile/shared/src/commonMain/kotlin/dev/centraid/`: `design/Catalog.kt`, `design/Tokens.kt`, `shared/nav/Navigation.kt`, `shared/nav/RowRoutes.kt`, `shared/nav/ScreenIds.kt`, `shared/nav/ScreenOpening.kt`, `shared/platform/PlatformServices.kt`, `shared/shell/HomeReads.kt`, `shared/shell/HomeRuntime.kt`, `shared/shell/HomeTileWords.kt`, `shared/shell/PhoneFollowWords.kt`, `shared/shell/SpringboardPolicy.kt`, `shared/sync/phone/PhoneModel.kt`, `shared/sync/phone/PhonePlan.kt`, `shared/sync/phone/PhoneSync.kt`
  - Changed, the two platform halves: `mobile/shared/src/androidMain/kotlin/dev/centraid/shared/platform/PlatformServices.android.kt` and `mobile/shared/src/iosMain/kotlin/dev/centraid/shared/platform/PlatformServices.ios.kt`
  - Specs under `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/`. New: `HealthDaysSpec.kt`, `HealthFollowSpec.kt`, `HealthScreensSpec.kt`. Changed: `AppReadsSpec.kt`, `AppRoutingSpec.kt`, `CatalogSpec.kt`, `ChangeStreamSpec.kt`, `ChatScopeSpec.kt`, `FakePhoneStore.kt`, `HomeMachineSpec.kt`, `KitTimeMoneyCopySpec.kt`, `NativeThemeSpec.kt`, `ScreenOpeningsSpec.kt`, `ScreenQueryRuntimeSpec.kt`, `ScriptedCore.kt`
- **iOS (lane I).** A HealthKit reader that asks only to read, at Connect's tap. The SwiftUI screens and the Home tile. A separate seeder app that fills a simulator's Health, and two Maestro flows. Files:
  - New, under `mobile/iosApp/Sources/Health/`: `HealthKitReader.swift`, `HealthAccess.swift`, `HealthScreens.swift`, `HealthHomeView.swift`, `HealthMetricView.swift`, `HealthWorkoutView.swift`, `HealthConnectView.swift`, `HealthParts.swift`
  - Changed: `mobile/iosApp/Sources/ShellModel.swift`, `mobile/iosApp/Sources/HomeView.swift`, `mobile/iosApp/Sources/Kit/ScreenRegistry.swift`, `mobile/iosApp/project.yml`, `mobile/iosApp/Resources/Centraid.entitlements`, `mobile/iosApp/Resources/Info.plist`
  - New test: `mobile/iosApp/Tests/HealthSleepMergeTests.swift`
  - New seeder, all under `mobile/iosApp/HealthSeeder/`: `project.yml`, `Sources/HealthSeederApp.swift`, `HealthSeeder.entitlements`, `Info.plist`
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/HealthKitReadOnlySpec.kt` (new), `mobile/maestro/flows/health-connect.yaml` and `health-seed.yaml` (new), `mobile/maestro/flows/selectors.md`, `mobile/README.md`
- **Android (lane A).** A Health Connect reader that uses aggregates and `ExerciseSessionRecord` and merges sleep into nights. `READ_*` permissions and the rationale activity. The Compose screens and the Home tile. minSdk stays 24, and every client call is gated on API 26. Files:
  - New: `mobile/androidApp/src/main/kotlin/dev/centraid/android/kit/HealthConnectReader.kt`, and under `mobile/androidApp/src/main/kotlin/dev/centraid/android/screens/health/`: `HealthConnectAct.kt`, `HealthRationaleActivity.kt`, `HealthParts.kt`, `HealthScreens.kt`, `HealthPages.kt`, `HealthRoutes.kt`
  - Changed, under `mobile/androidApp/src/main/kotlin/dev/centraid/android/`: `MainActivity.kt`, `kit/PhoneFollow.kt`, `screens/HomeScreen.kt`
  - Changed elsewhere: `mobile/androidApp/src/main/AndroidManifest.xml`, `mobile/androidApp/build.gradle.kts`, `mobile/androidApp/gradle.lockfile`, `mobile/gradle/libs.versions.toml`, `copy/health.json`, `mobile/README.md`
  - `mobile/shared/src/jvmTest/kotlin/dev/centraid/shared/HealthConnectReadOnlySpec.kt` (new)
- **Close (lane Z).**
  - `docs/decisions.md`: the Health section, and R-1127-3, R-1127-10 and R-1099-23 marked as amended.
  - `docs/vault-ontology.md`: three rungs, 95 base tables, the `health` pack row, the phone band's fourth source, health's return under ONT-06, five commitments, R8, ONT-43, and the declared-lifecycle line recounted from the registry.
  - `CHANGELOG.md`, `README.md`, `ARCHITECTURE.md`, `docs/glossary.md`, `docs/design-machinery.md`, `mobile/README.md`, and this receipt.
  - `crates/api-proto/build.rs`: `HealthHomeState.content.data` and `HealthMetricState.content.data` are boxed, as every other app's large data arm is. The pr gate's clippy step refused them as `large_enum_variant`.

No file was deleted.

## Verification

**At the close**, on `claude/1129-lane-z`, which is the umbrella with every lane, K6 and the close's docs:

```sh
cargo xtask doc-links
```

Outcome: pass, 0 findings.

The gate runs from the close are recorded in the next section.

**By the lanes**, each on its own branch and target directory:

```sh
cargo test -p centraid-vault; cargo test -p centraid-ontology
cargo test -p centraid-apps-health -p centraid-core; cargo test -p centraid-core-ffi
cargo test -p centraid-vault --test ladder_ddl
```

Outcome (lane R): pass. `vault-ddl.sql` regenerates with no diff. Lane R's `cargo xtask gate --profile local` passed fmt, clippy, the whole workspace's tests (2,688 s), the restore drill, doc-links and ledgers. Its one red was `rules`, on the base's `crates/core/src/api.rs` (F-R-4), which #1127 has since fixed upstream (64a5e163c).

```sh
./gradlew --no-daemon :shared:jvmTest
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home cargo xtask gate --profile mobile-jvm
```

Outcome (lane K): pass. 1,575 tests passed after K5, and HealthScreensSpec's 16 passed after K6. The mobile-jvm gate passed after K5 (81.6 s) and again after K6. `bun run lint:copy`, the design package's 391 vitest tests and its typecheck all passed.

```sh
xcodebuild … Centraid build test   # on simulator "Centraid Health 1129"
maestro test mobile/maestro/flows/health-seed.yaml mobile/maestro/flows/health-connect.yaml
```

Outcome (lane I): pass. The iOS app and the HealthSeeder built. 120 XCTests ran with 0 failures, `HealthSleepMergeTests` among them. Both Maestro flows passed, and the mobile-jvm gate passed in 167 s.

```sh
./gradlew --no-daemon -Pcentraid.android=true :androidApp:assembleDebug :androidApp:lintDebug
```

Outcome (lane A): `BUILD SUCCESSFUL`. lintDebug reports no errors at minSdk 24, after one `NewApi` fix. `HealthConnectReadOnlySpec` passed 6/6. The mobile-jvm gate passed every step but took 518.9 s cold, over its 420 s budget; the warm rerun passed in 35.8 s.

**Checked by hand (lane I).** The simulator was "Centraid Health 1129" (iPhone 17 Pro, iOS 26.5, UDID 633B061C-478F-4037-A746-FCC3F3DB930A). It is shut down, not deleted.

- The seeder wrote a deterministic year of data.
- Connect led to Today. Trends, the metric pages (week, month and year), Workouts, one workout, More, "What Health may read", Connect, the Stop confirmation, Cancel and Stop were all seen.
- The 7-day re-read worked. After a seeder `-extra` run, Home's tile went from 353 to 2,353 steps, a "Night walk" appeared under today's Workouts, and active energy went from 17 to 243 kcal.
- A second seeder run replaced the day's steps and did not double them.
- Exercise minutes cannot be seeded on iOS, because an app cannot write `appleExerciseTime`.

The screenshots, `00-seeder-done.png` to `17-after-stop.png`, are in the root's notes folder, `health-1129/screens/`.

**Falsified by the lanes.** Each check below was broken on purpose, seen to fail, and reverted.

| Check broken on purpose | What went red |
| --- | --- |
| `CHANGED_AFTER_THE_CORPUS` emptied | `commitments.rs` |
| Rung three copies `updated_at = now` | the climb test |
| `record_days` treats every value as changed | `reading_the_same_week_twice_writes_nothing` |
| `HealthImport.number` uses `toString` | the round-trip test, with a `phone.detach` |
| The zero guard removed | the revoked-type case |
| A `toShare` type added in `HealthAccess` | `HealthKitReadOnlySpec` |
| A `WRITE_WEIGHT` permission added to the manifest | `HealthConnectReadOnlySpec` |

**Not verified:**

- The Android shell has not run on a device or emulator. Running it needs `android-core.sh`'s cold cross-compile, which also ignores `CARGO_TARGET_DIR` (F-A-2), and that would have held the shared lock too long.
- No real watch's late upload was seen. The seeder's rerun stands in for one.
- The line naming a refused type was not exercised by hand on either shell. The specs hold its logic.

## The gates at the close

Run one at a time through the owner's lock, on `claude/1129-lane-z` after the merge of the umbrella at 71e6a3d47, with `CARGO_TARGET_DIR` set per lane.

```sh
cargo xtask gate --profile pr        # first run, cold tree
```

Outcome: fail, 1,037 s of a 1,500 s budget. Every step but three passed: fmt, the restore drill, rules, doc-links, ledgers, buf, ci-policy, secrets, osv, release-build (279 s), ts-static, emitters, lockfile, call-budget and fault-door. The three that failed:

- **clippy**, `large_enum_variant` on Health's two screen data arms. This was new from lane K's `screen.proto`: lane R's clippy ran before those messages existed, and the mobile-jvm gate does not run clippy. Fixed in 37c75dd2a.
- **test**, `centraid-gateway server::bonjour::tests::dns_sd_is_run_with_the_registration_and_withdrawn_when_dropped`, which read an empty args file (log `target/xtask/pr/test/stderr.log`). It is inherited, since `crates/gateway` is untouched by #1129. It is a race: the test waits for `noted.args` to exist, and the shell's redirection creates the file before `echo` writes it. Run alone, it passes 3 of 3. It is filed here as a flake to fix (wait for content, not existence), not re-run until green.
- **deny**, RUSTSEC-2026-0382 in `rustls-webpki` 0.103.15 (via `tokio-rustls` → `centraid-gateway`). It is inherited: `main` and the base pin the same version, and the advisory is new. The fix is `cargo update -p rustls-webpki` to 0.103.16 or later, which this umbrella did not take.

```sh
cargo xtask gate --profile pr        # after 37c75dd2a
```

Outcome: fail, 299 s. clippy passed. Two steps failed:

- **deny**, as above.
- **test**, `centraid-core-ffi::spike the_c_harness_crosses_the_abi_ten_thousand_times`. The C harness links the first cdylib it finds. With no debug cdylib in the target, it took the **release** one the first run's release-build step left, and Apple's `ld` refused that file: "mis-aligned LINKEDIT string pool". On the cold first run there was no cdylib, so the test skipped. `crates/core-ffi` is untouched by #1129.

```sh
cargo build -p centraid-core-ffi && cargo nextest run --workspace --no-fail-fast
```

Outcome: pass, 3,265 tests run, 3,265 passed, 6 skipped (396 s). The spike passed against the debug cdylib, and the bonjour test passed this time.

```sh
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home cargo xtask gate --profile mobile-jvm
```

Outcome: pass, 120.5 s of 420 s. The tree was clean afterwards.

```sh
cargo xtask rules; cargo xtask doc-links; CENTRAID_GATE_STAMPS=0 bun run check:push:static
```

Outcome: pass. rules passed all four checks, doc-links reported 0 findings, and the static tier passed 4 of 4.

`node .governance/law/run.mjs` reports one red rule, `receipt-per-issue`, and only on #1127's receipt, which has no `## Audit`. That receipt is outside #1129.

## Decisions

- The rulings are in [decisions.md](../docs/decisions.md#health-follows-the-phones-health-store-1129):
  - the owner's answers 1 to 6 of 2026-10-20;
  - R-1129-1 to 15;
  - the accepted proposals RP-R-1 to 7, RP-K-1 to 18, RP-A-1 to 11, RP-I-1 and RP-I-3 to 7.

  The table there leaves out the proposals that only count or render (RP-K-16, RP-A-11, RP-I-4, RP-I-5).
- Earlier rulings this one amends:
  - R-1129-14 amends R-1127-3 for Health.
  - R-1129-15 extends R-1127-10.
  - R-1129-10 amends R-1099-23's "no ninth hue", for the app ring only.
- The ontology's departures are ONT-43 in [vault-ontology.md](../docs/vault-ontology.md).
- Corrections to the plan:
  - R-1129-2 purged a workout that left the phone. That became R-1129-14's keep, once F-K-1 showed a new phone would purge every workout.
  - R-1129-9 lost "Write a note about it" (RP-K-9).
  - The brief's three home screens became one screen, `health.home`, with a band (RP-K-1).

## The issue's "Done when"

| Condition | Status |
| --- | --- |
| A member taps Connect, grants the types they choose, and sees today's and the past year's totals, on iOS and Android | **iOS: met** on the simulator. Connect led to Today, and the past year showed on the metric's Year page. **Android: not met.** It compiles and is lint-clean, but has not run. |
| A new day's steps and a new workout appear on the next foreground, and a late upload corrects an earlier day without duplicating it | **Met on the iOS simulator** (the `-extra` re-read), and held by `a_late_upload_moves_its_one_day_once` and `HealthDaysSpec`. Not seen on Android or with a real watch. |
| Nothing is written to the health store, and a refused type is skipped and named | **Met in code and specs** (`HealthKitReadOnlySpec`, `HealthConnectReadOnlySpec`; R-1129-6, RP-A-4, RP-K-13). The line naming a refused type was not exercised by hand. |
| JVM specs for the `health` snapshot-to-plan pass, Rust tests for the rung and commands, and a Maestro flow for Connect → Today | **Met.** `HealthFollowSpec` and `HealthDaysSpec`; `health_schema.rs` and `health_commands.rs`; `health-connect.yaml` (iOS). |
| docs/vault-ontology.md records the domain's return under ONT-06 with its consumer; rulings in decisions.md; one receipt | **Met** by lane Z. |

## Inherited red

| Red at the base | Fixed by |
| --- | --- |
| `cargo fmt --check` in three #1127 files; clippy `type_complexity` in `media_commands.rs` | Lane R (185872805, e4d213183), and upstream in #1127 (edc82db5e, merged as 2fa19cc23) |
| `cargo xtask rules`: `sql-confinement` in `crates/core/src/api.rs` | Upstream in #1127 (64a5e163c, merged as a6b891075) |
| iOS did not compile at 51ed0a60c: `TileBody.health` was missing from `HomeView`'s switch | Lane I (e4864476c) |
| `node scripts/lint-native-controls.mjs`: native alerts in #1127's Docs and onboarding views | **Not fixed.** It is not in `check:push:static` (F-A-1) |
| `cargo deny`: RUSTSEC-2026-0382, `rustls-webpki` 0.103.15 (same on `main`) | **Not fixed.** It needs `cargo update -p rustls-webpki` |
| The gateway's bonjour test races its own fake tool (existence before content) | **Not fixed.** It is a flake to file. It passes alone and in the full run |
| The core-ffi spike links a release cdylib that Apple's `ld` refuses | **Not fixed.** It is environmental. It passes against the debug cdylib |

## Known gaps, for the owner

- **F-K-1: a new phone with a restored vault.** The phone sees the old phone's `local:` contact and event links as lost. It trashes them, or asks the vanish question, and then adds the new phone's records beside them. R-1129-15 covers Health. For contacts, calendar and files, the options are:
  - (a) put a device id on the origin, so another device's links are forgotten at the first pass (recommended);
  - (b) forget every `local:` link on a restore;
  - (c) re-find by match, as Health does.
- **F-R-1: `chat_message` has no `row_version`.** The registry marks it mutable, but the ladder head gives it no `row_version`. Either give it one, or declare it append-only with its two guarded columns.
- **RP-I-2: the first-launch picture.** The iOS first-launch picture shows seven marks, without Money or Health. Adding Health alone would make eight, which fills the 4-column grid exactly. Adding Money as well would make nine.
- **RP-K-2 and RP-K-6: strictness of R-1129-12.** A `tz` on the health requests would let the core place the phone's day. A delta in `health.proto` would keep R-1129-12 strict.
- **The mobile-jvm gate's 420 s budget.** It was overrun under load (441 s, and 518.9 s cold), with every step green.
- **Tooling.** `mobile/scripts/android-core.sh` ignores `CARGO_TARGET_DIR` (F-A-2), and `lint-native-controls` is red at the base (F-A-1).
- **Deferred to later waves:**
  - per-km splits and "Write a note about it" (R-1129-9);
  - background delivery: iOS `HKObserverQuery` and Android `READ_HEALTH_DATA_IN_BACKGROUND` (F-A-6). Until then, a pass runs only while the app is in front;
  - heart-rate variability, mindful minutes and cycle tracking (owner answer 2);
  - a glyph of its own for each workout kind (RP-K-17);
  - the published ontology page's §03 (ONT-01).
- **Small Android issues.** Connect's asked set is `remember`ed, not saved (F-A-4). A refusal shows on Health's next open, not at once (F-A-5).
- **Android has not run.** No device or emulator has run it.

## After the close: the owner's answers (2026-10-21)

The owner asked for every open point to be worked on this branch. The root ran three more lanes: R2 (the bonjour race and F-R-1), M2 (`lint-native-controls` and the first-launch picture), and P (F-K-1). It worked the rest itself, and an independent auditor checked #1127's receipt. The owner's throttle still held: one heavy build at a time.

**What changed, point by point**

| Open point | What landed | Commits |
| --- | --- | --- |
| RUSTSEC-2026-0382 | `rustls-webpki` 0.103.15 → 0.103.16, in `Cargo.lock` only. The resolver also moved `tempfile`'s `getrandom` from 0.4.3 to 0.3.4, and `cargo deny` is clean over the result | d8ee957be |
| F-A-2: `android-core.sh` ignored `CARGO_TARGET_DIR` | It copies from `${CARGO_TARGET_DIR:-$root/target}`, a relative one read from the workspace root | 82edbb5af |
| RP-K-2 and RP-K-6: the strictness of R-1129-12 | **R-1129-16.** All six Health requests carry `tz`, under Agenda's zone rule. The core answers several things the shell used to work out: today, today's bounds, each workout's `local_start`, `local_end` and `length_sec`, the follower's window (`window_from`, moved from Kotlin into `crates/apps/health`), and the differences (`change`/`change_pct`, `versus_typical`/`versus_typical_pct`). `kit/time/LocalDays.kt` and `DeviceClock.offsetMinutesAt` are deleted, and the three platform clocks are back to their base. A workouts read takes its zone as a decoration (`zone_if_any`), so the follower's store reads work without one. The six arms joined the shell's zone pre-check (`AppQueryRequest.zone()`). That last fix was missed in 04acff0ab, which ran only the Health specs, so `ScreenQueryRuntimeSpec`'s zone pre-check case was red from 04acff0ab until lane P found it. It landed inside merge 6237f9a09 together with R-1129-19's text, and the merge's message names neither. | 04acff0ab, 6237f9a09 |
| F-R-1: `chat_message` had no `row_version` | **R-1129-17.** Rung four, `contracts/migrations/004_chat_message_version.sql`, rebuilds the message and its two children, keeping every row. The chat commands stamp `updated_at`. The `row_version` commitment now reads every registered table the corpus lacks at the ladder head. | 5704181cd, a1a8bc98c |
| RP-I-2: the first-launch picture | **R-1129-18.** Shared `FirstLaunch.APPS` is Home's `SPRINGBOARD_ORDER`. iOS draws it five to a row, and Android now draws the marks too. `FirstLaunchRosterSpec` holds both to the roster. | d28d19145, a3dfa9119 |
| F-A-1: `lint-native-controls` red at the base | #1127's three system alerts and Android's raw `AlertDialog` (in `kit/`, unseen by the lint) became the kit's `ConfirmSheet` and a new `NoticeSheet`. Keep is still the default. | 5ba3d303c |
| F-K-1: a new phone with a restored vault | **R-1129-19.** A `local:` link names its device (`phone_link.device_id`; an origin's `device_id` is the device that last read it), in rung two, amended in place. The device id is minted once per install into `SecureStore`, never in the vault. Another device's link is re-found one to one by the match key its fingerprint remembers (fingerprint v3), and is moved with the new command `phone.relink`. If nothing matches, the link is forgotten and its row kept; it is never trashed or counted by the vanish guard. A shared key pairs nothing. | 0472f2e64, 5a462e4bb, 6237f9a09 |
| The gateway's bonjour flake | A just-written executable's first run on macOS is checked first (about 0.5 s alone, 7.7 s for sixteen at once), and the fake `dns-sd` overran its fixed 3 s and 5 s windows. `start_after` now returns when the tool exits, a fake's first run gets a 60 s ceiling, and the notes are read only once a line is complete. New trap: `docs/traps/fresh-executable-first-exec.md`. Before: 3 of 30 lib runs failed, and 197 of 200 contended runs. After: 0 of 30 and 0 of 200. | 3d2be39f1 |
| #1127's receipt had no `## Audit` | An independent, read-only audit: PASS, with caveats, written into that receipt. `PhoneModel.kt`'s stale `file:` comment is fixed. `receipt-per-issue` is green. | ebb33e441 |
| The mobile-jvm gate's 420 s budget | Not raised. On an idle machine (load 2): **235.7 s cold, 34.3 s warm**. Under load it ran over: 441 s and 518.9 s in the first wave, then 453.2 s cold in lane M2 and 568 s cold in lane P, while several heavy builds ran. | — |

**Verification at the new tip**, every heavy run through `heavy.sh`, one at a time:

```sh
cargo xtask gate --profile pr
```

PASS, 1186.0 s of 1500 s, cold. Every step is green, `deny` and the whole workspace's nextest included (the bonjour tests too), and `release-build` took 291.9 s.

```sh
cargo xtask gate --profile mobile-jvm
```

PASS: 235.7 s cold and 34.3 s warm. `:shared:jvmTest` ran 1,614 tests with 0 failures. The tree was clean after it.

```sh
xcodebuild -scheme Centraid … test   # core slice, XCFramework (-Pcentraid.iosSimulatorOnly=true), xcodegen
```

TEST SUCCEEDED: 120 tests, 0 failures, on "Centraid Health 1129" (633B061C-478F-4037-A746-FCC3F3DB930A).

```sh
mobile/scripts/android-core.sh && ./gradlew -Pcentraid.android=true :androidApp:assembleDebug :androidApp:lintDebug
```

BUILD SUCCESSFUL.

```sh
maestro test first-launch.yaml onboarding.yaml health-connect.yaml
```

All three PASS on a fresh install of the new build, over the simulator's seeded Health. Today read "Wed 21 October", the core's day in the phone's zone. Workouts drew the core's wall clocks (00:24 today, then weekdays, then months). The screenshots are in the notes folder's `screens/close/`.

Lane checks, as each lane reported them (lane R2 kept no notes file, so its figures rest on its report and on 3d2be39f1's commit message):
- `cargo nextest -p centraid-ontology -p centraid-vault`: 676 of 676 pass (R2).
- `cargo test -p centraid-vault -p centraid-core`: green, with the ladder DDL check (P).
- `NewPhoneSpec`: 15 cases. `FilesFollowSpec` gains 3 and `HealthFollowSpec` 4 restored-phone cases (P).
- `lint-native-controls`: clean, and its own tests pass 6 of 6 (M2).
- iOS and Android compiled after M2's Swift and Compose changes (M2).

**Still open, for the owner**

- **Android has not run.** It is compiled and linted only, and no device or emulator has run it. The new sheets and first-launch marks have not been looked at on Android.
- **Health's `connected` on a restored phone.** It reads any `health` origin, so a restored phone shows Health connected until the old phone's origin retires (R-1129-19's cost).
- **ONT-42's fifth departure.** The link band now records which phone wrote a link.
- **F-K-1's tests were written beside the fix**, not run red first.
- **Deferred, unchanged:** splits, "Write a note about it", background delivery, HRV, mindful minutes and cycle tracking, a glyph per workout kind, and the published page's §03.

## Audit

PASS (independent auditor, 2026-10-21). The file list matches `git diff c1a914ad8..9366dc296` once #1127's merged files (`crates/vault/src/page.rs`, `receipts/issue-1127-phone-sync.md`) are set aside. The lane notes support the verification numbers, the screenshots and the falsifications. The five commitments' mechanisms and named tests are present. The iOS and Android sources contain no write path. Health is in no Chat scope list. Android remains unrun, as stated.
