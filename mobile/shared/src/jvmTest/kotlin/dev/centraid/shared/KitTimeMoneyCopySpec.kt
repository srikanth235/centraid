package dev.centraid.shared

import centraid.screen.v1.Money
import dev.centraid.shared.kit.MoneyFold
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.shell.HomeAgendaTile
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import java.io.File
import java.math.BigDecimal
import java.text.NumberFormat
import java.util.Currency
import java.util.Locale

/**
 * The kit's pure halves: civil days in words, money arithmetic, and the one
 * money fixture both shells' renderers answer to — plus the copy tables, which
 * are generated from `copy/<app>.json` and must say exactly what it says.
 */
class KitTimeMoneyCopySpec : StringSpec({

    val root = File(System.getProperty("centraid.repositoryRoot") ?: error("unset"))

    // --- Civil words ------------------------------------------------------

    "civil words: relative days, dates, ordinals, clocks and spans" {
        CivilWords.relativeDay("2026-09-24", today = "2026-09-24") shouldBe "Today"
        CivilWords.relativeDay("2026-09-25", today = "2026-09-24") shouldBe "Tomorrow"
        CivilWords.relativeDay("2026-09-23", today = "2026-09-24") shouldBe "Yesterday"
        CivilWords.relativeDay("2026-03-11", today = "2026-09-24") shouldBe "Wed 11 March"
        // Across a month and a year end, the arithmetic is civil, not 30-day.
        CivilWords.relativeDay("2027-01-01", today = "2026-12-31") shouldBe "Tomorrow"
        CivilWords.dated("2026-03-11") shouldBe "Wed 11"
        CivilWords.weekdayShort("2026-09-27") shouldBe "Sun"
        CivilWords.monthName(12) shouldBe "December"
        CivilWords.monthName(13) shouldBe ""
        listOf(1 to "1st", 2 to "2nd", 3 to "3rd", 4 to "4th", 11 to "11th", 12 to "12th", 13 to "13th", 21 to "21st", 22 to "22nd", 31 to "31st")
            .forEach { (n, said) -> CivilWords.ordinal(n) shouldBe said }
        CivilWords.clock("2026-09-24T08:15:00") shouldBe "08:15"
        CivilWords.clock("2026-09-24") shouldBe ""
        CivilWords.span("2026-09-24T08:15", "2026-09-24T09:45", allDay = false) shouldBe "08:15 – 09:45"
        CivilWords.span("2026-09-24T08:15", "", allDay = false) shouldBe "08:15"
        CivilWords.span("2026-09-24", "2026-09-25", allDay = true) shouldBe "All day"
        // A day that is not one comes back as itself, never as a guess.
        CivilWords.dated("2026-02-31") shouldBe "2026-02-31"
        CivilWords.dayMonth("nonsense") shouldBe "nonsense"
    }

    "Home's Agenda tile says a day the kit's way" {
        HomeAgendaTile.ordinal(22) shouldBe CivilWords.ordinal(22)
    }

    // --- Money ------------------------------------------------------------

    "money: sums never cross a currency, and the fixture's sums hold" {
        val fixture = root.resolve("contracts/screens/money-render.json").readText()
        val sums = Regex(""""name": "([^"]+)",\s*"in": \[(.*?)\],\s*"out": \[(.*?)\]""", RegexOption.DOT_MATCHES_ALL)
            .findAll(fixture).toList()
        sums.size shouldBe 3
        sums.forEach { match ->
            withClue(match.groupValues[1]) {
                MoneyFold.sumByCurrency(amounts(match.groupValues[2])) shouldBe amounts(match.groupValues[3])
            }
        }
        MoneyFold.sign(Money(minor = -5, currency = "USD")) shouldBe -1
        MoneyFold.sign(Money(minor = 0, currency = "USD")) shouldBe 0
        MoneyFold.isZero(Money(minor = 0, currency = "JPY")) shouldBe true
    }

    "money: every fixture case renders as the Android renderer's law says" {
        // `formatMoney` (androidApp `theme/Theme.kt`) mirrored on the JVM, where
        // it runs on the same `java.text` CLDR data. The iOS half is K5's test
        // over the same file; the two may not drift.
        val fixture = root.resolve("contracts/screens/money-render.json").readText()
        val cases = Regex(
            """"name": "([^"]+)",\s*"minor": (-?\d+),\s*"currency": "([A-Z]+)",\s*"exponent": (\d+),\s*"locale": "([^"]*)",\s*"expected": "([^"]*)"""",
        ).findAll(fixture).toList()
        cases.size shouldBe 5 // JPY, INR, BHD excluded: see the fixture's $excluded
        cases.forEach { match ->
            val (name, minor, currency, exponent, locale, expected) = match.destructured
            withClue(name) {
                render(Money(minor = minor.toLong(), currency = currency, exponent = exponent.toInt(), locale = locale)) shouldBe
                    expected
            }
        }
    }

    // --- Copy -------------------------------------------------------------

    "copy: every generated table holds exactly its copy/<app>.json strings" {
        // THE TABLES ARE GENERATED (`:shared:generateCopy`), so this reads the
        // COMPILED object against the JSON: what it proves is the generator's
        // escaping (a `$`, a quote, a newline) and that no key is dropped.
        val files = root.resolve("copy").listFiles { file -> file.name.endsWith(".json") }!!.sorted()
        // Twelve since Health's (#1129): a new app's words are a new file.
        files.size shouldBe 12
        files.forEach { file ->
            val app = file.name.removeSuffix(".json")
            val table = Class.forName("dev.centraid.design.copy.${app.replaceFirstChar { it.uppercase() }}Copy")
            val compiled = table.declaredFields
                .filter { java.lang.reflect.Modifier.isStatic(it.modifiers) && it.type == String::class.java }
                .associate { it.name to it.get(null) as String }
            val json = Regex(""""(\w+)": "((?:[^"\\]|\\.)*)"""")
                .findAll(file.readText().substringAfter("\"strings\": {").substringBefore("\n  }"))
                .associate { it.groupValues[1] to unescapeJson(it.groupValues[2]) }
            withClue(app) { compiled shouldBe json }
        }
    }
}) {
    private companion object {
        fun amounts(json: String): List<Money> =
            Regex(""""minor": (-?\d+),\s*"currency": "([A-Z]+)",\s*"exponent": (\d+)""").findAll(json).map {
                Money(minor = it.groupValues[1].toLong(), currency = it.groupValues[2], exponent = it.groupValues[3].toInt())
            }.toList()

        /** Android's `formatMoney`, as written, for the fixture. */
        fun render(money: Money): String {
            if (money.currency.isEmpty()) return ""
            val exponent = money.exponent
            val locale = Locale.forLanguageTag(money.locale.ifEmpty { "und" })
            val amount = BigDecimal(money.minor).movePointLeft(exponent)
            val currency = runCatching { Currency.getInstance(money.currency) }.getOrNull()
                ?: return NumberFormat.getNumberInstance(locale).apply {
                    minimumFractionDigits = exponent
                    maximumFractionDigits = exponent
                }.format(amount) + " " + money.currency
            return NumberFormat.getCurrencyInstance(locale).apply {
                this.currency = currency
                minimumFractionDigits = exponent
                maximumFractionDigits = exponent
            }.format(amount)
        }
    }
}

private fun unescapeJson(text: String): String = buildString {
    var index = 0
    while (index < text.length) {
        val char = text[index]
        if (char != '\\') {
            append(char)
            index += 1
            continue
        }
        when (val next = text[index + 1]) {
            'n' -> append('\n')
            't' -> append('\t')
            'r' -> append('\r')
            'u' -> {
                append(text.substring(index + 2, index + 6).toInt(16).toChar())
                index += 4
            }
            else -> append(next)
        }
        index += 2
    }
}
