package dev.centraid.shared.apps.docs

import centraid.screen.v1.Autosave
import centraid.screen.v1.DocsRename
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.WriteSettled
import dev.centraid.design.copy.DocsCopy
import dev.centraid.shared.kit.AutosaveLaw
import dev.centraid.shared.kit.AutosaveLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.Step

/**
 * ONE READ IN FLIGHT, for a screen whose reads are app queries.
 *
 * `ScreenQueryRuntime` serves every `ReadPage` it sees, and an answer does not
 * say which request it answers — so a shelf changed while its last read is out
 * would draw the old shelf's rows under the new one's head when the older
 * answer lands last. A read asked while another is out is QUEUED; the answer to
 * the older one is dropped and the queued read goes out instead
 * (`AgendaHome.reading`'s rule, and `PhotosGridState.reading`'s before it).
 */
internal interface ReadGateLens<S> {
    val screenId: String

    fun reading(state: S): Boolean

    fun queued(state: S): Boolean

    fun with(state: S, reading: Boolean, queued: Boolean): S
}

internal object ReadGate {
    /** Ask for a read: now, or after the one in flight. */
    fun <S> read(l: ReadGateLens<S>, s: S): Step<S> =
        if (l.reading(s)) {
            Step(l.with(s, reading = true, queued = true))
        } else {
            Step(l.with(s, reading = true, queued = false), listOf(ScreenEffect.ReadPage(l.screenId, afterCursor = null)))
        }

    /** Every [Step]'s `ReadPage` for this screen, through the gate. */
    fun <S> gated(l: ReadGateLens<S>, step: Step<S>): Step<S> {
        val (reads, others) = step.effects.partition { it is ScreenEffect.ReadPage && it.screenId == l.screenId }
        if (reads.isEmpty()) return step
        val asked = read(l, step.state)
        return Step(asked.state, others + asked.effects)
    }

    /**
     * An answer (or a refusal) landed. Null: it answers a read since
     * superseded — drop it, and the queued read is the step. Otherwise the
     * state with no read in flight, to fold the answer into.
     */
    fun <S> landed(l: ReadGateLens<S>, s: S): Pair<S, Step<S>?> =
        if (l.queued(s)) {
            s to Step(l.with(s, reading = true, queued = false), listOf(ScreenEffect.ReadPage(l.screenId, afterCursor = null)))
        } else {
            l.with(s, reading = false, queued = false) to null
        }
}

/** Where a screen keeps its inline rename. */
internal interface RenameSlot<S> {
    val screenId: String

    fun rename(state: S): DocsRename?

    fun with(state: S, rename: DocsRename?): S
}

/**
 * AN INLINE RENAME THAT SAVES AS THE MEMBER TYPES (#1015 D3: autosave
 * everywhere, close = done) — the kit's [AutosaveLaw] over one title.
 *
 * The draft is the title; the baseline is the title the vault last had. A
 * blank title is refused with a sentence and keeps the words (the command
 * needs one). Closing the field saves what is unsaved; the rename leaves the
 * state once its last save commits, so the row draws the member's title, not
 * the old one, until the vault's answer replaces it.
 */
internal object DocsRenameLaw {
    /** Open on [documentId]. Not while another rename still has words to save. */
    fun <S> opened(slot: RenameSlot<S>, s: S, documentId: String, title: String): Step<S> {
        val open = slot.rename(s)
        if (open != null && busy(open)) return Step(s)
        return Step(
            slot.with(
                s,
                DocsRename(
                    document_id = documentId,
                    title = title,
                    autosave = Autosave(phase = Autosave.Phase.PHASE_CLEAN),
                    baseline = title,
                ),
            ),
        )
    }

    fun <S> edited(slot: RenameSlot<S>, s: S, title: String): Step<S> {
        val open = slot.rename(s) ?: return Step(s)
        val lens = Lens(slot)
        // Typing again reopens a field that was closing over a refusal.
        val reopened = if (open.closed) slot.with(s, open.copy(closed = false)) else s
        return AutosaveLaw.edited(lens, reopened) { title }
    }

    fun <S> tick(slot: RenameSlot<S>, s: S, token: String): Step<S> {
        if (slot.rename(s) == null) return Step(s)
        return AutosaveLaw.tick(Lens(slot), s, token)
    }

