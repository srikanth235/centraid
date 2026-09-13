// THE ANDROID PLUGIN'S CLASSPATH, ADDED ONLY WHEN THE GATE IS OPEN.
//
// `plugins { alias(libs.plugins.android...) apply false }` would resolve AGP
// from `google()` on every configuration of this build, including on a machine
// with no Android SDK where nothing can use it — a download to reach a failure.
// A `buildscript` block is the one place Gradle lets that resolution be
// conditional, and subprojects inherit the classpath, which is what
// `mobile/{core,shared}/build.gradle.kts` then apply by id.
//
// The gate itself (the ANDROID_HOME check and its message) is in
// `settings.gradle.kts`, which runs first.
buildscript {
    dependencies {
        // The property, and the AGP version, read WITHOUT the version-catalogue
        // accessors: a `buildscript` block is compiled before them.
        // `gradle/libs.versions.toml` stays the single source of the version.
        if (gradle.startParameter.projectProperties["centraid.android"] == "true") {
            val agpVersion = file("gradle/libs.versions.toml")
                .readLines()
                .first { it.startsWith("agp = ") }
                .substringAfter('"')
                .substringBefore('"')
            classpath("com.android.tools.build:gradle:$agpVersion")
        }
    }
}

// The mobile build's root project (#1020, D-1020-E1).
//
// It holds no source. What it holds is the two facts every module needs and
// nobody should re-derive: the repository root, and the one place the iOS
// deployment floor is written.

plugins {
    alias(libs.plugins.kotlin.multiplatform) apply false
    alias(libs.plugins.wire) apply false
    alias(libs.plugins.kover) apply false
}

// ONE FILE FOR THE DEPLOYMENT FLOOR (D-1020-E1). Gradle reads it for the
// Kotlin/Native targets, XcodeGen reads it for the Xcode project, and
// `mobile/iosApp/Package.swift` reads it for SPM. Three readers, one number:
// a floor written in three places is a floor that raises in two of them.
val iosDeploymentTarget: String = rootDir.resolve("ios-deployment-target").readText().trim()

// The repository root, for the modules that reach outside `mobile/` — the
// protobuf schema under `crates/api-proto/proto` and the `cargo`-built cdylib.
val repositoryRoot: java.io.File = rootDir.parentFile

allprojects {
    extra["iosDeploymentTarget"] = iosDeploymentTarget
    extra["repositoryRoot"] = repositoryRoot
}

tasks.register("mobileJvm") {
    group = "verification"
    description =
        "What `cargo xtask gate`'s mobile-jvm step runs: the JVM-provable half " +
            "of the mobile tree. Everything else is an owner hand-off (mobile/README.md)."
    dependsOn(":shared:jvmTest", ":core:jvmTest", ":shared:koverXmlReport")
}
