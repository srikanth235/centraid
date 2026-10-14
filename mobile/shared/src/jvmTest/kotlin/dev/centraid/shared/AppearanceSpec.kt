package dev.centraid.shared

import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.platform.FakeSecureStore
import dev.centraid.shared.shell.Appearance
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.test.runTest

/**
 * Home's appearance key (R-CHROME-7): one tap flips what the screen shows, and
 * a flip back to the phone's own scheme follows the phone again.
 */
class AppearanceSpec : StringSpec({
    "a fresh phone follows its own scheme" {
        Appearance.DEFAULT shouldBe Appearance.SYSTEM
        Appearance.SYSTEM.dark(phoneDark = true) shouldBe true
        Appearance.SYSTEM.dark(phoneDark = false) shouldBe false
    }

    "a hold ignores the phone" {
        Appearance.DARK.dark(phoneDark = false) shouldBe true
        Appearance.LIGHT.dark(phoneDark = true) shouldBe false
        Appearance.SYSTEM.held shouldBe null
    }

    "the tap flips what the screen shows, and two taps follow the phone again" {
        for (phoneDark in listOf(true, false)) {
            val once = Appearance.SYSTEM.toggled(phoneDark)
            once.dark(phoneDark) shouldBe !phoneDark
            once.toggled(phoneDark) shouldBe Appearance.SYSTEM
        }
    }

    "a hold the phone agrees with flips to the other hold" {
        // Held dark, and the phone went dark in the evening: the screen is
        // dark either way, so the tap lands on light — a hold that disagrees.
        Appearance.DARK.toggled(phoneDark = true) shouldBe Appearance.LIGHT
        Appearance.LIGHT.toggled(phoneDark = false) shouldBe Appearance.DARK
    }

    "the key shows where a tap goes" {
        Appearance.key(dark = true).iconKey shouldBe "Sun"
        Appearance.key(dark = true).label shouldBe SharedCopy.APPEARANCE_TO_LIGHT
        Appearance.key(dark = false).iconKey shouldBe "Moon"
        Appearance.key(dark = false).label shouldBe SharedCopy.APPEARANCE_TO_DARK
    }

    "following the phone is stored as absence; an unknown word follows the phone" {
        runTest {
            val store = FakeSecureStore()
            Appearance.write(store, Appearance.DARK)
            Appearance.read(store) shouldBe Appearance.DARK
            Appearance.write(store, Appearance.SYSTEM)
            store.read(Appearance.KEY) shouldBe null
            Appearance.read(store) shouldBe Appearance.SYSTEM
            store.write(Appearance.KEY, "sepia")
            Appearance.read(store) shouldBe Appearance.SYSTEM
        }
    }
})
