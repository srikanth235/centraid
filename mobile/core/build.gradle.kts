// `:core` — the C ABI binding (#1020, D-1020-E1, D-1020-E2).
//
// Five functions, two actuals: JNA on the JVM and on Android, cinterop on iOS.
// Nothing above this module ever sees a pointer.
//
// WHY JNA AND NOT THE FOREIGN FUNCTION & MEMORY API: FFM is final in JDK 22 and
// Android's minimum is nowhere near it, so an Android shell uses JNA (or JNI)
// for years. Wave 2's spike measured the binding the product ships
// (`crates/core-ffi/spike/jna`, D-1020-D2-7) and this module is that spike
// grown up.

plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.wire)
}

val androidEnabled = providers.gradleProperty("centraid.android").orNull == "true"

val repositoryRoot = rootProject.extra["repositoryRoot"] as java.io.File
val iosDeploymentTarget = rootProject.extra["iosDeploymentTarget"] as String

// WHERE `libcentraid_core_ffi.{so,dylib}` IS.
//
// Three answers in order, and NO fallback to "maybe it is on the loader path":
// a binding test that silently loaded some other build of the core would be a
// test of whatever was installed on the machine.
val coreLibraryDir: java.io.File = run {
    val explicit = providers.gradleProperty("centraid.coreLibDir").orNull
    val cargoTargetDir = providers.environmentVariable("CARGO_TARGET_DIR").orNull
    when {
        explicit != null -> file(explicit)
        cargoTargetDir != null -> file(cargoTargetDir).resolve("debug")
        else -> repositoryRoot.resolve("target/debug")
    }
}

// THE ANDROID TARGET, AND WHY IT IS CONFIGURED BY NAME (D-1020-E1).
//
// AGP 9's `com.android.kotlin.multiplatform.library` is the KMP Android library
// plugin the JetBrains AGP-9 guidance names as the target state, and this tree
// is greenfield so it starts there rather than migrating to it. It is applied
// with `pluginManager.apply` and configured through the `androidLibrary`
// extension BY NAME, because the Kotlin DSL only generates typed accessors for
// plugins declared in a `plugins {}` block — and declaring it there would
// resolve AGP on a machine with no Android SDK, which is every machine in this
// repository's CI today. The trade is explicit: the block below is not
// type-checked here, so it is proved by the owner hand-off in
// `mobile/README.md` and nowhere else. A silently-skipped Android target would
// have been worse.
if (androidEnabled) {
    pluginManager.apply("com.android.kotlin.multiplatform.library")
    (kotlin as ExtensionAware).extensions.getByName("androidLibrary").withGroovyBuilder {
        setProperty("namespace", "dev.centraid.core")
        setProperty("compileSdk", 36)
        setProperty("minSdk", 24)
        // The host-test variant is what the JNA actual's own tests run on.
        "withHostTest" { }
    }
}

kotlin {
    jvm()

    // DECLARED, and disabled by the Kotlin plugin on a non-macOS host. The
    // three triples the XCFramework carries (`lane-prebuilt-core.yml`, G).
    listOf(iosArm64(), iosSimulatorArm64(), iosX64()).forEach { target ->
        target.compilations.getByName("main").cinterops.create("centraid") {
            // The header cbindgen generated and `crates/core-ffi` COMMITS.
            // Generating it here would need cbindgen and a Rust toolchain on
            // every machine that opens Xcode.
            definitionFile.set(file("src/nativeInterop/cinterop/centraid.def"))
            includeDirs(repositoryRoot.resolve("crates/core-ffi/include"))
        }
    }

    jvmToolchain(21)

    // ONE JNA IMPLEMENTATION, TWO ACTUALS.
    //
    // `jnaMain` sits between `commonMain` and both JVM-flavoured targets: the
    // binding is the same binding on a JVM host and on Android, and only the
    // UI-thread question differs (a thread name against a `Looper`). Two copies
    // of `harvest` would be two answers to "did every buffer get freed".
    applyDefaultHierarchyTemplate()

    sourceSets {
        val jnaMain = create("jnaMain") { dependsOn(commonMain.get()) }
        jvmMain.get().dependsOn(jnaMain)
        if (androidEnabled) named("androidMain") { dependsOn(jnaMain) }

        jnaMain.dependencies { implementation(libs.jna) }

        commonMain.dependencies {
            implementation(libs.wire.runtime)
            api(libs.kotlinx.coroutines.core)
        }
        jvmTest.dependencies {
            implementation(libs.kotest.runner.junit5)
            implementation(libs.kotest.assertions.core)
            implementation(libs.kotlinx.coroutines.test)
            implementation(libs.turbine)
        }
    }
}

