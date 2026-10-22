package dev.centraid.shared.apps.agenda

import dev.centraid.core.CentraidCore
import dev.centraid.shared.sync.phone.OriginGone
import dev.centraid.shared.sync.phone.PhoneFollowPass
import dev.centraid.shared.sync.phone.PhoneFollowReads
import dev.centraid.shared.sync.phone.PhoneFollowSource
import dev.centraid.shared.sync.phone.PhoneOriginRef
import dev.centraid.shared.sync.phone.PhoneSource

/** WHAT THE SHELL READ OF THE CALENDARS for a following pass: [CalendarImportBridge.sync]'s arguments. */
public data class CalendarRead(
    public val events: List<PhoneEvent>,
    public val origins: List<PhoneOriginRef>,
    public val complete: Boolean,
    public val deviceTz: String,
    public val now: Long,
)

/** THE SHELL'S CALENDAR READER: iOS EventKit, Android `CalendarContract`. */
public interface CalendarReader {
    /**
     * Read the calendars over [CalendarImport]'s window and hand them to [deliver], off the main
     * thread; **null when calendar access is not already granted**: a following pass never asks
     * the OS for permission.
     */
    public fun read(deliver: (CalendarRead?) -> Unit)
}

/**
 * CALENDAR → AGENDA, FOLLOWED (#1127, #1135): the shell hands this to the follower with its
 * [reader]. A pass sends the calendars to the vault, which merges them ([CalendarImport.run]);
 * nothing is held for a question, because the vault decides what an event gone from a read does
 * (one the member never edited goes to the trash, one they did keeps the row and stops following).
 */
public class CalendarFollow(private val reader: CalendarReader) : PhoneFollowSource {
    override val source: PhoneSource = PhoneSource.CALENDAR

    override fun bind(core: CentraidCore): PhoneFollowPass = object : PhoneFollowPass {
        override suspend fun imported(): Boolean? = PhoneFollowReads.imported(core, PhoneSource.CALENDAR)

        override suspend fun run(): List<OriginGone>? {
            val read = PhoneFollowReads.await<CalendarRead> { reader.read(it) } ?: return null
            CalendarImport.run(core, read.events, read.deviceTz, read.now, read.origins, read.complete)
            return emptyList()
        }

        override suspend fun resolve(gone: OriginGone, keep: Boolean) = Unit
    }
}
