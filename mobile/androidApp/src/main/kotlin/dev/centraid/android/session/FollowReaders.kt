package dev.centraid.android.session

import android.content.Context
import android.database.Cursor
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.provider.ContactsContract
import android.provider.CalendarContract
import dev.centraid.android.kit.PhoneOrigins
import centraid.core.v1.ShellStoreRead
import centraid.core.v1.DeviceDelete
import centraid.core.v1.DeviceGet
import centraid.core.v1.DevicePut
import centraid.core.v1.DeviceRequest
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import dev.centraid.core.CentraidCore
import java.io.File
import java.io.FileOutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject

internal object FollowReaders {
    suspend fun files(context: Context, core: CentraidCore, refs: List<String>): String = withContext(Dispatchers.IO) {
        val snapshots = JSONArray()
        for (ref in refs) {
            val tree = FollowFolderGrants.resolve(core, ref) ?: error("the folder grant is unavailable")
            snapshots.put(fileSnapshot(context, core, tree, ref))
        }
        JSONObject().put("snapshots", snapshots).toString()
    }

    private suspend fun fileSnapshot(context: Context, core: CentraidCore, tree: Uri, originRef: String): JSONObject {
        val resolver = context.contentResolver
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        val rootUri = DocumentsContract.buildDocumentUriUsingTree(tree, rootId)
        val rootName = resolver.query(rootUri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            .requireStoreRead().use { cursor -> if (cursor.moveToFirst()) cursor.getString(0).orEmpty() else "Folder" }
        val records = JSONArray()
        val skipped = mutableListOf<String>()
        val pending = ArrayDeque<Pair<String, String>>()
        pending.add(rootId to "")
        val visited = mutableSetOf(rootId)
        val columns = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
        )
        var count = 0
        var entries = 0
        var truncated = false
        while (pending.isNotEmpty() && !truncated) {
            val (documentId, prefix) = pending.removeFirst()
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, documentId)
            resolver.query(children, columns, null, null, null).requireStoreRead().use { cursor ->
                while (cursor.moveToNext()) {
                    entries++
                    if (entries > MAX_FOLLOW_TREE_ENTRIES) {
                        truncated = true
                        break
                    }
                    val id = cursor.getString(0) ?: error("folder child had no id")
                    val name = cursor.getString(1).orEmpty()
                    val mime = cursor.getString(2).orEmpty().ifBlank { "application/octet-stream" }
                    if (name.isBlank() || name.startsWith(".")) continue
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                        if (!visited.add(id)) {
                            truncated = true
                            break
                        }
                        pending.add(id to "$prefix$name/")
                        continue
                    }
                    count++
                    if (count > MAX_FOLLOW_FILES) {
                        truncated = true
                        break
                    }
                    val relative = prefix + name
                    val uri = DocumentsContract.buildDocumentUriUsingTree(tree, id)
                    val size = if (cursor.isNull(3)) 0L else cursor.getLong(3).coerceAtLeast(0L)
                    try {
                        val stream = resolver.openInputStream(uri) ?: error("folder file could not be read")
                        val staged = stream.use { input ->
                            Stage.stage(core, mime, size, read = Stage.slices(input))
                        }
                        val handle = (staged as? Stage.Outcome.Staged)?.handle ?: error("file staging failed")
                        records.put(JSONObject()
                            .put("external_id", relative)
                            .put("size", handle.byte_size)
                            .put("fields", JSONObject()
                                .put("title", name)
                                .put("blob", handle.content_hash)
                                .put("media_type", mime)
                                .put("stat", size.toString())))
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        skipped += relative
                    }
                }
            }
        }
        // Incomplete scans never tell core that unread or over-limit children disappeared.
        val complete = pending.isEmpty() && skipped.isEmpty() && !truncated
        return JSONObject()
            .put("origin", JSONObject().put("ref", originRef).put("label", rootName))
            .put("records", records)
            .put("complete", complete)
    }

    fun contacts(context: Context): String = contacts(context) { uri, projection, selection, args, sort ->
        context.contentResolver.query(uri, projection, selection, args, sort)
    }

    internal fun contacts(context: Context, query: PhoneStoreQuery): String {
        val contacts = linkedMapOf<Long, JSONObject>()
        val data = linkedMapOf<Long, MutableList<ContactData>>()
        readQuery(query,
            ContactsContract.Contacts.CONTENT_URI,
            arrayOf(
                ContactsContract.Contacts._ID,
                ContactsContract.Contacts.LOOKUP_KEY,
                ContactsContract.Contacts.DISPLAY_NAME,
                ContactsContract.Contacts.DISPLAY_NAME_ALTERNATIVE,
                ContactsContract.Contacts.PHONETIC_NAME,
            ),
            null,
            null,
            null,
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val id = cursor.getLong(0)
                val title = cursor.string(2).orEmpty()
                contacts[id] = JSONObject()
                    .put("external_id", PhoneOrigins.contactId(cursor.string(1), id))
                    .put("fields", JSONObject()
                        .put("title", title.ifBlank { cursor.string(3).orEmpty() })
                        .put("sort_name", cursor.string(3).jsonValue())
                        .put("given", JSONObject.NULL)
                        .put("family", JSONObject.NULL)
                        .put("phonetic", cursor.string(4).jsonValue())
                        .put("nickname", JSONObject.NULL)
                        .put("role", JSONObject.NULL)
                        .put("org", JSONObject.NULL)
                        .put("points", JSONArray())
                        .put("dates", JSONArray()))
                data[id] = mutableListOf()
            }
        }
        if (contacts.isNotEmpty()) {
            readQuery(query,
                ContactsContract.Data.CONTENT_URI,
                arrayOf(
                    ContactsContract.Data.CONTACT_ID,
                    ContactsContract.Data.MIMETYPE,
                    ContactsContract.Data.DATA1,
                    ContactsContract.Data.DATA2,
                    ContactsContract.Data.DATA3,
                    ContactsContract.Data.DATA4,
                    ContactsContract.Data.DATA5,
                    ContactsContract.Data.DATA6,
                    ContactsContract.Data.DATA7,
                    ContactsContract.Data.DATA8,
                    ContactsContract.Data.DATA9,
                ),
                "${ContactsContract.Data.MIMETYPE} IN (?, ?, ?, ?, ?, ?, ?)",
                arrayOf(
                    ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE,
                    ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE,
                    ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE,
                    ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE,
                    ContactsContract.CommonDataKinds.StructuredPostal.CONTENT_ITEM_TYPE,
                    ContactsContract.CommonDataKinds.Website.CONTENT_ITEM_TYPE,
                    ContactsContract.CommonDataKinds.Event.CONTENT_ITEM_TYPE,
                ),
                null,
            ).use { cursor ->
                while (cursor.moveToNext()) {
                    val id = cursor.getLong(0)
                    data[id]?.add(
                        ContactData(
                            mime = cursor.string(1).orEmpty(),
                            one = cursor.string(2),
                            two = cursor.string(3),
                            three = cursor.string(4),
                            four = cursor.string(5),
                            five = cursor.string(6),
                            six = cursor.string(7),
                            seven = cursor.string(8),
                            eight = cursor.string(9),
                            nine = cursor.string(10),
                        ),
                    )
                }
            }
        }
        for ((id, fields) in contacts) {
            val values = fields.getJSONObject("fields")
            val points = values.getJSONArray("points")
            val dates = values.getJSONArray("dates")
            for (row in data[id].orEmpty()) {
                when (row.mime) {
                    ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE -> {
                        values.put("given", row.two.jsonValue())
                        values.put("family", row.three.jsonValue())
                        values.put("phonetic", listOfNotNull(row.seven, row.eight, row.nine).joinToString(" ").jsonValue())
                    }
                    ContactsContract.CommonDataKinds.Nickname.CONTENT_ITEM_TYPE -> values.put("nickname", row.one.jsonValue())
                    ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE -> {
                        values.put("org", row.one.jsonValue())
                        values.put("role", row.four.jsonValue())
                    }
                    ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE -> points.put(
                        point("phone", row.one, phoneLabel(context, row.two, row.three)),
                    )
                    ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE -> points.put(
                        point("email", row.one, emailLabel(context, row.two, row.three)),
                    )
                    ContactsContract.CommonDataKinds.StructuredPostal.CONTENT_ITEM_TYPE -> points.put(
                        point("address", row.one, postalLabel(context, row.two, row.three)),
                    )
                    ContactsContract.CommonDataKinds.Website.CONTENT_ITEM_TYPE -> points.put(point("link", row.one, null))
                    ContactsContract.CommonDataKinds.Event.CONTENT_ITEM_TYPE -> {
                        val kind = when (row.two?.toIntOrNull()) {
                            ContactsContract.CommonDataKinds.Event.TYPE_BIRTHDAY -> "birthday"
                            ContactsContract.CommonDataKinds.Event.TYPE_ANNIVERSARY -> "anniversary"
                            else -> null
                        }
                        if (kind != null && row.one != null) {
                            dates.put(JSONObject().put("kind", kind).put("date", row.one).put("label", ""))
                        }
                    }
                }
            }
            fun nonblank(name: String): String? {
                val value = values.opt(name) ?: return null
                if (value == JSONObject.NULL) return null
                return value.toString().takeIf(String::isNotBlank)
            }
            val given = nonblank("given")
            val family = nonblank("family")
            val organization = nonblank("org")
            val organizationForm = given == null && family == null && organization != null
            values.put("form", if (organizationForm) "org" else "person")
            if (values.optString("title").isBlank()) {
                val name = listOfNotNull(given, family).joinToString(" ")
                values.put("title", name.ifBlank { organization.orEmpty() })
            }
            check(values.optString("title").isNotBlank()) { "a Contacts record has no usable name" }
        }
        val records = JSONArray().also { out -> contacts.values.forEach(out::put) }
        return JSONObject()
            .put("origin", JSONObject().put("ref", "android:contacts").put("label", "Contacts"))
            .put("records", records)
            .put("complete", true)
            .toString()
    }

    fun calendar(context: Context, read: ShellStoreRead, zone: ZoneId): String = calendar(context, read, zone) { uri, projection, selection, args, sort ->
        context.contentResolver.query(uri, projection, selection, args, sort)
    }

    internal fun calendar(context: Context, read: ShellStoreRead, zone: ZoneId, query: PhoneStoreQuery): String {
        val today = LocalDate.now(zone)
        val sinceDay = today.minusDays(read.days_back.toLong())
        val throughDay = today.plusDays(read.days_on.toLong())
        val start = sinceDay.atStartOfDay(zone).toInstant().toEpochMilli()
        val end = throughDay.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
        val since = sinceDay.atStartOfDay().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        val snapshots = JSONArray()
        readQuery(query,
            CalendarContract.Calendars.CONTENT_URI,
            arrayOf(
                CalendarContract.Calendars._ID,
                CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
                CalendarContract.Calendars.ACCOUNT_TYPE,
                CalendarContract.Calendars.ACCOUNT_NAME,
            ),
            null,
            null,
            null,
        ).use { calendars ->
            while (calendars.moveToNext()) {
                val calendarId = calendars.getLong(0)
                val label = calendars.string(1).orEmpty()
                val accountType = calendars.string(2)
                val accountName = calendars.string(3)
                val originRef = "calendar:" + PhoneOrigins.calendarKey(accountType, accountName, null, calendarId)
                val records = JSONArray()
                val recurring = "${CalendarContract.Events.RRULE} IS NOT NULL"
                val window = "${CalendarContract.Events.DTSTART} >= ? AND ${CalendarContract.Events.DTSTART} < ?"
                val selection = "${CalendarContract.Events.CALENDAR_ID} = ? AND (${window} OR $recurring) AND ${CalendarContract.Events.DELETED} = 0"
                val args = arrayOf(calendarId.toString(), start.toString(), end.toString())
                readQuery(query,
                    CalendarContract.Events.CONTENT_URI,
                    arrayOf(
                        CalendarContract.Events._ID,
                        CalendarContract.Events.TITLE,
                        CalendarContract.Events.DTSTART,
                        CalendarContract.Events.DTEND,
                        CalendarContract.Events.EVENT_TIMEZONE,
                        CalendarContract.Events.ALL_DAY,
                        CalendarContract.Events.DESCRIPTION,
                        CalendarContract.Events.EVENT_LOCATION,
                        CalendarContract.Events.RRULE,
                        CalendarContract.Events.AVAILABILITY,
                        CalendarContract.Events.UID_2445,
                    ),
                    selection,
                    args,
                    null,
                ).use { events ->
                    while (events.moveToNext()) {
                        val eventId = events.getLong(0)
                        val eventTitle = events.string(1).orEmpty()
                        val startsMs = events.getLong(2)
                        val endsMs = events.getLong(3)
                        val eventZone = events.string(4)
                        val allDay = events.getInt(5) != 0
                        val startText = eventTime(startsMs, eventZone, allDay, zone)
                        val endText = eventTime(endsMs, eventZone, allDay, zone)
                        val fields = JSONObject()
                            .put("title", eventTitle)
                            .put("starts", startText)
                            .put("ends", endText)
                            .put("timing", if (allDay) "all-day" else if (eventZone.isNullOrBlank()) "floating" else "zoned")
                            .put("zone", eventZone.jsonValue())
                            .put("rule", events.string(8).jsonValue())
                            .put("description", events.string(6).jsonValue())
                            .put("location", events.string(7).jsonValue())
                            .put("busy", if (events.getInt(9) == CalendarContract.Events.AVAILABILITY_FREE) 0 else 1)
                        val uid = events.string(10)
                        records.put(JSONObject()
                            .put("external_id", PhoneOrigins.eventId(uid, eventId))
                            .put("fields", fields))
                    }
                }
                val snapshot = JSONObject()
                    .put("origin", JSONObject().put("ref", originRef).put("label", label))
                    .put("records", records)
                    .put("complete", false)
                    .put("since", since)
                snapshots.put(snapshot)
            }
        }
        return JSONObject().put("snapshots", snapshots).toString()
    }

    private fun eventTime(milliseconds: Long, timeZone: String?, allDay: Boolean, fallback: ZoneId): String {
        val zone = if (allDay) ZoneId.of("UTC") else runCatching { ZoneId.of(timeZone) }.getOrDefault(fallback)
        val instant = Instant.ofEpochMilli(milliseconds)
        return if (allDay) {
            instant.atZone(zone).toLocalDate().toString()
        } else {
            instant.atZone(zone).toLocalDateTime().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME)
        }
    }

    private data class ContactData(
        val mime: String,
        val one: String?,
        val two: String?,
        val three: String?,
        val four: String?,
        val five: String?,
        val six: String?,
        val seven: String?,
        val eight: String?,
        val nine: String?,
    )

    private fun Cursor.string(column: Int): String? = if (isNull(column)) null else getString(column)

    private fun query(
        context: Context,
        uri: android.net.Uri,
        projection: Array<String>,
        selection: String?,
        selectionArgs: Array<String>?,
        sortOrder: String?,
    ): Cursor = context.contentResolver.query(uri, projection, selection, selectionArgs, sortOrder)
        .requireStoreRead()

    private fun readQuery(
        query: PhoneStoreQuery,
        uri: android.net.Uri,
        projection: Array<String>,
        selection: String?,
        selectionArgs: Array<String>?,
        sortOrder: String?,
    ): Cursor = query(uri, projection, selection, selectionArgs, sortOrder).requireStoreRead()

    private fun String?.jsonValue(): Any = this?.takeIf(String::isNotBlank) ?: JSONObject.NULL

    private fun point(kind: String, value: String?, label: String?) = JSONObject()
        .put("kind", kind)
        .put("value", value.orEmpty())
        .put("label", label.orEmpty())

    private fun phoneLabel(context: Context, type: String?, custom: String?): String = type?.toIntOrNull()?.let {
        ContactsContract.CommonDataKinds.Phone.getTypeLabel(context.resources, it, custom).toString()
    }.orEmpty()

    private fun emailLabel(context: Context, type: String?, custom: String?): String = type?.toIntOrNull()?.let {
        ContactsContract.CommonDataKinds.Email.getTypeLabel(context.resources, it, custom).toString()
    }.orEmpty()

    private fun postalLabel(context: Context, type: String?, custom: String?): String = type?.toIntOrNull()?.let {
        ContactsContract.CommonDataKinds.StructuredPostal.getTypeLabel(context.resources, it, custom).toString()
    }.orEmpty()

    private const val MAX_FOLLOW_FILES = 5_000
    private const val MAX_FOLLOW_TREE_ENTRIES = 10_000
}

