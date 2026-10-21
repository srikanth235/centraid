package dev.centraid.shared.shell

import dev.centraid.design.copy.AgendaCopy
import dev.centraid.design.copy.DocsCopy
import dev.centraid.design.copy.HealthCopy
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.shared.sync.phone.GoneReason
import dev.centraid.shared.sync.phone.OriginGone
import dev.centraid.shared.sync.phone.PhoneSource

/**
 * THE WORDS OF THE QUESTION AN ORIGIN HELD LEAVES (R-1127-9), from `copy/people.json`,
 * `copy/agenda.json`, `copy/docs.json` and `copy/health.json`: "Google: ada@example.com is no longer on this phone" / "Keep its 214 events
 * in Agenda?". A shell draws what this returns and decides nothing.
 */
internal object PhoneFollowWords {
    fun question(gone: OriginGone): PhoneFollowQuestion {
        val words = words(gone.source)
        val left = gone.reason == GoneReason.LEFT
        val one = gone.count == 1
        val body = when {
            left && one -> words.leftOne
            left -> words.left
            one -> words.vanishedOne
            else -> words.vanished
        }
        return PhoneFollowQuestion(
            source = gone.source,
            originId = gone.originId,
            title = (if (left) words.leftTitle else words.vanishedTitle).replace("{label}", gone.label),
            body = body.replace("{count}", gone.count.toString()),
            keepLabel = words.keep,
            trashLabel = words.trash,
        )
    }

    private class Words(
        val leftTitle: String,
        val left: String,
        val leftOne: String,
        val vanishedTitle: String,
        val vanished: String,
        val vanishedOne: String,
        val keep: String,
        val trash: String,
    )

    private fun words(source: PhoneSource): Words = when (source) {
        PhoneSource.CALENDAR -> Words(
            AgendaCopy.IMPORT_GONE_ASK,
            AgendaCopy.IMPORT_GONE_KEEP_ASK,
            AgendaCopy.IMPORT_GONE_KEEP_ASK_ONE,
            AgendaCopy.IMPORT_VANISHED_ASK,
            AgendaCopy.IMPORT_VANISHED_KEEP_ASK,
            AgendaCopy.IMPORT_VANISHED_KEEP_ASK_ONE,
            AgendaCopy.IMPORT_GONE_KEEP,
            AgendaCopy.IMPORT_GONE_TRASH,
        )
        PhoneSource.FILES -> Words(
            DocsCopy.FOLDER_GONE_ASK,
            DocsCopy.FOLDER_GONE_KEEP_ASK,
            DocsCopy.FOLDER_GONE_KEEP_ASK_ONE,
            DocsCopy.FOLDER_VANISHED_ASK,
            DocsCopy.FOLDER_VANISHED_KEEP_ASK,
            DocsCopy.FOLDER_VANISHED_KEEP_ASK_ONE,
            DocsCopy.FOLDER_GONE_KEEP,
            DocsCopy.FOLDER_GONE_TRASH,
        )
        // A WORKOUT HAS NO TRASH (R-1129-2): the second answer deletes, and says so.
        PhoneSource.HEALTH -> Words(
            HealthCopy.FOLLOW_GONE_ASK,
            HealthCopy.FOLLOW_GONE_KEEP_ASK,
            HealthCopy.FOLLOW_GONE_KEEP_ASK_ONE,
            HealthCopy.FOLLOW_VANISHED_ASK,
            HealthCopy.FOLLOW_VANISHED_KEEP_ASK,
            HealthCopy.FOLLOW_VANISHED_KEEP_ASK_ONE,
            HealthCopy.FOLLOW_GONE_KEEP,
            HealthCopy.FOLLOW_GONE_TRASH,
        )
        PhoneSource.CONTACTS -> Words(
            PeopleCopy.IMPORT_GONE_ASK,
            PeopleCopy.IMPORT_GONE_KEEP_ASK,
            PeopleCopy.IMPORT_GONE_KEEP_ASK_ONE,
            PeopleCopy.IMPORT_VANISHED_ASK,
            PeopleCopy.IMPORT_VANISHED_KEEP_ASK,
            PeopleCopy.IMPORT_VANISHED_KEEP_ASK_ONE,
            PeopleCopy.IMPORT_GONE_KEEP,
            PeopleCopy.IMPORT_GONE_TRASH,
        )
    }
}
