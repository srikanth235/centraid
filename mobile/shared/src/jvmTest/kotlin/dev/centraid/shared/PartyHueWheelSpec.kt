package dev.centraid.shared

import dev.centraid.design.NATIVE_COLOR_ROLES
import dev.centraid.shared.design.PartyHueWheel
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldContainExactlyInAnyOrder
import io.kotest.matchers.shouldBe
import java.io.File

/**
 * THE WHEEL, ASSERTED ROW BY ROW against what `packages/design` answered
 * (#1020, D-1020-T1).
 *
 * `design/identity-corpus.json` is emitted by
 * `contracts/tools/export-design-corpus.ts`, which RUNS the real `partyHueKey`
 * and `partyHueValue` over a fixed, deliberately hostile corpus — non-ASCII
 * ids, an empty id, a lone tab, a lone NBSP, a one-emoji id, a two-emoji id,
 * and every shape of stored `avatar_color` including a hex and a `var()` naming
 * a hue that does not exist — and writes inputs and outputs. This spec is the
 * Kotlin half of the same claim that `crates/design/tests/corpus.rs` makes in
 * Rust: **every row, no sampling**, and the count asserted so a corpus that
 * shrank is a failure rather than a quiet pass.
 *
 * The corpus is READ, never transcribed. A fixture retyped into a test is a
 * second fixture, and the whole point of this one is that one emitter wrote
 * both sides.
 *
 * ## The two falsifications at the bottom
 *
 * A corpus proves nothing until you know it can say no. The last two cases run
 * the two hashes a careless port actually writes — the one that wraps the sum
 * in `Int` instead of carrying it in `Long`, and the one that walks UTF-16
 * units instead of code points — and assert each DISAGREES with the corpus on a
 * row. Both pass every ASCII id in the tree, which is exactly why neither would
 * have been caught by a test written over ids somebody thought of.
 */