    /** Done, or focus left the field: save now, and close once saved. */
    fun <S> closed(slot: RenameSlot<S>, s: S): Step<S> {
        val open = slot.rename(s) ?: return Step(s)
        // A BLANK NAME CANNOT BE SAVED, and closing is the member walking away
        // from it: the vault's title stands and nothing is sent. Not while a
        // save is in flight — its answer is still this rename's.
        if (open.title.isBlank() && open.autosave?.phase != Autosave.Phase.PHASE_SAVING) {
            return Step(slot.with(s, null))
        }
        val flushed = AutosaveLaw.flush(Lens(slot), slot.with(s, open.copy(closed = true)))
        return Step(release(slot, flushed.state), flushed.effects)
    }

    /** A save's answer; not this rename's key is nothing. */
    fun <S> settled(slot: RenameSlot<S>, s: S, settled: WriteSettled): Step<S> {
        val open = slot.rename(s) ?: return Step(s)
        if (open.autosave?.invoke_key != settled.invoke_key) return Step(s)
        val step = AutosaveLaw.settled(Lens(slot), s, settled)
        // A rename re-reads through the drive's own change event, not its own.
        val effects = step.effects.filterNot { it is ScreenEffect.ReadPage }
        val after = slot.rename(step.state)
        // A REFUSED save reopens the field: the sentence is over the words.
        val next = if (after != null && after.autosave?.phase == Autosave.Phase.PHASE_REFUSED) {
            slot.with(step.state, after.copy(closed = false))
        } else {
            release(slot, step.state)
        }
        return Step(next, effects)
    }

    /** Is [key] the key of this rename's save in flight? */
    fun <S> owns(slot: RenameSlot<S>, s: S, key: String): Boolean =
        slot.rename(s)?.autosave?.invoke_key?.let { it.isNotEmpty() && it == key } == true

    /** Its status line: "Saving", "Saved", the refusal's sentence, or empty. */
    fun status(rename: DocsRename): String {
        val a = rename.autosave ?: return ""
        return when (a.phase) {
            Autosave.Phase.PHASE_SAVING -> DocsCopy.SAVING
            Autosave.Phase.PHASE_SAVED -> DocsCopy.SAVED
            Autosave.Phase.PHASE_DIRTY -> DocsCopy.EDITED
            Autosave.Phase.PHASE_REFUSED -> a.failure?.sentence?.ifEmpty { null } ?: DocsCopy.NAME_REQUIRED
            else -> ""
        }
    }

    private fun busy(rename: DocsRename): Boolean {
        val a = rename.autosave ?: return false
        return AutosaveLaw.unsaved(a) || a.phase == Autosave.Phase.PHASE_SAVING
    }

    /** A closed rename with nothing left to save leaves the state. */
    private fun <S> release(slot: RenameSlot<S>, s: S): S {
        val open = slot.rename(s) ?: return s
        return if (open.closed && !busy(open)) slot.with(s, null) else s
    }

    private class Lens<S>(private val slot: RenameSlot<S>) : AutosaveLens<S, String> {
        override val screenId: String = slot.screenId
        override val command: String = DocsWrites.RENAME

        override fun subjectId(state: S): String = slot.rename(state)?.document_id ?: ""

        override fun content(state: S): ReadContent<String> =
            slot.rename(state)?.let { ReadContent.Data(it.title) } ?: ReadContent.Loading(firstLoad = true)

        override fun with(state: S, content: ReadContent<String>): S {
            val open = slot.rename(state) ?: return state
            return if (content is ReadContent.Data) slot.with(state, open.copy(title = content.data)) else state
        }

        override fun autosave(state: S): Autosave = slot.rename(state)?.autosave ?: Autosave()

        override fun withAutosave(state: S, autosave: Autosave): S =
            slot.rename(state)?.let { slot.with(state, it.copy(autosave = autosave)) } ?: state

        override fun baseline(state: S): String? = slot.rename(state)?.baseline

        override fun withBaseline(state: S, baseline: String?): S =
            slot.rename(state)?.let { slot.with(state, it.copy(baseline = baseline)) } ?: state

        override fun sending(state: S): String? = slot.rename(state)?.sending

        override fun withSending(state: S, sending: String?): S =
            slot.rename(state)?.let { slot.with(state, it.copy(sending = sending)) } ?: state

        override fun input(state: S, draft: String, baseline: String?): String? {
            val title = draft.trim()
            if (title == baseline?.trim()) return null
            return DocsWrites.rename(subjectId(state), title)
        }

        override fun refusal(state: S, draft: String, baseline: String?): ReadFailure? =
            if (draft.isBlank()) Reads.refused(DocsCopy.NAME_REQUIRED) else null
    }
}
