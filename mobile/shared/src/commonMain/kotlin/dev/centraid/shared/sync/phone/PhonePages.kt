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
