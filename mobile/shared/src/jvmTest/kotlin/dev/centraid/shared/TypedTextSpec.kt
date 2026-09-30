package dev.centraid.shared

import dev.centraid.shared.kit.TypedText
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe

/**
 * THE FIELD'S TYPING AGAINST THE MACHINE'S ECHOES (#1047 walk, B1): a value
 * the machine says replaces what the member typed only when it is not an echo
 * of the field's own typing. Both shells' text fields ask [TypedText].
 */
class TypedTextSpec : StringSpec({
    fun typed(initial: String, vararg keys: String): TypedText =
        TypedText(initial).also { t -> keys.forEach { t.edited(it) } }

    "a save that lands mid-typing does not take back the keystrokes typed since (Notes' 'alk')" {
        val t = typed("", "Body of the w", "Body of the wa", "Body of the wal")
        t.answer("Body of the w", shown = "Body of the wal", open = false).shouldBeNull()
        // The save of "Body of the w" lands: CLEAN, a new baseline, the reload gate opens.
        t.answer("Body of the w", shown = "Body of the wal", open = true).shouldBeNull()
        t.answer("Body of the wa", shown = "Body of the wal", open = false).shouldBeNull()
        t.answer("Body of the wal", shown = "Body of the wal", open = true).shouldBeNull()
    }

    "the first save that mints the id does not take back what was typed after it" {
        val t = typed("", "W", "Wa", "Wal")
        t.answer("W", shown = "Wal", open = false).shouldBeNull()
        t.answer("W", shown = "Wal", open = true).shouldBeNull()
    }

    "a late echo while typing is never adopted" {
        val t = typed("", "a", "ab", "abc")
        t.answer("a", shown = "abc").shouldBeNull()
        t.answer("ab", shown = "abc").shouldBeNull()
    }

    "an echo of an emptied field is not a clear (typed x, erased it, typed y)" {
        val t = typed("", "x", "", "y")
        t.answer("x", shown = "y").shouldBeNull()
        t.answer("", shown = "y").shouldBeNull()
        t.answer("y", shown = "y").shouldBeNull()
    }

    "a clear after submit lands, even to a value the member once typed" {
        val t = typed("", "W", "", "Work")
        t.answer("Work", shown = "Work").shouldBeNull()
        t.answer("", shown = "Work") shouldBe ""
    }

    "a clear lands when the states between were conflated away" {
        val t = typed("", "a", "ab", "a")
        // The view only ever saw the final echo: every keystroke is heard.
        t.answer("a", shown = "a").shouldBeNull()
        t.answer("", shown = "a") shouldBe ""
    }

    "a value the member did not type lands (a splice, a remote load, a generated value)" {
        val t = typed("abc", "abcd")
        t.answer("abcd", shown = "abcd").shouldBeNull()
        t.answer("abcd [[Plan]]", shown = "abcd") shouldBe "abcd [[Plan]]"
    }

    "a closed gate holds a value the member did not type" {
        val t = typed("abc")
        t.answer("xyz", shown = "abc", open = false).shouldBeNull()
        t.answer("xyz", shown = "abc", open = true) shouldBe "xyz"
    }

    "typing back to the machine's stale value is still sent" {
        val t = TypedText("a")
        t.edited("ab") shouldBe true
        t.edited("a") shouldBe true
        t.edited("a") shouldBe false
        t.answer("ab", shown = "a").shouldBeNull()
        t.answer("a", shown = "a").shouldBeNull()
    }

    "after an adoption, the adopted value is not re-sent" {
        val t = typed("", "a")
        t.answer("a", shown = "a").shouldBeNull()
        t.answer("loaded", shown = "a") shouldBe "loaded"
        t.edited("loaded") shouldBe false
        t.edited("loaded!") shouldBe true
    }
})
