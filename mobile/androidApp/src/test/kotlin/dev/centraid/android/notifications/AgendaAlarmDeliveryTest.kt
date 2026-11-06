package dev.centraid.android.notifications

import centraid.core.v1.AgendaAlert
import centraid.core.v1.AgendaNotificationSource
import centraid.core.v1.AgendaNotificationSync
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AgendaAlarmDeliveryTest {
    private val delivered = AgendaAlert(id = "daily", entity_id = "task", source_stamp = "v1", fire_at_ms = 100)
    private val plan = AgendaNotificationSync(vault_id = "vault", sources = listOf(AgendaNotificationSource(entity_id = "task", source_stamp = "v1")))

    @Test fun aQueuedOccurrenceStillFiresAfterTheFuturePlanAdvancesOrDropsIt() {
        assertTrue(agendaAlarmMayFire(plan, "vault", delivered, 101))
        val next = delivered.copy(fire_at_ms = 200)
        assertTrue(agendaAlarmMayFire(plan.copy(alerts = listOf(next)), "vault", delivered, 101))
        assertFalse(agendaAlarmMayFire(plan.copy(alerts = listOf(next)), "vault", next, 101))
    }

    @Test fun snoozeSuppressesTheOldOccurrenceAndAllowsItsOwnDuePayload() {
        val snoozed = delivered.copy(fire_at_ms = 300)
        val later = plan.copy(alerts = listOf(snoozed), snoozed = listOf(snoozed))
        assertFalse(agendaAlarmMayFire(later, "vault", delivered, 101))
        assertTrue(agendaAlarmMayFire(later, "vault", snoozed, 301))
    }

    @Test fun switchingVaultEditingAndDeletionInvalidateQueuedPayloads() {
        assertFalse(agendaAlarmMayFire(plan, "another-vault", delivered, 101))
        assertFalse(agendaAlarmMayFire(plan.copy(sources = emptyList()), "vault", delivered, 101))
        assertFalse(agendaAlarmMayFire(plan.copy(sources = listOf(AgendaNotificationSource(entity_id = "task", source_stamp = "v2"))), "vault", delivered, 101))
    }
}
