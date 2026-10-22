package dev.centraid.shared.apps.tasks

import centraid.core.v1.ActRequest
import dev.centraid.core.CentraidCore
import dev.centraid.design.copy.TasksCopy
import dev.centraid.shared.catalog.Act
import dev.centraid.shared.catalog.Field
import dev.centraid.shared.catalog.keyed
import dev.centraid.shared.kit.PhoneImport
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.sync.ActOutcome
import dev.centraid.shared.sync.ActionPlane
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

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
 * reminder becomes an added task with its notes and due day — an ordinary
 * task of the member's, no mark. Android has no system reminders, so its shell
 * offers nothing and draws Tasks' own action. Duplicates within the read (one
 * title, one due day) are folded.
 */
public object RemindersImport {
    @OptIn(ExperimentalUuidApi::class)
    public suspend fun run(core: CentraidCore, reminders: List<PhoneReminder>): PhoneImport.Outcome {
        var added = 0
        var refused = 0
        for (reminder in reminders(reminders)) {
            // A KEY PER WRITE: the core runs one key once, and two reminders may share a title.
            val request = request(reminder).keyed("import", Uuid.random().toString())
            if (ActionPlane.act(core, request) is ActOutcome.Executed) added += 1 else refused += 1
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

    /** The `add` for one reminder: its notes and due day when it has them. */
    public fun request(reminder: PhoneReminder): ActRequest = Act.Tasks.Add(
        title = reminder.title,
        description = if (reminder.notes.isEmpty()) Field.Keep else Field.Is(reminder.notes),
        due = if (reminder.due.isEmpty()) Field.Keep else Field.Is(reminder.due),
    )

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
