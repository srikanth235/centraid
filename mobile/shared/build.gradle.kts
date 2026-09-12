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

    listOf(iosArm64(), iosSimulatorArm64(), iosX64()).forEach { target ->
        target.binaries.framework {
            baseName = "CentraidShared"
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
