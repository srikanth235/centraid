package dev.centraid.shared

import dev.centraid.design.copy.AgendaCopy
import dev.centraid.shared.kit.PhoneImport
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

/** What a made vault's imports say on the status line, and where its one action goes (R-ONBOARD-8). */
class PhoneImportSpec : StringSpec({
    // CONTACTS → PEOPLE is Rust's now (#1135), so a stand-in outcome that ends in the shared verb.
    val people = "6 people imported"
    val event = AgendaCopy.IMPORT_CALENDAR_ONE
    val none = AgendaCopy.IMPORT_CALENDAR_NONE

    "the shared verb closes the list once: one fragment, not a clause per app" {
        PhoneImport.madeSummary(listOf(people, event)) shouldBe "6 people, 1 event imported"
    }

    "one outcome is said as it is, and an import with nothing to bring says nothing" {
        PhoneImport.madeSummary(listOf(people)) shouldBe "6 people imported"
        PhoneImport.madeSummary(listOf(none, people)) shouldBe "6 people imported"
        PhoneImport.madeSummary(listOf(none)) shouldBe ""
    }

    "the line opens the first app that received anything" {
        PhoneImport.madeOpens(listOf("people", "agenda"), listOf(people, event)) shouldBe "people"
        PhoneImport.madeOpens(listOf("agenda", "people"), listOf(none, people)) shouldBe "people"
        PhoneImport.madeOpens(listOf("agenda"), listOf(none)) shouldBe ""
        PhoneImport.openLabel("people") shouldBe "Open People"
        PhoneImport.openLabel("") shouldBe ""
        PhoneImport.openLabel("agenda") shouldBe "Open Agenda"
    }
})
