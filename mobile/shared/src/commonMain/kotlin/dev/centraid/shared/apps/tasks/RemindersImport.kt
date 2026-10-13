package dev.centraid.shared.apps.tasks

import dev.centraid.core.CentraidCore
import dev.centraid.design.copy.TasksCopy
import dev.centraid.shared.kit.PhoneImport
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * ONE OPEN REMINDER AS THE PHONE HOLDS IT, read by the shell (iOS EventKit)
 * after the member tapped "Import reminders" and the OS asked its own
 * permission. A completed reminder is never handed over.
 *
 * @property title the reminder's title; one with none is skipped.
 * @property notes its notes, or empty.
 * @property due its due day, `YYYY-MM-DD`, or empty for none.
 */
public data class PhoneReminder(
    public val title: String,
    public val notes: String = "",
    public val due: String = "",
)

/**
 * REMINDERS → TASKS IN ONE TAP (docs/decisions.md, "Onboarding without sample
 * data", R-ONBOARD-4).
 *
 * Tasks' day one offers the import (`EmptyState.import_source`); each open
 * reminder becomes `schedule.add_task` with its notes and due day — an ordinary
 * task of the member's, no mark. Android has no system reminders, so its shell
 * offers nothing and draws Tasks' own action. Duplicates within the read (one
 * title, one due day) are folded.
 */
public object RemindersImport {
    public suspend fun run(core: CentraidCore, reminders: List<PhoneReminder>): PhoneImport.Outcome {
        var added = 0
        var refused = 0
        for (reminder in reminders(reminders)) {
            if (PhoneImport.write(core, "schedule.add_task", input(reminder))) added += 1 else refused += 1
        }
        return PhoneImport.Outcome(added = added, refused = refused)
    }

    /** The tasks a read makes: titled, trimmed, one per title and due day. */
    public fun reminders(reminders: List<PhoneReminder>): List<PhoneReminder> {
        val seen = mutableSetOf<String>()
        return reminders.mapNotNull { reminder ->
            val title = reminder.title.trim()
            if (title.isEmpty() || !seen.add("${title.lowercase()}|${reminder.due}")) return@mapNotNull null
            PhoneReminder(
                title = title,
                notes = reminder.notes.trim(),
                due = reminder.due.takeIf { DAY.matches(it) }.orEmpty(),
            )
        }
    }

    /** `schedule.add_task`'s input for one reminder. */
    public fun input(reminder: PhoneReminder): String {
        val fields = mutableListOf("\"title\":${PhoneImport.quote(reminder.title)}")
        if (reminder.notes.isNotEmpty()) fields += "\"description\":${PhoneImport.quote(reminder.notes)}"
        if (reminder.due.isNotEmpty()) fields += "\"due_at\":${PhoneImport.quote(reminder.due)}"
        return fields.joinToString(",", prefix = "{", postfix = "}")
    }

    /** The one sentence the shell shows when an import ends. */
    public fun sentence(outcome: PhoneImport.Outcome): String = when {
        outcome.added == 0 && outcome.refused == 0 -> TasksCopy.IMPORT_REMINDERS_NONE
        outcome.added == 0 -> TasksCopy.IMPORT_REMINDERS_FAILED
        outcome.added == 1 -> TasksCopy.IMPORT_REMINDERS_ONE
        else -> TasksCopy.IMPORT_REMINDERS_DONE.replace("{count}", outcome.added.toString())
    }

    private val DAY = Regex("^\\d{4}-\\d{2}-\\d{2}$")
}

/**
 * WHAT SWIFTUI HOLDS FOR THE REMINDERS IMPORT. Writes go to the member's
 * foreground vault.
 */
public class RemindersImportBridge {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var session: HomeSession? = null

    public fun attach(session: HomeSession) {
        this.session = session
    }

    /** Import [reminders]; [onDone] is handed the sentence to show. */
    public fun run(reminders: List<PhoneReminder>, onDone: (String) -> Unit) {
        val core = session?.shelf?.core() ?: return onDone(TasksCopy.IMPORT_REMINDERS_NO_VAULT)
        scope.launch { onDone(RemindersImport.sentence(RemindersImport.run(core, reminders))) }
    }
}