// THE WIRE SCHEMA IS THE RUST TREE'S SCHEMA (#1020 "one protobuf schema
// workspace"). `crates/api-proto/proto` is read in place — a copy under
// `mobile/` would be a second schema with a second `buf` verdict.
//
// `:core` generates `centraid.core.v1` only. `:shared` generates
// `centraid.screen.v1` and depends on this module for the core types, so no
// message is generated twice (two Wire adapters for one message is a decode
// that succeeds and an `equals` that does not).
wire {
    sourcePath {
        srcDir(repositoryRoot.resolve("crates/api-proto/proto").path)
        include("centraid/core/v1/*.proto")
    }
    kotlin {}
}

val abiFixtureDir: java.io.File = layout.buildDirectory.dir("abi-fixture").get().asFile

// The vault and the request bytes the ABI round trip reads.
//
// A REAL VAULT FROM THE REAL CORE, made by the binary `crates/core-ffi` already
// ships for its own spike. Founding a vault is the core's job and not a shell's
// — there is no wire verb for it, deliberately — so a Kotlin test that wanted a
// founded vault without cargo would have to commit a binary `.db` and let it
// rot against the ontology's version window.
val abiFixture = tasks.register<Exec>("abiFixture") {
    group = "verification"
    description = "Build the vault + request fixture the ABI round trip reads."
    workingDir = repositoryRoot
    commandLine(
        "cargo",
        "run",
        "--quiet",
        "-p",
        "centraid-core-ffi",
        "--bin",
        "spike-fixture",
        "--",
        abiFixtureDir.path,
    )
    outputs.dir(abiFixtureDir)
    // A FRESH VAULT EVERY RUN, never an up-to-date one. `spike-fixture` deletes
    // and re-founds the file for the reason its own header gives — "a spike
    // measuring a vault a previous run left behind is measuring whatever that
    // run happened to write" — and an up-to-date check would hand the round
    // trip yesterday's vault, rows and all.
    outputs.upToDateWhen { false }
    doFirst { abiFixtureDir.mkdirs() }
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
    // The HTML report writer uses the platform encoding for FILE NAMES, and the
    // spec names quote `CONTRACT.md` clauses verbatim. Without this the report
    // step fails on an em dash and takes a green test run down with it.
    defaultCharacterEncoding = "UTF-8"
    dependsOn(abiFixture)
    // NOT `environment`: these reach the test as system properties so a reader
    // of a failure sees them in the Gradle output rather than in a shell.
    systemProperty("centraid.core.libDir", coreLibraryDir.path)
    systemProperty("centraid.core.fixtureDir", abiFixtureDir.path)
    // The committed cbindgen header, so `AbiContractSpec` can check the status
    // codes `commonMain` writes out against the ones the ABI defines.
    systemProperty(
        "centraid.core.headerPath",
        repositoryRoot.resolve("crates/core-ffi/include/centraid.h").path,
    )
    systemProperty("centraid.core.cargoTargetDir", providers.environmentVariable("CARGO_TARGET_DIR").orNull ?: "")
    // JNA resolves `libcentraid_core_ffi` against this.
    systemProperty("jna.library.path", coreLibraryDir.path)
    testLogging { showStandardStreams = true }
}

// The iOS deployment floor is read by the Xcode project, not by this module's
// Kotlin compile — but a module that declared iOS targets and never mentioned
// the floor is a module whose reader has to go looking for it.
tasks.register("iosDeploymentTarget") {
    group = "help"
    description = "Print the one iOS deployment floor (mobile/ios-deployment-target)."
    val floor = iosDeploymentTarget
    doLast { logger.lifecycle(floor) }
}
