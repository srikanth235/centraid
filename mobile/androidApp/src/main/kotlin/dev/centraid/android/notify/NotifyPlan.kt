package dev.centraid.android.notify

import android.annotation.SuppressLint
import centraid.core.v1.PendingNotification
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * THE DECISIONS OF THE NOTIFICATION PERFORMER THAT NEED NO ANDROID (#1173), so a JVM test reads them.
 *
 * Which notifications exist, when they fire and what they say is Rust's (`crates/screens/src/agenda/notify`).
 * This is only the bookkeeping a performer owes it: whether the permission lets anything be held, which
 * alarms to take down and which to set when the whole desired set arrives, and which kind of alarm the
 * platform will give.
 */
internal object NotifyPlan {
    /** What the permission allows right now; [ASK] means the member is to be asked and the answer decides. */
    enum class Gate { GRANTED, DENIED, NOT_ASKED, ASK }

    /**
     * Below API 33 there is no runtime permission: notifications are on, or the member turned them
     * off in settings (denied). From 33 the grant is `POST_NOTIFICATIONS`; a grant with the app's
     * notifications switched off is still denied. Never asked is asked only when [askPermission]
     * (Rust: `all` holds something that would fire), and only once: after that a refusal is denied.
     */
    fun gate(sdk: Int, permissionHeld: Boolean, enabled: Boolean, asked: Boolean, askPermission: Boolean): Gate = when {
        sdk < 33 -> if (enabled) Gate.GRANTED else Gate.DENIED
        permissionHeld -> if (enabled) Gate.GRANTED else Gate.DENIED
        asked -> Gate.DENIED
        askPermission -> Gate.ASK
        else -> Gate.NOT_ASKED
    }

    /**
     * WHAT THE MEMBER'S ANSWER TO THE PROMPT MEANS. A "yes" is a grant: the answer is trusted over
     * `areNotificationsEnabled()`, which can still read false for a moment after the system sheet
     * closes, and recording a denial then would keep the editor saying "Notifications are off" until
     * a restart. Only a "no" is denied.
     */
    fun afterAsk(answer: Boolean): Gate = if (answer) Gate.GRANTED else Gate.DENIED

    /**
     * PENDING AND DELIVERED ARE SEPARATE (#1188, A2). What to do to make the OS hold what Rust wants:
     *
     * - [removePending]: alarms set for ids that are no longer wanted to come, or that are already past.
     * - [removeShowing]: notifications on the screen whose id is in NEITHER the wanted set NOR [live],
     *   Rust's ids of reminders already fired and still wanted. TIME PASSING NEVER REMOVES A DELIVERED
     *   REMINDER; RESOLVING THE ITEM DOES.
     * - [schedule]: every timed one still to come, set again whether or not it changed (the same request
     *   code replaces it).
     * - [post]: immediate offers not showing and not previously delivered during this offer.
     * Explicit retention leaves delivered cards alone except the ids Rust withdraws.
     *
     * Pure, and tested against the one fixture the iOS shell reads too (`contracts/notify/reconcile-cases.json`).
     */
    class Plan(
        /** Timed items whose moment has just passed and whose alarm has not yet been delivered: left alone. */
        val late: List<PendingNotification>,
        val removePending: List<String>,
        val removeShowing: List<String>,
        val schedule: List<PendingNotification>,
        val post: List<PendingNotification>,
    )

    /**
     * [pending] are the ids this phone has an alarm for, [showing] the ids of the notifications the OS
     * is actually showing for this app (not what was once recorded).
     */
    fun reconcile(
        wanted: List<PendingNotification>,
        live: List<String>,
        pending: Collection<String>,
        showing: Collection<String>,
        nowMs: Long,
        retainDelivered: Boolean = false,
        explicitIds: Collection<String> = emptyList(),
        seenImmediateIds: Set<String> = emptySet(),
        recorded: List<PendingNotification> = emptyList(),
    ): Plan {
        // THE LAST OF A REPEATED ID WINS, as a replace by id would.
        val next = LinkedHashMap<String, PendingNotification>()
        wanted.forEach { next[it.notification_id] = it }
        val schedule = next.values.filter { !it.immediate && it.fire_at_ms > nowMs }
        val scheduled = schedule.map { it.notification_id }.toSet()
        val keep = next.keys + live
        // A TIMED ONE WHOSE MOMENT HAS JUST PASSED AND WHOSE ALARM HAS NOT YET SOUNDED IS NOT CANCELLED,
        // BUT ONLY WHILE RUST STILL WANTS IT. Rust sends only what is still to come, so a resync in the
        // minutes an inexact alarm runs late would take the alarm down and the reminder would never
        // alert. Absence from the new set cannot tell "late" from "resolved": Rust's [live] (the items
        // whose moment has passed and that are still open) can. A task completed, deleted or moved
        // (its id embeds the moment) is not in it, so its alarm goes. A delivered one leaves the record
        // at once ([NotifyStore.deliveredTimed]), so what is recorded here is undelivered.
        val late = recorded.filter {
            !it.immediate && it.notification_id !in scheduled && it.notification_id in live &&
                it.fire_at_ms <= nowMs && nowMs - it.fire_at_ms < LATE_GRACE_MS
        }.associateBy { it.notification_id }.values.toList()
        val lateIds = late.map { it.notification_id }.toSet()
        return Plan(
            late = late,
            removePending = pending.filter { it !in scheduled && it !in lateIds }.distinct().sorted(),
            removeShowing = showing.filter { it in explicitIds || (!retainDelivered && it !in keep) }.distinct().sorted(),
            schedule = schedule,
            post = next.values.filter { it.immediate && it.notification_id !in showing && it.notification_id !in seenImmediateIds },
        )
    }

    /** Keep dismissal memory only for the currently offered immediate ids, never an unbounded log. */
    fun rememberedImmediates(current: Set<String>, previous: Set<String>, showing: Set<String>): Set<String> =
        (previous + showing).intersect(current)

    /** What the record keeps after [reconcile]: future alarms, the immediate offers and the [late] ones. */
    fun kept(wanted: List<PendingNotification>, nowMs: Long, late: List<PendingNotification> = emptyList()): List<PendingNotification> {
        val next = LinkedHashMap<String, PendingNotification>()
        wanted.forEach { next[it.notification_id] = it }
        val still = next.values.filter { it.immediate || it.fire_at_ms > nowMs }
        return still + late.filter { it.notification_id !in next }
    }

    /** How long after its moment an undelivered alarm is still owed: an inexact alarm runs minutes late. */
    const val LATE_GRACE_MS: Long = 10 * 60 * 1000L

    /** Exact while the platform lets this app (always below API 31); otherwise the inexact alarm. */
    fun exact(sdk: Int, canScheduleExact: Boolean): Boolean = sdk < 31 || canScheduleExact

    /** A stable code per id: `String.hashCode` is specified, so it survives a restart of the process. */
    fun requestCode(notificationId: String): Int = notificationId.hashCode()

    /**
     * The instant a notification names, read again from its wall clock and zone, so a zone change or a
     * reboot keeps the reminder at the time the member chose. Before API 26 there is no java.time and
     * the instant Rust sent is used; so it is when the pair does not parse.
     */
    fun fireInstant(sdk: Int, item: PendingNotification): Long =
        if (sdk < 26) item.fire_at_ms else runCatching { instantOf(item.fire_local, item.zone) }.getOrDefault(item.fire_at_ms)

    // Reached only when [fireInstant] saw API 26 or later.
    @SuppressLint("NewApi")
    private fun instantOf(local: String, zone: String): Long =
        LocalDateTime.parse(local).atZone(ZoneId.of(zone)).toInstant().toEpochMilli()
}
