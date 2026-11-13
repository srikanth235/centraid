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
     * PENDING AND DELIVERED ARE SEPARATE (#1188, A2). What to do to make the OS hold what Rust wants:
     *
     * - [removePending]: alarms set for ids that are no longer wanted to come, or that are already past.
     * - [removeShowing]: notifications on the screen whose id is in NEITHER the wanted set NOR [live],
     *   Rust's ids of reminders already fired and still wanted. TIME PASSING NEVER REMOVES A DELIVERED
     *   REMINDER; RESOLVING THE ITEM DOES.
     * - [schedule]: every timed one still to come, set again whether or not it changed (the same request
     *   code replaces it).
     * - [post]: every immediate one not already showing.
     *
     * Pure, and tested against the one fixture the iOS shell reads too (`contracts/notify/reconcile-cases.json`).
     */
    class Plan(
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
    ): Plan {
        // THE LAST OF A REPEATED ID WINS, as a replace by id would.
        val next = LinkedHashMap<String, PendingNotification>()
        wanted.forEach { next[it.notification_id] = it }
        val schedule = next.values.filter { !it.immediate && it.fire_at_ms > nowMs }
        val scheduled = schedule.map { it.notification_id }.toSet()
        val keep = next.keys + live
        return Plan(
            removePending = pending.filter { it !in scheduled }.distinct().sorted(),
            removeShowing = showing.filter { it !in keep }.distinct().sorted(),
            schedule = schedule,
            post = next.values.filter { it.immediate && it.notification_id !in showing },
        )
    }

    /** What the record keeps after [reconcile]: everything wanted that is still to come, and the immediates. */
    fun kept(wanted: List<PendingNotification>, nowMs: Long): List<PendingNotification> {
        val next = LinkedHashMap<String, PendingNotification>()
        wanted.forEach { next[it.notification_id] = it }
        return next.values.filter { it.immediate || it.fire_at_ms > nowMs }
    }

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
