// `:androidApp` — the Compose shell (#1020, D-1020-E1).
//
// INCLUDED ONLY UNDER `-Pcentraid.android=true` with an Android SDK present;
// `mobile/settings.gradle.kts` is the gate and it refuses loudly rather than
// skipping. Nothing in this module is compiled on the machines that run
// `cargo xtask gate` today, which `mobile/README.md` states as an owner
// hand-off with the exact command.
//
// A `com.android.application` module that depends on `:shared`, per the AGP 9
// layout: the application plugin and the Kotlin Multiplatform plugin are
// incompatible in one module from AGP 9 on, so the entry point lives here and
// the shared code stays a KMP library.

plugins {
    id("com.android.application")
    alias(libs.plugins.compose.compiler)
}

android {
    namespace = "dev.centraid.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.centraid"
        // The shipped floor; raising it drops devices, so it moves only by a
        // decision, not by a toolchain default.
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0-alpha.0"
    }

    buildFeatures { compose = true }

    // ALL APP DATA IS EXCLUDED FROM AUTO BACKUP AND DEVICE-TO-DEVICE TRANSFER
    // (`docs/mobile-offline.md:240-247`). In v0 this was written by
    // `plugins/withCentraidAndroidPrivacy.cjs` into a generated project; here
    // it is source, which is the whole point of retiring the prebuild.
    packaging {
        resources.excludes.add("META-INF/*")
    }
}

dependencies {
    implementation(project(":shared"))
    implementation(project(":core"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.core)
    implementation(libs.androidx.work.runtime)
    // `debugImplementation`, NOT `androidRuntimeClasspath` (#1020, wave A).
    //
    // `androidRuntimeClasspath` is the accessor the AGP 9 KMP LIBRARY plugin
    // (`com.android.kotlin.multiplatform.library`) introduces in place of
    // `debugImplementation`. This module is `com.android.application`, where
    // that configuration does not exist and the debug variant accessor is still
    // the right one — the two halves of the AGP 9 migration, applied to the
    // wrong half. Invisible until a machine with an Android SDK compiled it.
    debugImplementation(libs.androidx.compose.ui.tooling)

    // ROBORAZZI FOR COMPOSE SNAPSHOTS (D-1020-E7). Compile-gated with the rest
    // of this module: a snapshot suite needs an Android runtime, and Robolectric
    // needs an SDK jar to download.
    testImplementation(libs.robolectric)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
}
