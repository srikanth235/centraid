package dev.centraid.shared

import dev.centraid.design.CentraidCatalog
import dev.centraid.shared.shell.FirstLaunch
import dev.centraid.shared.shell.SpringboardPolicy
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldContainAll
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import java.io.File

/**
 * THE FIRST-LAUNCH HOUSE IS HOME'S ROSTER (#1129).
 *
 * The gate's house was a hand-typed list in `FirstLaunchView.swift`, and Money and Health reached
 * Home without reaching it. Now the list is [FirstLaunch.APPS], read from
 * [SpringboardPolicy.SPRINGBOARD_ORDER], and both views draw it: this spec ties the shared list to
 * the roster and to the catalogue, and reads the two views' sources for the list and for any
 * permission ask, because the gate asks for nothing.
 */
class FirstLaunchRosterSpec : StringSpec({
    val mobileRoot = File(
        System.getProperty("centraid.mobileRoot")
            ?: error("centraid.mobileRoot is unset; see mobile/shared/build.gradle.kts"),
    )
    val swift = mobileRoot.resolve("iosApp/Sources/FirstLaunchView.swift").readText()
    val compose = mobileRoot
        .resolve("androidApp/src/main/kotlin/dev/centraid/android/screens/words/FirstLaunchScreen.kt")
        .readText()

    "the house is Home's roster, in Home's order" {
        FirstLaunch.APPS shouldContainExactly SpringboardPolicy.SPRINGBOARD_ORDER
    }

    "every app in the catalogue is in the house, Money and Health with them" {
        FirstLaunch.APPS.toSet() shouldBe CentraidCatalog.apps.map { it.id }.toSet()
        FirstLaunch.APPS shouldContainAll listOf("money", "health")
    }

    "both views draw the shared list and type none of their own" {
        swift shouldContain "FirstLaunch.shared.APPS"
        compose shouldContain "FirstLaunch.APPS"
        // A hand-typed list of app ids is how the house fell behind Home.
        val typed = Regex("""(?:\[|listOf\(|arrayOf\()\s*"(?:photos|docs|notes|agenda|tasks|people|locker|money|health)"""")
        withClue("a first-launch view types app ids instead of reading FirstLaunch.APPS") {
            typed.containsMatchIn(swift) shouldBe false
            typed.containsMatchIn(compose) shouldBe false
        }
    }

    "the gate asks the phone for nothing: Health asks on its own Connect button" {
        for (ask in listOf("requestAuthorization", "HKHealthStore", "HealthConnect", "PermissionController", "CNContactStore", "EKEventStore", "Manifest.permission", "rememberLauncherForActivityResult")) {
            swift shouldNotContain ask
            compose shouldNotContain ask
        }
    }
})
