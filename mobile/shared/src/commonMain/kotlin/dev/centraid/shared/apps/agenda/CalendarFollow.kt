package dev.centraid.shared.apps.agenda

import dev.centraid.core.CentraidCore
import dev.centraid.shared.sync.phone.GoneChoice
import dev.centraid.shared.sync.phone.OriginGone
import dev.centraid.shared.sync.phone.PhoneFollowPass
import dev.centraid.shared.sync.phone.PhoneFollowReads
import dev.centraid.shared.sync.phone.PhoneFollowSource
import dev.centraid.shared.sync.phone.PhoneOriginRef
import dev.centraid.shared.sync.phone.PhoneSource
import kotlin.time.Clock

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
     * Read the calendars over [CalendarImport]'s window and hand them to [done], off the main
     * thread; **null when calendar access is not already granted**: a following pass never asks
     * the OS for permission.
     */
    public fun read(done: (CalendarRead?) -> Unit)
}

/** CALENDAR → AGENDA, FOLLOWED (#1127): the shell hands this to the follower with its [reader]. */
public class CalendarFollow(private val reader: CalendarReader) : PhoneFollowSource {
    override val source: PhoneSource = PhoneSource.CALENDAR

    override fun bind(core: CentraidCore): PhoneFollowPass = object : PhoneFollowPass {
        override suspend fun imported(): Boolean? = PhoneFollowReads.imported(core, PhoneSource.CALENDAR)

        override suspend fun run(): List<OriginGone>? {
            val read = PhoneFollowReads.await<CalendarRead> { reader.read(it) } ?: return null
            return CalendarImport.run(core, read.events, read.deviceTz, read.now, read.origins, read.complete).gone
        }

        override suspend fun resolve(gone: OriginGone, keep: Boolean) {
            CalendarImport.resolveGone(
                core,
                gone.originId,
                if (keep) GoneChoice.KEEP else GoneChoice.TRASH,
                // Resolving reads no window, so the zone and the instant are only placeholders.
                "",
                Clock.System.now().toEpochMilliseconds(),
                gone.seenBefore.ifEmpty { null },
            )
        }
    }
}
