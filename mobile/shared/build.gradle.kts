// `:shared` — the screens, the navigation model, the sync scheduler
// (#1020, D-1020-E1, D-1020-E3, D-1020-E4, D-1020-E7).
//
// `commonMain` holds state machines and nothing else: no platform import, no
// SQL, no view. That is not tidiness — it is what keeps the Kotlin/Native link
// short (census §E9) and what the Konsist rule in `jvmTest` enforces with a
// demonstrated red.

plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.wire)
    alias(libs.plugins.kover)
}

val androidEnabled = providers.gradleProperty("centraid.android").orNull == "true"

val repositoryRoot = rootProject.extra["repositoryRoot"] as java.io.File

// The Android target, configured by name for the reason `:core`'s build file
// records in full: the Kotlin DSL generates no typed accessors for a plugin that
// is only conditionally on the classpath, and declaring AGP in `plugins {}`
// would resolve it on machines with no Android SDK.
if (androidEnabled) {
    pluginManager.apply("com.android.kotlin.multiplatform.library")
    (kotlin as ExtensionAware).extensions.getByName("androidLibrary").withGroovyBuilder {
        setProperty("namespace", "dev.centraid.shared")
        setProperty("compileSdk", 36)
        setProperty("minSdk", 24)
        "withHostTest" { }
    }
}

kotlin {
    jvm()

    // WHERE THE FIVE SYMBOLS COME FROM (#1020, hand-off 1.2).
    //
    // A debug framework is DYNAMIC (below), so `ld` resolves `centraid_open`
    // and its four siblings at framework-link time rather than deferring them
    // to the app. `centraid.def` deliberately carries no `staticLibraries`,
    // because cinterop would then demand the artifact on every machine that
    // merely COMPILES Kotlin. The link is the one step that genuinely needs
    // it, so the path is named here and nowhere else.
    //
    // `cargo build -p centraid-core-ffi --target <triple>` produces it.
    // `-Pcentraid.coreFfiLibDir` overrides the directory for CI, which takes
    // the slice from `lane-prebuilt-core.yml` rather than rebuilding it.
    val coreFfiProfile = (findProperty("centraid.coreFfiProfile") as String?) ?: "debug"
    val rustTargetDir = rootProject.layout.projectDirectory.dir("../target")
    val rustTripleOf = mapOf(
        "iosArm64" to "aarch64-apple-ios",
        "iosSimulatorArm64" to "aarch64-apple-ios-sim",
        "iosX64" to "x86_64-apple-ios",
    )

    // THE XCFRAMEWORK IS WHAT XCODE CONSUMES (#1020, wave A).
    //
    // `iosApp/project.yml` names
    // `shared/build/XCFrameworks/debug/CentraidShared.xcframework`, and no task
    // produced one: the three `binaries.framework` blocks below each build a
    // single-slice framework, which is not what a `binaryTarget` can resolve.
    // `xcodebuild` said so the first time it ran, and nothing before that could
    // have. The default output directory is exactly the path `project.yml`
    // already expected, so this adds the missing producer and moves no path.
    // `XCFrameworkConfig`, not the `XCFramework(...)` helper: Kotlin 2.4.20
    // exposes the config class and no top-level function of that name.
    val xcframework =
        org.jetbrains.kotlin.gradle.plugin.mpp.apple.XCFrameworkConfig(project, "CentraidShared")

    listOf(iosArm64(), iosSimulatorArm64(), iosX64()).forEach { target ->
        target.binaries.framework {
            baseName = "CentraidShared"
            xcframework.add(this)
            val slice = (findProperty("centraid.coreFfiLibDir") as String?)
                ?: rustTargetDir.dir("${rustTripleOf.getValue(target.targetName)}/$coreFfiProfile").asFile.path
            // `-force_load`, NOT `-L` + `-l`, and the difference is the whole
            // binding (#1020, wave A).
            //
            // Apple's linker drops the members of a static archive that nothing
            // in the link references, and NOTHING references these: cinterop
            // generates the Kotlin side of the five symbols, and a `@Suppress`d
            // declaration is not a reference the linker can see. So the
            // archive was searched, matched nothing, and the framework shipped
            // with `_centraid_open` and its four siblings UNDEFINED in both
            // architectures — a framework that loads and then traps the moment
            // a screen asks the vault anything.
            //
            // It was invisible for the same reason every other Gate 0 defect
            // was: the link succeeded, the app built, the app ran, and nothing
            // called the core until this wave wired a read.
            linkerOpts("-force_load", "$slice/libcentraid_core_ffi.a")
            // DYNAMIC IN DEBUG, STATIC IN RELEASE (#1020 Tooling coverage).
            //
            // The podspec precedent in v0 was `static_framework = true`
            // unconditionally (census §G5), so the debug half is new and it is
            // the half that pays: a dynamic framework relinks in seconds where
            // a static one relinks the whole binary, and an iOS developer
            // rebuilds far more often than they ship.
            isStatic = buildType == org.jetbrains.kotlin.gradle.plugin.mpp.NativeBuildType.RELEASE
            // The ABI binding travels INTO the framework: SwiftUI holds a
            // `CentraidCore` and never a pointer.
            export(dependencies.project(":core"))
        }
    }

    jvmToolchain(21)

    applyDefaultHierarchyTemplate()

    sourceSets {
        commonMain.dependencies {
            api(project(":core"))
            implementation(libs.wire.runtime)
            implementation(libs.kotlinx.coroutines.core)
        }
        // WORKMANAGER BELONGS TO THE SOURCE SET THAT USES IT (#1020, wave A).
        //
        // `PlatformServices.android.kt` is `:shared`'s androidMain and schedules
        // the sync pass; `androidx.work` was declared only in `:androidApp`, so
        // the first machine with an Android SDK could not resolve a single
        // symbol in that file. Under the AGP 9 KMP library plugin dependencies
        // are declared per source set rather than in a top-level `dependencies`
        // block, which is what makes "the app happens to bring it" stop working.
        if (androidEnabled) {
            androidMain.dependencies {
                implementation(libs.androidx.work.runtime)
            }
        }
        jvmTest.dependencies {
            implementation(libs.kotest.runner.junit5)
            implementation(libs.kotest.assertions.core)
            implementation(libs.kotlinx.coroutines.test)
            implementation(libs.turbine)
            implementation(libs.konsist)
        }
    }
}

