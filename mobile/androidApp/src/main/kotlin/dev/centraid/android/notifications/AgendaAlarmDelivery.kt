package dev.centraid.android.notifications

import centraid.core.v1.AgendaAlert
import centraid.core.v1.AgendaNotificationSync

/** Validate the alarm handed to Android, independently of the next future plan. */
internal fun agendaAlarmMayFire(plan: AgendaNotificationSync, vault: String, alert: AgendaAlert, now: Long): Boolean =
    vault.isNotEmpty() && plan.vault_id == vault && alert.fire_at_ms <= now &&
        plan.sources.any { it.entity_id == alert.entity_id && it.source_stamp == alert.source_stamp } &&
        plan.snoozed.none { it.id == alert.id && it.fire_at_ms > now && it.fire_at_ms != alert.fire_at_ms }
