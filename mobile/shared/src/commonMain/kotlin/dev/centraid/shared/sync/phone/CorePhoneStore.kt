package dev.centraid.shared.sync.phone

import centraid.core.v1.Envelope
import centraid.core.v1.PageCursor
import centraid.core.v1.PageOrder
import centraid.core.v1.PageQuery
import centraid.core.v1.PageRequest
import centraid.core.v1.Request
import centraid.core.v1.Value
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.shared.kit.PhoneImport

/**
 * THE LINK AND ORIGIN HALF OF A [PhoneStore], OVER THE CORE: `phone.*` commands to write,
 * `phone_link` and `phone_origin` through the page door to read. A source extends it with its own
 * rows and its own add, update and trash. [device] is this install's [PhoneDevice]: a `local:` link
 * is written under it and a portable one under none, and every origin this pass registers is
 * stamped with it.
 */
public abstract class CorePhoneStore(
    protected val core: CentraidCore,
    final override val source: PhoneSource,
    final override val device: String,
) : PhoneStore {
    override suspend fun links(): List<StoredLink>? = pageAll(
        name = "phone.links",
        select = listOf("link_id", "phone_id", "origin_id", "entity_id", "fingerprint", "detached_at", "last_seen_at", "device_id"),
        from = "phone_link",
        where = "source = ?",
        bind = listOf(Value(text = source.wire)),
        key = "link_id",
    )?.map { row ->
        StoredLink(
            linkId = row.text(0),
            phoneId = row.text(1),
            originId = row.text(2),
            entityId = row.text(3).ifEmpty { null },
            fingerprint = row.text(4),
            detached = row.text(5).isNotEmpty(),
            lastSeenAt = row.text(6),
            deviceId = row.text(7).ifEmpty { null },
        )
    }

    override suspend fun origins(): List<StoredOrigin>? = pageAll(
        name = "phone.origins",
        select = listOf("origin_id", "phone_origin", "label", "device_id"),
        from = "phone_origin",
        where = "source = ?",
        bind = listOf(Value(text = source.wire)),
        key = "origin_id",
    )?.map { row ->
        StoredOrigin(originId = row.text(0), phoneOrigin = row.text(1), label = row.text(2), deviceId = row.text(3).ifEmpty { null })
    }

    override suspend fun origin(phoneOrigin: String, label: String): String? =
        command(
            "phone.origin",
            "{\"source\":${q(source.wire)},\"phone_origin\":${q(phoneOrigin)},\"label\":${q(label)},\"device_id\":${q(device)}}",
        )?.let { field(it, "origin_id") }

    override suspend fun link(phoneId: String, originId: String, entityId: String, fingerprint: String): String? =
        command(
            "phone.link",
            "{\"source\":${q(source.wire)},\"phone_id\":${q(phoneId)},\"device_id\":${deviceOf(phoneId)}," +
                "\"origin_id\":${q(originId)},\"entity_id\":${q(entityId)},\"fingerprint\":${q(fingerprint)}}",
        )?.let { field(it, "link_id") }

    override suspend fun relink(linkId: String, phoneId: String, originId: String): Boolean =
        command(
            "phone.relink",
            "{\"link_id\":${q(linkId)},\"phone_id\":${q(phoneId)},\"device_id\":${deviceOf(phoneId)}," +
                "\"origin_id\":${q(originId)}}",
        ) != null

    /** The `device_id` a link for [phoneId] is written under, as JSON: none for an id every device shares. */
    private fun deviceOf(phoneId: String): String = if (PhoneIds.isPortable(phoneId)) "null" else q(device)

    override suspend fun touch(phoneIds: List<String>): Boolean {
        // The command's own ceiling is TOUCH_IDS_MAX; a bigger book is touched in slices.
        for (slice in phoneIds.chunked(TOUCH_SLICE)) {
            val ids = slice.joinToString(",") { q(it) }
            val input = "{\"source\":${q(source.wire)},\"device_id\":${q(device)},\"phone_ids\":[$ids]}"
            if (command("phone.touch", input) == null) return false
        }
        return true
    }

    override suspend fun detach(linkId: String): Boolean = command("phone.detach", "{\"link_id\":${q(linkId)}}") != null

    override suspend fun forget(linkId: String): Boolean = command("phone.forget", "{\"link_id\":${q(linkId)}}") != null

    override suspend fun retireOrigin(originId: String): Boolean =
        command("phone.retire_origin", "{\"origin_id\":${q(originId)}}") != null

    /** One command through the command plane: its output JSON, or null when it was refused. */
    protected suspend fun command(name: String, input: String): String? = PhoneImport.executed(core, name, input)

    /**
     * EVERY ROW OF A PAGE QUERY, a page at a time by its keyset cursor; null when any page failed,
     * because a half-read table planned against would trash what it did not see.
     */
    protected suspend fun pageAll(
        name: String,
        select: List<String>,
        from: String,
        key: String,
        where: String? = null,
        bind: List<Value> = emptyList(),
    ): List<List<Value>>? = PhonePages.all(core, name, select, from, key, where, bind)

    protected fun List<Value>.text(index: Int): String = getOrNull(index)?.text.orEmpty()

    protected fun q(value: String): String = PhoneImport.quote(value)

    /** A string field of a command's JSON output. */
    protected fun field(output: String, name: String): String? =
        Regex("\"$name\"\\s*:\\s*\"([^\"]+)\"").find(output)?.groupValues?.getOrNull(1)

    private companion object {
        const val TOUCH_SLICE: Int = 5_000
    }
}

/** EVERY ROW OF A PAGE QUERY, for a follower that plans against what the vault holds. */
public object PhonePages {
    /**
     * Every row of the query, a page at a time by its keyset cursor; null when any page failed,
     * because a half-read table planned against would trash what it did not see.
     */
    public suspend fun all(
        core: CentraidCore,
        name: String,
        select: List<String>,
        from: String,
        key: String,
        where: String? = null,
        bind: List<Value> = emptyList(),
    ): List<List<Value>>? {
        val query = PageQuery(
            name = name,
            select = select,
            from = from,
            where_ = where,
            bind = bind,
            order = PageOrder(sort_column = key, pk_column = key),
        )
        val rows = mutableListOf<List<Value>>()
        var after: PageCursor? = null
        repeat(MAX_PAGES) {
            val answer = core.call(
                Envelope(request_id = 0, request = Request(page = PageRequest(query = query, limit = PAGE_LIMIT, after = after))),
            )
            val page = (answer as? CoreOutcome.Answered)?.value?.response?.page ?: return null
            page.rows.forEach { rows += it.values }
            after = page.next ?: return rows
        }
        return null
    }

    private const val PAGE_LIMIT: Int = 500
    private const val MAX_PAGES: Int = 10_000
}