class PartyHueWheelSpec : StringSpec({

    val repositoryRoot = File(
        System.getProperty("centraid.repositoryRoot")
            ?: error("centraid.repositoryRoot is unset; see mobile/shared/build.gradle.kts"),
    )

    /** One corpus row, with `avatar_color` absent kept apart from null. */
    data class HueRow(val partyId: String, val stored: String?, val absent: Boolean, val hueKey: String?)

    val hueRows: List<HueRow> = run {
        val file = repositoryRoot.resolve("design/identity-corpus.json")
        file.isFile.shouldBeTrue()
        val corpus = JsonText(file.readText()).read() as Map<*, *>
        (corpus["hues"] as List<*>).map { row ->
            val fields = row as Map<*, *>
            HueRow(
                partyId = fields["party_id"] as String,
                stored = fields["avatar_color"] as String?,
                absent = fields["avatar_color_absent"] as Boolean,
                hueKey = fields["hue_key"] as String?,
            )
        }
    }

    "every hue row agrees with packages/design" {
        // A corpus this small is not a corpus. The Rust half asserts the same
        // floor over the same file, and the two numbers move together.
        (hueRows.size >= 180).shouldBeTrue()
        hueRows.forEach { row ->
            // ABSENT IS NOT NULL IS NOT EMPTY, and the corpus carries all three
            // because `optional string color` on the wire carries all three.
            val stored = if (row.absent) null else row.stored
            withClue("hue key for ${row.partyId.escaped()} with ${stored?.escaped()}") {
                PartyHueWheel.partyHueKey(row.partyId, stored) shouldBe row.hueKey
            }
        }
    }

    "the wheel's eight places are all reachable, and the corpus reaches them" {
        // A wheel that collapsed to one hue would still pass row-by-row if the
        // corpus only ever landed on that hue. It does not.
        hueRows.mapNotNull { it.hueKey }.distinct() shouldContainExactlyInAnyOrder PartyHueWheel.HUE_KEYS
    }

    "every hue key names a colour role the native table actually emits" {
        // THE SEAM THE CORPUS CANNOT SEE. Both shells turn a key into
        // `c<Key>` and read it out of the emitted table; a hue the table has no
        // role for draws nothing on Compose and traps on SwiftUI, and neither
        // failure looks like a missing token. One emitter writes the roles and
        // this list is hand-written, so the two are asserted against each other
        // rather than trusted to have been written on the same afternoon.
        PartyHueWheel.HUE_KEYS.forEach { key ->
            val role = "c" + key.replaceFirstChar { it.uppercaseChar() }
            withClue(role) { NATIVE_COLOR_ROLES.contains(role).shouldBeTrue() }
        }
    }

    "both view trees name all eight hue roles" {
        // THE OTHER HALF THE CORPUS CANNOT SEE, and the one this defect was:
        // the wheel was ported to Rust, emitted as eight colour roles, and
        // never reached from a screen — every face drew `bgSunken`. A hue
        // spelled in one shell and forgotten in the other is the same defect
        // on one platform, which is worse, because the shell that is right is
        // the one somebody screenshots. This reads the SOURCE, the way
        // `NativeAccessibilityLintSpec` does, because the Swift half has no
        // other enforcer on a machine with no Xcode.
        val mobileRoot = File(
            System.getProperty("centraid.mobileRoot")
                ?: error("centraid.mobileRoot is unset; see mobile/shared/build.gradle.kts"),
        )
        val views = listOf(
            mobileRoot.resolve("iosApp/Sources/HomeView.swift"),
            mobileRoot.resolve("androidApp/src/main/kotlin/dev/centraid/android/screens/HomeScreen.kt"),
        )
        views.forEach { view ->
            withClue(view.path) { view.isFile.shouldBeTrue() }
            val source = view.readText()
            PartyHueWheel.HUE_KEYS.forEach { key ->
                val role = "c" + key.replaceFirstChar { it.uppercaseChar() }
                withClue("${view.name} never names $role") {
                    source.contains(role).shouldBeTrue()
                }
            }
            // And the solved foreground, without which a saturated disc keeps
            // the ink that failed contrast on it.
            withClue("${view.name} never names textInv") {
                source.contains("textInv").shouldBeTrue()
            }
        }
    }

    "a stored colour the wheel cannot name is null, and the corpus carries two shapes of it" {
        // Neither a hex nor a `var()` naming an invented hue is substitutable
        // for a derived one — a port that fell back to the id's hue would be
        // inventing an answer, and the corpus says `null` for both.
        val unnameable = hueRows.filter { it.hueKey == null }
        (unnameable.size >= 2).shouldBeTrue()
        unnameable.forEach { row ->
            PartyHueWheel.partyHueKey(row.partyId, row.stored) shouldBe null
        }
    }

    "v0's hand-wrap IS an Int overflow, including where the branch fires" {
        // A FINDING, NOT A FALSIFICATION, and it is filed here because this
        // case was written to BE a falsification and could not be made one.
        //
        // `crates/design/src/lib.rs` says of the same line: "An
        // `i32::wrapping_add` would wrap at a different place and give a
        // different hue for a minority of ids; the corpus is what proves this
        // one agrees." Neither half holds. A code point is NON-NEGATIVE, so
        // `imul(hash, 31) + codePoint` can only overflow UPWARD and by at most
        // 0x10FFFF — one wrap, never two, and never below `Int.MIN_VALUE`.
        // Subtracting 2³² exactly when the sum passes `Int.MAX_VALUE` is
        // therefore the definition of two's-complement `Int` addition. And the
        // corpus proves nothing either way: the branch fires ZERO times across
        // all of it, because landing within 0x10FFFF of `Int.MAX_VALUE` is a
        // 1-in-4000 event per character and the corpus has a few hundred.
        //
        // So the two are asserted equal on the corpus AND on an id constructed
        // to fire the branch — which is the only evidence that says anything.
        fun asIntSum(value: String): Long {
            var hash = 0
            var index = 0
            while (index < value.length) {
                val high = value[index]
                val low = if (index + 1 < value.length) value[index + 1] else null
                val codePoint: Int
                if (high.isHighSurrogate() && low != null && low.isLowSurrogate()) {
                    codePoint = 0x10000 + ((high.code - 0xD800) shl 10) + (low.code - 0xDC00)
                    index += 2
                } else {
                    codePoint = high.code
                    index += 1
                }
                hash = hash * 31 + codePoint
            }
            val wide = hash.toLong()
            return if (wide < 0L) -wide else wide
        }

        hueRows.forEach { row ->
            val trimmed = row.partyId.trim()
            withClue(trimmed.escaped()) {
                asIntSum(trimmed) shouldBe PartyHueWheel.identityHash(trimmed)
            }
        }
        // CONSTRUCTED, not found: 31 is invertible mod 2³², so an id whose
        // running hash lands on a chosen value is solved for rather than
        // searched. `2>::481!` drives the running hash to `Int.MAX_VALUE`
        // before its last character, so the hand-wrap's branch is taken.
        OVERFLOWING_IDS.forEach { id ->
            withClue(id) { asIntSum(id) shouldBe PartyHueWheel.identityHash(id) }
        }
    }

    "the hash answers a value no Int holds, and the wheel does not care" {
        // `16C4NAI` is constructed the same way and hashes to exactly
        // `Int.MIN_VALUE`. v0's `Math.abs` answers 2 147 483 648 — a double,
        // outside `Int` — and `kotlin.math.abs(Int.MIN_VALUE)` answers
        // `Int.MIN_VALUE`, still negative. Hence the `Long`.
        PartyHueWheel.identityHash("16C4NAI") shouldBe 2_147_483_648L
        (PartyHueWheel.identityHash("16C4NAI") > Int.MAX_VALUE.toLong()).shouldBeTrue()
        // AND THE HONEST HALF: no hue rides on it. 2³¹ is divisible by eight,
        // so the right answer and the wrong one both index place zero. This
        // guards what the function RETURNS — a reader should not be left
        // thinking a member's disc changes colour on it.
        PartyHueWheel.identityHueKey("16C4NAI") shouldBe PartyHueWheel.HUE_KEYS.first()
    }

    "the corpus can say no: walking UTF-16 units is a different wheel" {
        // `for (const character of value)` walks CODE POINTS. A Kotlin `for
        // (c in value)` walks units, which is the same answer for every ASCII
        // id in this repository and a different one for 🙂.
        fun byUnit(value: String): Long {
            var hash = 0
            for (character in value) {
                val next = (hash * 31).toLong() + character.code.toLong()
                hash = if (next > Int.MAX_VALUE.toLong()) (next - 0x1_0000_0000L).toInt() else next.toInt()
            }
            val wide = hash.toLong()
            return if (wide < 0L) -wide else wide
        }

        val disagreements = hueRows.filter { row ->
            byUnit(row.partyId.trim()) != PartyHueWheel.identityHash(row.partyId.trim())
        }
        withClue("the corpus carries no astral id; the surrogate pairing is untested") {
            disagreements.isNotEmpty().shouldBeTrue()
        }
    }
})