internal object FollowFolderGrants {
    private fun key(ref: String) = "grant.$ref"
    private const val URI_OWNERS_FILE = "grant.android.uri-owners.v1"
    private val ownershipLock = Mutex()

    private fun ownershipIndex(context: Context) = UriGrantOwnershipIndex(File(context.filesDir, URI_OWNERS_FILE))

    suspend fun create(context: Context, core: CentraidCore, uri: Uri): String? {
        val ref = "folder-${java.util.UUID.randomUUID()}"
        return ownershipLock.withLock {
            val uriKey = uri.toString()
            val index = ownershipIndex(context)
            val existing = index.load()
            val owners = index.addOwner(existing, uriKey, ref)
            try {
                index.save(owners)
            } catch (_: Exception) {
                if (existing[uriKey].isNullOrEmpty()) {
                    runCatching { context.contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                }
                return@withLock null
            }

            val result = core.call(Envelope(request = Request(device = DeviceRequest(put = DevicePut(key = key(ref), value_ = uri.toString())))))
            val stored = result is dev.centraid.core.CoreOutcome.Answered && result.value.response?.device?.found == true
            if (!stored) {
                val rollback = index.withoutOwner(owners, uriKey, ref)
                val rolledBack = runCatching { index.save(rollback.owners) }.isSuccess
                if (rolledBack && rollback.revokeUri) {
                    runCatching { context.contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                }
                return@withLock null
            }
            ref
        }
    }

    suspend fun resolve(core: CentraidCore, ref: String): Uri? {
        if (!ref.startsWith("folder-") || ref.contains('/')) return null
        val result = core.call(Envelope(request = Request(device = DeviceRequest(get_ = DeviceGet(key(ref))))))
        val device = (result as? dev.centraid.core.CoreOutcome.Answered)?.value?.response?.device ?: return null
        if (!device.found || device.value_.isBlank()) return null
        return runCatching { Uri.parse(device.value_) }.getOrNull()
    }

    suspend fun release(context: Context, core: CentraidCore, ref: String): Boolean {
        if (!ref.startsWith("folder-") || ref.contains('/')) return false
        return ownershipLock.withLock {
            val index = ownershipIndex(context)
            val owners = index.load()
            val ownedUri = owners.entries.firstOrNull { ref in it.value }?.key
            val uri = resolve(core, ref) ?: ownedUri?.let(Uri::parse)
            if (uri == null) return@withLock true // A completed release can safely be replayed.

            val deleted = core.call(Envelope(request = Request(device = DeviceRequest(delete = DeviceDelete(key(ref))))))
            if (deleted !is dev.centraid.core.CoreOutcome.Answered) return@withLock false

            val uriKey = uri.toString()
            val released = index.withoutOwner(owners, uriKey, ref)
            if (ownedUri != null && runCatching { index.save(released.owners) }.isFailure) return@withLock false
            if (!released.revokeUri) return@withLock true
            try {
                context.contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                true
            } catch (_: Exception) {
                false
            }
        }
    }

}

/** App-wide bookkeeping only; folder traversal still uses the current vault's refs from the core. */
internal class UriGrantOwnershipIndex(private val file: File) {
    fun load(): Map<String, Set<String>> {
        if (!file.exists()) return emptyMap()
        val root = JSONObject(file.readText(Charsets.UTF_8))
        require(root.optInt("version", -1) == 1) { "unsupported folder grant index version" }
        val encoded = root.optJSONObject("owners") ?: throw IllegalStateException("invalid folder grant index")
        return buildMap {
            val keys = encoded.keys()
            while (keys.hasNext()) {
                val uri = keys.next()
                val refs = encoded.optJSONArray(uri) ?: throw IllegalStateException("invalid folder grant owners")
                put(uri, buildSet { for (index in 0 until refs.length()) add(refs.getString(index)) })
            }
        }
    }

    fun addOwner(owners: Map<String, Set<String>>, uri: String, ref: String): Map<String, Set<String>> =
        owners + (uri to (owners[uri].orEmpty() + ref))

    fun withoutOwner(owners: Map<String, Set<String>>, uri: String, ref: String): FolderGrantRelease {
        val remaining = owners[uri].orEmpty() - ref
        val updated = if (remaining.isEmpty()) owners - uri else owners + (uri to remaining)
        return FolderGrantRelease(updated, revokeUri = remaining.isEmpty())
    }

    fun save(owners: Map<String, Set<String>>) {
        val directory = file.parentFile ?: throw IllegalStateException("folder grant index has no parent")
        if (!directory.exists() && !directory.mkdirs()) throw IllegalStateException("cannot create folder grant index directory")
        val encoded = JSONObject().put("version", 1).put("owners", JSONObject().apply {
            owners.toSortedMap().forEach { (uri, refs) ->
                put(uri, JSONArray().also { values -> refs.sorted().forEach(values::put) })
            }
        }).toString().toByteArray(Charsets.UTF_8)
        val temporary = File(directory, "${file.name}.tmp")
        try {
            FileOutputStream(temporary).use { stream ->
                stream.write(encoded)
                stream.fd.sync()
            }
            if (!temporary.renameTo(file)) throw IllegalStateException("cannot publish folder grant index")
        } finally {
            temporary.delete()
        }
    }
}

internal data class FolderGrantRelease(val owners: Map<String, Set<String>>, val revokeUri: Boolean)


internal typealias PhoneStoreQuery = (
    android.net.Uri,
    Array<String>,
    String?,
    Array<String>?,
    String?,
) -> Cursor?

internal fun <T : Any> T?.requireStoreRead(): T =
    this ?: throw IllegalStateException("phone store query failed")
