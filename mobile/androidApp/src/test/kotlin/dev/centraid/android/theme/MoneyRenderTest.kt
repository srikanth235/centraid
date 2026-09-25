package dev.centraid.android.theme

import centraid.screen.v1.Money
import java.io.File
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * ONE MONEY LAW, THIS SHELL'S HALF (K5): the real [formatMoney] over every case
 * in `contracts/screens/money-render.json`, on the JVM with no device.
 *
 * `:shared`'s `KitTimeMoneyCopySpec` mirrors the function; this runs the
 * function itself, so the mirror and the shell cannot drift apart unnoticed.
 */
class MoneyRenderTest {
    private val fixture: String by lazy {
        // Gradle runs a module's unit tests from the module directory.
        generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "contracts/screens/money-render.json") }
            .first { it.exists() }
            .readText()
    }

    @Test
    fun everyFixtureCaseRendersAsTheLawSays() {
        val cases = Regex(
            """"name": "([^"]+)",\s*"minor": (-?\d+),\s*"currency": "([A-Z]+)",\s*"exponent": (\d+),\s*"locale": "([^"]*)",\s*"expected": "([^"]*)"""",
        ).findAll(fixture).toList()
        assertEquals(5, cases.size) // JPY, INR, BHD excluded: see the fixture's $excluded (as `KitTimeMoneyCopySpec`)
        cases.forEach { match ->
            val (name, minor, currency, exponent, locale, expected) = match.destructured
            val rendered = formatMoney(
                Money(minor = minor.toLong(), currency = currency, exponent = exponent.toInt(), locale = locale),
            )
            // CLDR separates a trailing symbol with a no-break space; the
            // fixture may spell either; both sides are compared spaced.
            assertEquals(name, expected.spaced(), rendered.spaced())
        }
    }

    @Test
    fun anEmptyLocaleIsTheDevicesNotTheRoot() {
        val before = Locale.getDefault()
        try {
            Locale.setDefault(Locale.GERMANY)
            val amount = Money(minor = 123456, currency = "EUR", exponent = 2, locale = "")
            assertEquals("1.234,56 €", formatMoney(amount).spaced())
            Locale.setDefault(Locale.US)
            assertEquals("€1,234.56", formatMoney(amount))
        } finally {
            Locale.setDefault(before)
        }
    }

    /** CLDR's no-break spaces, as ordinary ones, on both sides of a comparison. */
    private fun String.spaced(): String = replace('\u00A0', ' ').replace('\u202F', ' ')
}
