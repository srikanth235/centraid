package dev.centraid.android.notify

import centraid.core.v1.ScheduleNotifications
import com.squareup.wire.FieldEncoding
import com.squareup.wire.ProtoReader
import okio.Buffer

/** This device's alarm cache only: never a vault migration or a reason to remove app data. */
internal object NotifyCache {
    const val VERSION: Int = 1
    private val fingerprint = Regex("[0-9a-f]{64}")

    fun decode(bytes: ByteArray, version: Int): ScheduleNotifications? = runCatching {
        when (version) {
            VERSION -> ScheduleNotifications.ADAPTER.decode(bytes)
            0 -> legacyAudit(bytes) ?: ScheduleNotifications.ADAPTER.decode(bytes)
            else -> null // A future/invalid cache waits for the next authoritative schedule.
        }
    }.getOrNull()

    private fun legacyAudit(bytes: ByteArray): ScheduleNotifications? {
        // Main's unversioned wire is compatible. Only the old audit's *different wire type* at
        // field 5 AND its unmistakable misplaced fingerprints permit a cache-only conversion.
        val reader = ProtoReader(Buffer().write(bytes))
        val token = reader.beginMessage()
        var retain: Boolean? = null
        var mainLiveIds = false
        val withdrawn = mutableListOf<String>()
        while (true) {
            val tag = reader.nextTag()
            if (tag == -1) break
            when {
                tag == 5 && reader.peekFieldEncoding() == FieldEncoding.VARINT -> {
                    val value = reader.readVarint32()
                    require(value == 0 || value == 1)
                    retain = value == 1
                }
                tag == 6 && reader.peekFieldEncoding() == FieldEncoding.LENGTH_DELIMITED -> withdrawn += reader.readString()
                else -> {
                    if (tag == 5) mainLiveIds = true
                    reader.readUnknownField(tag)
                }
            }
        }
        val otherFields = reader.endMessageAndGetUnknownFields(token)
        if (retain == null || mainLiveIds) return null
        val record = ScheduleNotifications.ADAPTER.decode(otherFields)
        if (record.all.none { fingerprint.matches(it.channel_id) && it.source_fingerprint.isEmpty() }) return null
        if (record.all.any { it.source_fingerprint.isNotEmpty() || (it.channel_id.isNotEmpty() && !fingerprint.matches(it.channel_id)) }) return null
        return record.copy(
            all = record.all.map { it.copy(source_fingerprint = it.channel_id, channel_id = "") },
            retain_delivered = retain,
            cancel_delivered_ids = withdrawn,
            backup_channel_name = "",
        )
    }
}
