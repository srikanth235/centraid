package dev.centraid.shared

import dev.centraid.design.copy.AgendaCopy
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.design.copy.TasksCopy
import dev.centraid.shared.kit.PhoneImport
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

/** What a made vault's imports say on the status line, and where its one action goes (R-ONBOARD-8). */
class PhoneImportSpec : StringSpec({
    val people = PeopleCopy.IMPORT_CONTACTS_DONE.replace("{count}", "6")
    val event = AgendaCopy.IMPORT_CALENDAR_ONE
    val tasks = TasksCopy.IMPORT_REMINDERS_DONE.replace("{count}", "3")

    "the shared verb closes the list once: one fragment, not a clause per app" {
        PhoneImport.madeSummary(listOf(people, event)) shouldBe "6 people, 1 event imported"
        PhoneImport.madeSummary(listOf(people, event, tasks)) shouldBe "6 people, 1 event, 3 tasks imported"
    }

    "one outcome is said as it is, and an import with nothing to bring says nothing" {
        PhoneImport.madeSummary(listOf(people)) shouldBe "6 people imported"
        PhoneImport.madeSummary(listOf(PeopleCopy.IMPORT_CONTACTS_NONE, event)) shouldBe "1 event imported"
        PhoneImport.madeSummary(listOf(PeopleCopy.IMPORT_CONTACTS_NONE)) shouldBe ""
    }

    "the line opens the first app that received anything" {
        PhoneImport.madeOpens(listOf("people", "agenda"), listOf(people, event)) shouldBe "people"
        PhoneImport.madeOpens(listOf("people", "agenda"), listOf(PeopleCopy.IMPORT_CONTACTS_NONE, event)) shouldBe "agenda"
        PhoneImport.madeOpens(listOf("people"), listOf(PeopleCopy.IMPORT_CONTACTS_NONE)) shouldBe ""
        PhoneImport.openLabel("people") shouldBe "Open People"
        PhoneImport.openLabel("") shouldBe ""
        // Reminders land in the tasks domain, which opens in Agenda (#1128, R-1128-7).
        PhoneImport.openLabel("tasks") shouldBe "Open Agenda"
    }
})