/**
 * Ids solved for, not sampled: each drives the running hash to `Int.MAX_VALUE`
 * just before its final character, so `imul(hash, 31) + codePoint` passes
 * `Int.MAX_VALUE` and v0's hand-wrap branch is taken. Nothing in
 * `design/identity-corpus.json` does — see the case above for why that is a
 * property of the corpus and not of the wheel.
 */
private val OVERFLOWING_IDS = listOf("2>::481!", "16C4NAI")

/** A control character or an astral char in a clue is a clue nobody can read. */
private fun String.escaped(): String = buildString {
    append('"')
    this@escaped.forEach { character ->
        if (character.code in 0x20..0x7E) append(character) else append("\\u%04x".format(character.code))
    }
    append('"')
}

/**
 * A STRICT, TINY JSON READER, and why one is written here.
 *
 * The corpus is the fixture and must be READ rather than transcribed, and
 * `:shared`'s `jvmTest` classpath is kotest, konsist, turbine, Wire and
 * coroutines-test — no JSON parser among them. The alternatives were a regex
 * sweep over a file whose keys carry `\t`, ` ` and surrogate pairs (a
 * parser, written badly), or a new dependency in the catalogue for one spec.
 * This is the third option: forty lines that accept the JSON this corpus is and
 * refuse anything else, so a malformed corpus fails loudly instead of parsing
 * into a shape the assertions skip.
 */
