package dev.centraid.shared

import centraid.screen.v1.Confirm
import dev.centraid.shared.shell.PhoneFollowWords
import dev.centraid.shared.sync.phone.GoneReason
import dev.centraid.shared.sync.phone.OriginGone
import dev.centraid.shared.sync.phone.PhoneSource
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

/** The words of the held-origin question (R-1127-9), from the copy and nowhere else. */
class PhoneFollowWordsSpec : StringSpec({
    fun gone(source: PhoneSource, count: Int, reason: GoneReason) =
        OriginGone(source, "o1", "calendar:work", "Work", count, reason)

    "an origin that left: People counts people, Agenda counts events, one is singular" {
        PhoneFollowWords.question(gone(PhoneSource.CONTACTS, 12, GoneReason.LEFT)).body shouldBe "Keep its 12 people in People?"
        PhoneFollowWords.question(gone(PhoneSource.CONTACTS, 1, GoneReason.LEFT)).body shouldBe "Keep its 1 person in People?"
        PhoneFollowWords.question(gone(PhoneSource.CALENDAR, 214, GoneReason.LEFT)).body shouldBe "Keep its 214 events in Agenda?"
        PhoneFollowWords.question(gone(PhoneSource.CALENDAR, 1, GoneReason.LEFT)).body shouldBe "Keep its 1 event in Agenda?"
        PhoneFollowWords.question(gone(PhoneSource.CALENDAR, 2, GoneReason.LEFT)).title shouldBe "Work is no longer on this phone"
    }

    "an origin that lost most of its rows says so, and counts what is missing" {
        val asked = PhoneFollowWords.question(gone(PhoneSource.CALENDAR, 9, GoneReason.VANISHED))
        asked.title shouldBe "Most of Work is missing from this phone"
        asked.body shouldBe "Keep the 9 events missing from it in Agenda?"
        PhoneFollowWords.question(gone(PhoneSource.CONTACTS, 1, GoneReason.VANISHED)).body shouldBe
            "Keep the 1 person missing from it in People?"
    }

    "the question carries the origin it is about, and Keep is the first of the two answers" {
        val asked = PhoneFollowWords.question(gone(PhoneSource.CONTACTS, 3, GoneReason.LEFT))
        asked.originId shouldBe "o1"
        asked.source shouldBe PhoneSource.CONTACTS
        asked.keepLabel shouldBe "Keep"
        asked.trashLabel shouldBe "Move to trash"
    }

    "the question is the kit's destructive confirm: Move to trash is its verb, Keep its cancel" {
        val asked = PhoneFollowWords.question(gone(PhoneSource.CALENDAR, 4, GoneReason.LEFT))
        asked.confirm shouldBe Confirm(
            title = "Work is no longer on this phone",
            body = "Keep its 4 events in Agenda?",
            confirm_label = "Move to trash",
            destructive = true,
        )
        Confirm.ADAPTER.decode(asked.confirmBytes) shouldBe asked.confirm
    }
})