// `centraid.screen.v1` ONLY. `centraid.core.v1` comes from `:core`, and the
// `sourcePath`/`protoPath` split is what says so to Wire: `protoPath` files are
// parsed for imports and not generated.
wire {
    sourcePath {
        srcDir(repositoryRoot.resolve("crates/api-proto/proto").path)
        include("centraid/screen/v1/*.proto")
    }
    protoPath {
        srcDir(repositoryRoot.resolve("crates/api-proto/proto").path)
        include("centraid/core/v1/*.proto")
    }
    kotlin {}
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
    // The Konsist rule and the accessibility lint read SOURCE, not classes, so
    // they need to know where the tree is. A test that guessed a relative path
    // would pass or fail on the working directory.
    systemProperty("centraid.mobileRoot", rootProject.layout.projectDirectory.asFile.path)
    systemProperty("centraid.repositoryRoot", repositoryRoot.path)
    systemProperty("centraid.contractsDir", repositoryRoot.resolve("contracts").path)
    // THE FILES THESE SPECS READ ARE TASK INPUTS.
    //
    // `ScreenFixtureSpec` reads `contracts/screens`, `NativeThemeSpec` reads
    // `design/` and the emitted Swift table, and
    // `NativeAccessibilityLintSpec` reads both view trees. Without declaring
    // them, Gradle calls the task UP-TO-DATE after any change outside
    // `src/`— which a falsification run found by renaming a role in
    // `Theme.swift` and watching the suite not run at all. A source-scanning
    // test whose sources are not inputs is a test that passes on yesterday's
    // tree.
    inputs.dir(repositoryRoot.resolve("contracts/screens")).withPathSensitivity(
        org.gradle.api.tasks.PathSensitivity.RELATIVE,
    )
    inputs.dir(repositoryRoot.resolve("design"))
        .withPathSensitivity(org.gradle.api.tasks.PathSensitivity.RELATIVE)
    inputs.dir(repositoryRoot.resolve("copy"))
        .withPathSensitivity(org.gradle.api.tasks.PathSensitivity.RELATIVE)
    inputs.dir(rootProject.layout.projectDirectory.dir("iosApp"))
        .withPathSensitivity(org.gradle.api.tasks.PathSensitivity.RELATIVE)
    inputs.dir(rootProject.layout.projectDirectory.dir("androidApp/src"))
        .withPathSensitivity(org.gradle.api.tasks.PathSensitivity.RELATIVE)
    testLogging { showStandardStreams = true }
}

// KOVER'S NUMBER IS A JVM NUMBER (#1020 Tooling coverage).
//
// It covers `commonMain` as compiled for the JVM target. It is NOT a
// Kotlin/Native number and it says nothing about the iOS framework, which no
// machine in CI links today. `mobile/README.md` repeats this where a reader of
// the report will be standing.
kover {
    reports {
        filters {
            excludes {
                // GENERATED CODE IS NOT THIS MODULE'S CODE. `centraid.screen.v1.*`
                // is Wire's output over `crates/api-proto/proto` and
                // `dev.centraid.design.*` is the token/copy emitter's; together
                // they are four times the hand-written source, and including
                // them would make the coverage number a measurement of a code
                // generator. The threshold below is over `commonMain`'s state
                // machines, the navigation model and the scheduler, which is
                // what it is meant to be about.
                classes("centraid.screen.v1.*", "dev.centraid.design.*")
            }
        }
        total {
            xml {
                title = "centraid mobile :shared — JVM only; not a Kotlin/Native number"
            }
            verify {
                rule("commonMain state machines are covered") {
                    bound { minValue = 70 }
                }
            }
        }
    }
}