private class JsonText(private val text: String) {
    private var at = 0

    fun read(): Any? {
        val value = value()
        skipSpace()
        require(at == text.length) { "trailing input at $at" }
        return value
    }

    private fun value(): Any? {
        skipSpace()
        return when (val character = peek()) {
            '{' -> obj()
            '[' -> list()
            '"' -> string()
            't' -> literal("true", true)
            'f' -> literal("false", false)
            'n' -> literal("null", null)
            else -> if (character == '-' || character in '0'..'9') number() else fail("unexpected $character")
        }
    }

    private fun obj(): Map<String, Any?> {
        expect('{')
        val entries = LinkedHashMap<String, Any?>()
        skipSpace()
        if (peek() == '}') { at++; return entries }
        while (true) {
            skipSpace()
            val key = string()
            skipSpace()
            expect(':')
            entries[key] = value()
            skipSpace()
            when (val character = peek()) {
                ',' -> at++
                '}' -> { at++; return entries }
                else -> fail("expected , or } but found $character")
            }
        }
    }

    private fun list(): List<Any?> {
        expect('[')
        val items = mutableListOf<Any?>()
        skipSpace()
        if (peek() == ']') { at++; return items }
        while (true) {
            items += value()
            skipSpace()
            when (val character = peek()) {
                ',' -> at++
                ']' -> { at++; return items }
                else -> fail("expected , or ] but found $character")
            }
        }
    }

    private fun string(): String {
        expect('"')
        val out = StringBuilder()
        while (true) {
            when (val character = text[at++]) {
                '"' -> return out.toString()
                '\\' -> when (val escape = text[at++]) {
                    '"', '\\', '/' -> out.append(escape)
                    'b' -> out.append('\b')
                    'f' -> out.append('')
                    'n' -> out.append('\n')
                    'r' -> out.append('\r')
                    't' -> out.append('\t')
                    // NOT decoded into code points: a `🙂` pair is
                    // appended as two units and Kotlin's `String` holds it as
                    // the pair it is, which is what the emitter wrote.
                    'u' -> { out.append(text.substring(at, at + 4).toInt(16).toChar()); at += 4 }
                    else -> fail("unknown escape \\$escape")
                }
                else -> out.append(character)
            }
        }
    }

    private fun number(): Double {
        val start = at
        while (at < text.length && (text[at] == '-' || text[at] == '+' || text[at] == '.' ||
                text[at] == 'e' || text[at] == 'E' || text[at] in '0'..'9')
        ) {
            at++
        }
        return text.substring(start, at).toDouble()
    }

    private fun <T> literal(word: String, value: T): T {
        require(text.startsWith(word, at)) { "expected $word at $at" }
        at += word.length
        return value
    }

    private fun peek(): Char = if (at < text.length) text[at] else fail("unexpected end of input")

    private fun expect(character: Char) {
        require(peek() == character) { "expected $character at $at" }
        at++
    }

    private fun skipSpace() {
        while (at < text.length && (text[at] == ' ' || text[at] == '\n' || text[at] == '\r' || text[at] == '\t')) {
            at++
        }
    }

    private fun fail(message: String): Nothing = throw IllegalArgumentException("$message (at $at)")
}
