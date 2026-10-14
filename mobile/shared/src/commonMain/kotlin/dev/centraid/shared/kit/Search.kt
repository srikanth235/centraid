package dev.centraid.shared.kit

import centraid.screen.v1.EmptyState
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
     * DOES THIS SEARCH OFFER ASK (#1097, R-1097-28)? Every searching app does
     * except Locker (R-1097-29), which never reaches the law. A lens states it
     * and has no default, so a new search cannot offer Ask by forgetting to say.
     * Home answers `false`: it keeps its own `ask_question` on its data.
     */
    public val asks: Boolean
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
            l.field(s).copy(open_ = true, term = term, corrected = "", containers = emptyList(), ask = ""),
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
     * ASK (#1097, R-1097-28): [rows] is how many result rows the answer holds;
     * `null` says the caller has no answer to speak of. The question to send
     * ("Find <term>") is set when the answer is the current one, the lens
     * [SearchLens.asks], and it is WHOLLY EMPTY: no rows and no containers. A
     * stale answer, an answer with anything in it and a lens that does not ask
     * clear it. The EMPTY state it belongs to takes its action from [asking].
     */
    public fun <S> answered(
        l: SearchLens<S>,
        s: S,
        answeredTerm: String,
        corrected: String = "",
        containers: List<SearchContainer> = emptyList(),
        rows: Int? = null,
    ): S {
        val current = answeredTerm.isNotBlank() && answerIsCurrent(l, s, answeredTerm)
        val asks = current && l.asks && rows == 0 && containers.isEmpty()
        return l.with(
            s,
            l.field(s).copy(
                answered_term = answeredTerm,
                corrected = if (current) corrected else "",
                containers = if (current) containers else emptyList(),
                ask = if (asks) question(answeredTerm) else "",
            ),
        )
    }

    /**
     * The answer was REFUSED or DENIED: nothing it found is on screen, so no
     * Ask is offered over it (#1097, R-1097-28). The gate or the failure is the
     * screen's own state.
     */
    public fun <S> unasked(l: SearchLens<S>, s: S): S =
        if (l.field(s).ask.isEmpty()) s else l.with(s, l.field(s).copy(ask = ""))

    /** The question Ask sends for [term]: the words are copy, the term is trimmed. */
    public fun question(term: String): String = SharedCopy.SEARCH_ASK_QUESTION.replace("{term}", term.trim())

    /** The no-match action's label for [term] (`SEARCH_ASK_ABOUT`). */
    public fun askLabel(term: String): String = SharedCopy.SEARCH_ASK_ABOUT.replace("{term}", term.trim())

    /**
     * A NO-MATCH EMPTY STATE WITH ITS ONE ACTION (#1097, R-1097-30): [empty]
     * as is when the field offers no Ask, else with the action label the shell
     * draws where it has a Chat tab. The tap goes to the shell with
     * [SearchField.ask]; no machine event answers it.
     */
    public fun asking(empty: EmptyState, field: SearchField): EmptyState =
        if (field.ask.isEmpty()) empty else empty.copy(action_label = askLabel(field.answered_term))
}
