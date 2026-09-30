package dev.centraid.shared.kit

import centraid.screen.v1.Denied
import centraid.screen.v1.ReadFailure
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.Step

/**
 * One paged list's parts, as the kit's [PagedList] law needs them.
 *
 * [S] is the screen's state message, [D] its data message, [R] one row.
 * [firstPagePending] is the screen's `first_page_pending`: a first page is in
 * flight OVER rows the screen keeps showing.
 */
public interface PagedListLens<S, D, R> : ContentLens<S, D> {
    public val screenId: String

    public fun rows(data: D): List<R>

    public fun withRows(data: D, rows: List<R>): D

    public fun nextCursor(data: D): String?

    public fun key(row: R): String

    public fun firstPagePending(state: S): Boolean

    public fun withFirstPagePending(state: S, pending: Boolean): S
}

/**
 * A PAGED LIST, ONCE (the five-app kit; generalises the first list, Tally's,
 * and its re-read fix — pinned in `KitLawsSpec`).
 *
 * The laws, each of which a list has got wrong at least once:
 *
 * - **A refresh over rows keeps them drawn** until the answer lands, then the
 *   answer REPLACES them. A spinner painted over last night's rows and a
 *   spinner over an empty frame are different screens.
 * - **A first page replaces; only a later page appends.** Appending a first
 *   page keeps every row the vault no longer holds; replacing a later page
 *   loses the rows above it.
 * - **Which page an answer is, is the cursor it ANSWERED** — echoed by the
 *   runtime from the request (`ScreenReads.arrived(…, answeredCursor)`), empty
 *   or null for a first page. A state flag alone cannot tell: a page two that
 *   lands after a change event has started a re-read would be taken for the
 *   re-read's answer and replace the list with page two. A later page is
 *   appended only while it continues the rows on screen (its cursor is the
 *   data's `next_cursor`); one that does not is a page of a list that has
 *   since been replaced, and is dropped.
 * - **A refusal clears the rows and emits NOTHING.** A failed read is not an
 *   empty list, and a reducer that re-read on its own refusal is the retry
 *   loop `docs/mobile-offline.md:238` parks the feed to stop. Retry is a
 *   member-sent refresh.
 * - **An empty key list on a change means "re-read this table"**
 *   (`ChangeFeed::tables_changed` sends one for every local commit).
 */
public object PagedList {
    /** Open: the first load, with nothing drawn yet. */
    public fun <S, D, R> opened(l: PagedListLens<S, D, R>, s: S): Step<S> = Step(
        l.withFirstPagePending(l.with(s, ReadContent.Loading(firstLoad = true)), false),
        listOf(ScreenEffect.ReadPage(l.screenId, afterCursor = null)),
    )

    /** Refresh: over rows, keep them and re-read the first page; else open. */
    public fun <S, D, R> refreshed(l: PagedListLens<S, D, R>, s: S): Step<S> =
        if (l.dataOf(s) == null) opened(l, s) else reread(l, s)

    /**
     * The next page, when there is one and no first page is in flight: a
     * page walked from a cursor a re-read is about to replace would be a page
     * of a list that is going away.
     */
    public fun <S, D, R> nextPage(l: PagedListLens<S, D, R>, s: S): Step<S> {
        val cursor = l.dataOf(s)?.let(l::nextCursor)
        if (cursor.isNullOrEmpty() || l.firstPagePending(s)) return Step(s)
        return Step(s, listOf(ScreenEffect.ReadPage(l.screenId, afterCursor = cursor)))
    }

    /**
     * An answer. [answeredCursor] null or empty is a FIRST page: it replaces
     * the rows and ends a pending re-read. Otherwise it is a later page: it
     * appends, deduplicated by key, when it continues the rows on screen, and
     * is dropped when it does not.
     */
    public fun <S, D, R> arrived(l: PagedListLens<S, D, R>, s: S, d: D, answeredCursor: String?): Step<S> {
        if (answeredCursor.isNullOrEmpty()) {
            return Step(l.withFirstPagePending(l.with(s, ReadContent.Data(d)), false))
        }
        val existing = l.dataOf(s) ?: return Step(s)
        if (l.nextCursor(existing) != answeredCursor) return Step(s)
        val known = l.rows(existing).map(l::key).toSet()
        val appended = l.rows(d).filterNot { l.key(it) in known }
        // THE ANSWER'S CURSOR, the existing rows first. A pending re-read stays
        // pending: its answer is still coming, and it replaces all of this.
        return Step(l.with(s, ReadContent.Data(l.withRows(d, l.rows(existing) + appended))))
    }

    /**
     * An answer from a sender that does not echo the cursor: a first page when
     * nothing is drawn or a re-read is pending, else a later page. The
     * pre-echo discriminator, kept for the events a test or an old sender
     * builds without `answered_cursor`.
     */
    public fun <S, D, R> arrivedUnechoed(l: PagedListLens<S, D, R>, s: S, d: D): Step<S> {
        val existing = l.dataOf(s)
        if (existing == null || l.firstPagePending(s)) {
            return Step(l.withFirstPagePending(l.with(s, ReadContent.Data(d)), false))
        }
        val known = l.rows(existing).map(l::key).toSet()
        val appended = l.rows(d).filterNot { l.key(it) in known }
        return Step(l.with(s, ReadContent.Data(l.withRows(d, l.rows(existing) + appended))))
    }

    /** A refusal: the failure IS the content, the rows go, and no effect. */
    public fun <S, D, R> refused(l: PagedListLens<S, D, R>, s: S, f: ReadFailure): Step<S> =
        Step(l.withFirstPagePending(l.with(s, ReadContent.Failed(f)), false))

    /** A denial: a state, drawn as the ask, and no effect. */
    public fun <S, D, R> denied(l: PagedListLens<S, D, R>, s: S, d: Denied): Step<S> =
        Step(l.withFirstPagePending(l.with(s, ReadContent.Denied(d)), false))

    /**
     * Rows moved in the vault. Empty [keys] re-reads; otherwise re-read only
     * when a shown row is named. Re-read rather than patch: the ORDER may have
     * changed, and a patched row in the wrong place disagrees with its sort.
     */
    public fun <S, D, R> rowsChanged(l: PagedListLens<S, D, R>, s: S, keys: List<String>): Step<S> {
        val shown = l.dataOf(s)?.let { data -> l.rows(data).map(l::key).toSet() } ?: emptySet()
        if (keys.isNotEmpty() && keys.none { it in shown }) return Step(s)
        return if (l.dataOf(s) == null) opened(l, s) else reread(l, s)
    }

    private fun <S, D, R> reread(l: PagedListLens<S, D, R>, s: S): Step<S> = Step(
        l.withFirstPagePending(s, true),
        listOf(ScreenEffect.ReadPage(l.screenId, afterCursor = null)),
    )
}
