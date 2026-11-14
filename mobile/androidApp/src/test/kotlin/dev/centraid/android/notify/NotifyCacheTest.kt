package dev.centraid.android.notify

import centraid.core.v1.PendingNotification
import centraid.core.v1.ScheduleNotifications
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NotifyCacheTest {
    private val hash = "a".repeat(64)

    @Test
    fun landedMainUnversionedRecordKeepsChannelsAndLiveIds() {
        val main = ScheduleNotifications(
            all = listOf(PendingNotification(notification_id = "backup", channel_id = "backup")),
            live_ids = listOf("task|already-fired"), backup_channel_name = "Backup warnings",
        )
        assertEquals(main, NotifyCache.decode(ScheduleNotifications.ADAPTER.encode(main), 0))
        assertEquals(main, NotifyCache.decode(ScheduleNotifications.ADAPTER.encode(main), NotifyCache.VERSION))
    }

    @Test
    fun fingerprintLikeCurrentChannelIsNeverGuessedToBeAnOldAudit() {
        val main = ScheduleNotifications(all = listOf(PendingNotification(channel_id = hash)), backup_channel_name = "Current name")
        assertEquals(main, NotifyCache.decode(ScheduleNotifications.ADAPTER.encode(main), 0))
    }

    @Test
    fun unmistakableAuditFieldsMoveToTheirAllocatedSlots() {
        // Old audit: Pending fingerprint=10; Schedule retain=5(bool), withdrawals=6(strings).
        val old = ScheduleNotifications(
            all = listOf(PendingNotification(notification_id = "task|a", channel_id = hash)),
            backup_channel_name = "task|withdraw",
        )
        val second = "task|second".toByteArray()
        val bytes = ScheduleNotifications.ADAPTER.encode(old) + byteArrayOf(0x32, second.size.toByte()) + second + byteArrayOf(0x28, 0x01)
        val migrated = NotifyCache.decode(bytes, 0)!!
        assertEquals(hash, migrated.all.single().source_fingerprint)
        assertEquals("", migrated.all.single().channel_id)
        assertEquals(true, migrated.retain_delivered)
        assertEquals(listOf("task|withdraw", "task|second"), migrated.cancel_delivered_ids)
        assertEquals("", migrated.backup_channel_name)
        assertEquals(migrated, NotifyCache.decode(ScheduleNotifications.ADAPTER.encode(migrated), NotifyCache.VERSION))
    }

    @Test
    fun currentAuditWireRoundTripsWithoutLegacyConversion() {
        val record = ScheduleNotifications(
            all = listOf(PendingNotification(channel_id = "backup", source_fingerprint = hash)),
            retain_delivered = true, cancel_delivered_ids = listOf("task|old"),
            live_ids = listOf("task|live"), backup_channel_name = "Backup warnings",
        )
        val bytes = ScheduleNotifications.ADAPTER.encode(record)
        assertEquals(record, NotifyCache.decode(bytes, 0))
        assertEquals(record, NotifyCache.decode(bytes, NotifyCache.VERSION))
    }

    @Test
    fun malformedOrUnknownVersionCacheWaitsForAuthoritativeSchedule() {
        assertNull(NotifyCache.decode(byteArrayOf(0x0a, 0x7f), 0))
        assertNull(NotifyCache.decode(byteArrayOf(0x28, 0x02), 0))
        assertNull(NotifyCache.decode(byteArrayOf(), NotifyCache.VERSION + 1))
        assertEquals(ScheduleNotifications(), NotifyCache.decode(byteArrayOf(), 0))
    }
}
