package dev.centraid.android.kit

import centraid.core.v1.BackupCheckAction
import centraid.core.v1.BackupCheckState
import centraid.core.v1.BackupCheckTone

/**
 * WHAT THE CHECK PAGE DRAWS AND WHAT A TAP SENDS, as data (#1188, B13). The page reads these, and the
 * one fixture both shells are held to (`contracts/backup/check-controls.json`) reads them too, so the
 * SwiftUI page and this one cannot drift apart: the same state shows the same selectors, in the same
 * order, and the same tap sends the same event.
 */
internal object BackupCheckControls {
    const val INTRO = "backup-check-intro"
    const val HEADING = "backup-check-heading"
    const val BAR = "backup-check-bar"
    const val START = "backup-check-start"
    const val STOP = "backup-check-stop"
    const val BACK_UP_NOW = "backup-check-back-up-now"

    fun rowTag(gatewayId: String): String = "backup-check-row-$gatewayId"

    /** The selector ids drawn for [state], top to bottom. */
    fun shown(state: BackupCheckState): List<String> = buildList {
        add(INTRO)
        if (state.heading.isNotEmpty()) add(HEADING)
        state.rows.forEach { add(rowTag(it.gateway_id)) }
        if (state.rows.isNotEmpty() && state.running) add(BAR)
        actionTag(state)?.let { add(it) }
        if (state.back_up_now_label.isNotEmpty()) add(BACK_UP_NOW)
    }

    /** The button's selector: Stop while a check runs, Start when one may begin, none otherwise. */
    fun actionTag(state: BackupCheckState): String? = when {
        state.action == BackupCheckAction.BACKUP_CHECK_ACTION_NONE || state.action_label.isEmpty() -> null
        state.action == BackupCheckAction.BACKUP_CHECK_ACTION_STOP -> STOP
        else -> START
    }

    /** The event name a tap on [tag] sends. */
    fun eventFor(tag: String): String? = when (tag) {
        START -> "start"
        STOP -> "stop"
        BACK_UP_NOW -> "back_up_now"
        else -> null
    }

    /** How a row's second line is inked. */
    fun ink(tone: BackupCheckTone): String = when (tone) {
        BackupCheckTone.BACKUP_CHECK_TONE_BAD -> "bad"
        BackupCheckTone.BACKUP_CHECK_TONE_OK -> "ok"
        else -> "quiet"
    }
}
