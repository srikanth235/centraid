// JNA against the built cdylib, measuring the same thing the C harness does.
//
// JNA and not the Foreign Function & Memory API, deliberately: FFM is final in
// JDK 22 and Android's minimum is nowhere near it, so an Android shell will use
// JNA (or JNI) for years. Measuring the binding the product will actually ship
// is the whole point of a spike.
//
//   CENTRAID_LIB_DIR=<target>/debug CENTRAID_VAULT=/tmp/jna-vault.db \
//   CENTRAID_REQUEST=/tmp/request.bin gradle run
//
// If Gradle cannot reach Maven Central through this machine's proxy, the source
// still ships and the receipt records the exact failure. The harness is the
// deliverable; the number is what the network allows.

plugins {
    kotlin("jvm") version "2.0.21"
    application
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("net.java.dev.jna:jna:5.14.0")
}

kotlin {
    jvmToolchain(21)
}

application {
    mainClass.set("dev.centraid.spike.MainKt")
}
