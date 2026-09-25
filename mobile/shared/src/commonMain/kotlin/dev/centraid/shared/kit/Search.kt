package dev.centraid.shared.kit

import centraid.screen.v1.SearchField
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.Step

/** Where a screen keeps its [SearchField]. */
public interface SearchLens<S> {
    public val screenId: String

    public fun field(state: S): SearchField

    public fun with(state: S, field: SearchField): S
}

/**
 * SEARCH OPENS A FIELD ON THE CURRENT SURFACE; it is never a destination (the
 * Agenda ruling). The results are the screen's own; this owns the field.
 */
public object SearchLaw {
    public fun <S> opened(l: SearchLens<S>, s: S): Step<S> =
        Step(l.with(s, l.field(s).copy(open_ = true)))

    /** A new term. A blank one reads nothing: there is nothing to answer. */
    public fun <S> term(l: SearchLens<S>, s: S, term: String): Step<S> {
        val next = l.with(s, l.field(s).copy(open_ = true, term = term))
        return if (term.isBlank()) {
            Step(next)
        } else {
            Step(next, listOf(ScreenEffect.ReadPage(l.screenId, afterCursor = null)))
        }
    }

    /**
     * Close CLEARS the term and the term answered (a v0 defect: the old term
     * came back the next time the field opened, over results for it).
     */
    public fun <S> closed(l: SearchLens<S>, s: S): Step<S> = Step(l.with(s, SearchField()))

    /**
     * Is an answer for [answeredTerm] still the one to draw? Answers land out
     * of order; one for a term the member has since changed or cleared is
     * dropped rather than drawn over the field.
     */
    public fun <S> answerIsCurrent(l: SearchLens<S>, s: S, answeredTerm: String): Boolean {
        val field = l.field(s)
        return field.open_ && field.term == answeredTerm
    }

    /** Record that the rows on screen answer [answeredTerm]. */
    public fun <S> answered(l: SearchLens<S>, s: S, answeredTerm: String): S =
        l.with(s, l.field(s).copy(answered_term = answeredTerm))
}
