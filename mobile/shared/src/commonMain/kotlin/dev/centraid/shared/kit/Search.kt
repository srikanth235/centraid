package dev.centraid.shared.kit

import centraid.screen.v1.SearchAsk
import centraid.screen.v1.SearchContainer
import centraid.screen.v1.SearchField
import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.Step

/** Where a screen keeps its [SearchField]. */
public interface SearchLens<S> {
    public val screenId: String

    public fun field(state: S): SearchField

    public fun with(state: S, field: SearchField): S

    /**
     * THE CHAT SCOPE THIS SEARCH'S ASK OPENS IN (#1135), or `null` when the
     * search offers none. Every searching app offers Ask, scoped to itself, and
     * Home offers it unscoped (""); Locker (R-1097-29) never reaches the law, and
     * the chat drawer's search finds chats, so neither asks. A lens states it and
     * has no default, so a new search cannot offer Ask by forgetting to say.
     */
    public val askScope: String?
}

/**
 * SEARCH OPENS A FIELD ON THE CURRENT SURFACE; it is never a destination (the
 * Agenda ruling). The results are the screen's own; this owns the field.
 */
public object SearchLaw {
    public fun <S> opened(l: SearchLens<S>, s: S): Step<S> =
        Step(l.with(s, l.field(s).copy(open_ = true)))

    /**
     * A new term. A blank one reads nothing: there is nothing to answer. The
     * words the last answer corrected go with it, and so do the containers it
     * found and the Ask it offered: they said what the OLD term searched for.
     */
    public fun <S> term(l: SearchLens<S>, s: S, term: String): Step<S> {
        val next = l.with(
            s,
            l.field(s).copy(open_ = true, term = term, corrected = "", containers = emptyList(), ask_row = null),
        )
        return if (term.isBlank()) {
            Step(next)
        } else {
            Step(next, listOf(ScreenEffect.ReadPage(l.screenId, afterCursor = null)))
        }
    }

    /**
     * Close CLEARS the term, the term answered, the words corrected, the
     * containers found and the Ask offered (a v0 defect: the old term came back the next time the
     * field opened, over results for it).
     */
    public fun <S> closed(l: SearchLens<S>, s: S): Step<S> = Step(l.with(s, SearchField()))

    /**
     * Is an answer for [answeredTerm] still the one to draw? Answers land out
     * of order; one for a term the member has since changed or cleared is
     * dropped rather than drawn over the field. Spaces at the ends are not a
     * different term: the core reads the trimmed one.
     */
    public fun <S> answerIsCurrent(l: SearchLens<S>, s: S, answeredTerm: String): Boolean {
        val field = l.field(s)
        return field.open_ && field.term.trim() == answeredTerm.trim()
    }

    /**
     * Record that the rows on screen answer [answeredTerm], and the words the
     * core searched instead when it [corrected] a typo (EMPTY for an exact
     * answer). The correction is kept only for an answer that is still the
     * current one ([answerIsCurrent]) for a term that is not blank: one for a
     * term since changed or closed says nothing about the field now on screen,
     * and a blank term has nothing to correct.
     *
     * THE CONTAINERS the answer found (#1097) follow the same rule: kept only
     * for a current answer to a term that is not blank, else cleared, so a
     * stale answer never sets them.
     *
     * ASK (#1097, R-1097-28, #1135): the one [SearchAsk] row at the foot of
     * the answer is set when the answer is the current one and the lens has an
     * [SearchLens.askScope], WHETHER OR NOT ANYTHING MATCHED: a member who found
     * rows may still want the assistant. A stale answer and a lens that does not
     * ask clear it.
     */
    public fun <S> answered(
        l: SearchLens<S>,
        s: S,
        answeredTerm: String,
        corrected: String = "",
        containers: List<SearchContainer> = emptyList(),
    ): S {
        val current = answeredTerm.isNotBlank() && answerIsCurrent(l, s, answeredTerm)
        val scope = l.askScope
        return l.with(
            s,
            l.field(s).copy(
                answered_term = answeredTerm,
                corrected = if (current) corrected else "",
                containers = if (current) containers else emptyList(),
                ask_row = if (current && scope != null) offer(answeredTerm, scope) else null,
            ),
        )
    }

    /**
     * The answer was REFUSED or DENIED: nothing it found is on screen, so no
     * Ask is offered over it (#1097, R-1097-28). The gate or the failure is the
     * screen's own state.
     */
    public fun <S> unasked(l: SearchLens<S>, s: S): S =
        if (l.field(s).ask_row == null) s else l.with(s, l.field(s).copy(ask_row = null))

    /** The question Ask sends for [term]: the words are copy, the term is trimmed. */
    public fun question(term: String): String = SharedCopy.SEARCH_ASK_QUESTION.replace("{term}", term.trim())

    /** The Ask row's label for [term] (`SEARCH_ASK_ABOUT`). */
    public fun askLabel(term: String): String = SharedCopy.SEARCH_ASK_ABOUT.replace("{term}", term.trim())

    /**
     * THE ASK ROW FOR [term], opening the chat in [scope] (#1135): the one place
     * its label, its question and its scope are put together, so every app's
     * search reads them the same way and a shell only draws the row and hands it
     * to its router. [scope] is a chat scope (`ChatMachine.SCOPABLE_APPS`) or
     * "" for every app.
     */
    public fun offer(term: String, scope: String): SearchAsk =
        SearchAsk(label = askLabel(term), question = question(term), scope = scope)
}
