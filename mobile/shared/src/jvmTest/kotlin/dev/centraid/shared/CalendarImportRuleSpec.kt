package dev.centraid.shared

import dev.centraid.shared.apps.agenda.CalendarImport
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

/**
 * `CalendarImport.rule` (#1119, R-1119-1): the repeat rule as the vault takes it.
 *
 * The vault's one expander takes a `FREQ=MONTHLY` rule with ONE positional
 * `BYDAY` or ONE `BYMONTHDAY`, so the import keeps both; it still refuses
 * `BYSETPOS`, a `BYDAY` or `BYMONTHDAY` list and the rest, so those are left
 * in the rule for the vault to refuse (the import then writes the window's
 * occurrences one by one). `crates/vault/src/time/rrule.rs` is the rule's home.
 */
class CalendarImportRuleSpec : StringSpec({

    val fifteenth = "2026-03-15T09:00:00"
    val thirtyFirst = "2026-03-31T09:00:00"

    "a monthly BYMONTHDAY stays, on the anchor's day or not" {
        CalendarImport.rule("RRULE:FREQ=MONTHLY;BYMONTHDAY=15", fifteenth) shouldBe "FREQ=MONTHLY;BYMONTHDAY=15"
        CalendarImport.rule("FREQ=MONTHLY;BYMONTHDAY=31", thirtyFirst) shouldBe "FREQ=MONTHLY;BYMONTHDAY=31"
        CalendarImport.rule("FREQ=MONTHLY;BYMONTHDAY=-1", thirtyFirst) shouldBe "FREQ=MONTHLY;BYMONTHDAY=-1"
        CalendarImport.rule("FREQ=MONTHLY;BYMONTHDAY=1", fifteenth) shouldBe "FREQ=MONTHLY;BYMONTHDAY=1"
    }

    "a monthly positional BYDAY stays" {
        CalendarImport.rule("RRULE:FREQ=MONTHLY;BYDAY=2MO", fifteenth) shouldBe "FREQ=MONTHLY;BYDAY=2MO"
        CalendarImport.rule("FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR", thirtyFirst) shouldBe "FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR"
    }

    "what the vault still refuses is left in the rule for the vault to refuse" {
        CalendarImport.rule("FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2", fifteenth) shouldBe "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2"
        CalendarImport.rule("FREQ=MONTHLY;BYMONTHDAY=1,15", fifteenth) shouldBe "FREQ=MONTHLY;BYMONTHDAY=1,15"
        CalendarImport.rule("FREQ=MONTHLY;BYDAY=2MO,3TU", fifteenth) shouldBe "FREQ=MONTHLY;BYDAY=2MO,3TU"
    }

    "a part that only restates the anchor still goes, where the vault takes no such part" {
        CalendarImport.rule("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15", fifteenth) shouldBe "FREQ=YEARLY"
        CalendarImport.rule("FREQ=WEEKLY;BYDAY=MO;WKST=MO", fifteenth) shouldBe "FREQ=WEEKLY;BYDAY=MO"
        CalendarImport.rule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=MO", fifteenth) shouldBe "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=MO"
    }

    "no rule, or no start, is no rule" {
        CalendarImport.rule("", fifteenth) shouldBe ""
        CalendarImport.rule("FREQ=MONTHLY;BYMONTHDAY=15", "") shouldBe ""
    }
})
