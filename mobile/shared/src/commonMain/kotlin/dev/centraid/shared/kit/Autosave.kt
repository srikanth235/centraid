package dev.centraid.shared.kit

import centraid.screen.v1.Autosave
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.WriteSettled
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.Step

/**
 * One autosaving editor's parts, as [AutosaveLaw] needs them. [D] is the
 * draft; the content lens's data arm holds it.
 *
 * [baseline] is the draft as the vault last had it — what "only the changed
 * fields" is measured against — and [sending] is the draft the save in flight
 * carries, which becomes the baseline when it commits. Both live in the
 * screen's own state message, because the kit's [Autosave] message cannot
 * hold a typed draft.
 */
public interface AutosaveLens<S, D> : ContentLens<S, D> {
    public val screenId: String

    /** The command a save submits. */
    public val command: String

    public fun subjectId(state: S): String

    public fun autosave(state: S): Autosave

    public fun withAutosave(state: S, autosave: Autosave): S

    public fun baseline(state: S): D?

    public fun withBaseline(state: S, baseline: D?): S

    public fun sending(state: S): D?

    public fun withSending(state: S, sending: D?): S

    /**
     * The command's input for [draft] against [baseline], naming ONLY the
     * fields that changed — or null when none did. App-owned: every command
     * schema is `additionalProperties: false`, so only the app knows its keys.
     */
    public fun input(state: S, draft: D, baseline: D?): String?

    /** Why [draft] cannot be saved as it stands, or null. */
    public fun refusal(state: S, draft: D, baseline: D?): ReadFailure?
}

/**
 * AUTOSAVE (#1015 D3: autosave everywhere; close = done).
 *
 * - An edit never writes at once: it schedules a save [DEBOUNCE_MS] later, and
 *   a later edit makes the earlier tick stale (its token names an `edit_seq`
 *   the editor has moved past). A reducer has no clock, so the debounce is a
 *   [ScreenEffect.Schedule] the runtime serves.
 * - [flush] saves NOW: on leave (close = done), and for a choice such as a pin,
 *   which is a decision and not typing.
 * - Each save is ONE command under ONE key per `edit_seq`
 *   ([InvokeKeys.of]`(command, subject, "seq=N")`): a replay of the same save
 *   dedups, and the next edit is a new command rather than a replay of the
 *   last.
 * - Only changed fields are sent, measured against the baseline.
 * - **A change from the vault never overwrites words being typed.** While
 *   there are unsaved words or a save in flight, `rows_changed` and a read's
 *   answer set `remote_changed` and replace nothing; the editor re-reads once
 *   its words are saved. There is no vault-side revision check: the last save
 *   on this phone wins. `PHASE_CONFLICT` is kept for the compare a later slice
 *   adds.
 * - A refused save keeps the words on screen with the sentence over them.
 */
public object AutosaveLaw {
    public const val DEBOUNCE_MS: Long = 900

    /** The tick token for [editSeq]. */
    public fun tokenOf(editSeq: Long): String = "save:$editSeq"

    /** The screen opened on a new subject: loading, seqs kept monotonic. */
    public fun <S, D> opened(l: AutosaveLens<S, D>, s: S): Step<S> {
        val a = l.autosave(s)
        val cleared = l.withSending(l.withBaseline(l.with(s, ReadContent.Loading(firstLoad = true)), null), null)
        return Step(
            l.withAutosave(
                cleared,
                Autosave(phase = Autosave.Phase.PHASE_CLEAN, edit_seq = a.edit_seq, saved_seq = a.edit_seq),
            ),
            listOf(ScreenEffect.ReadPage(l.screenId, afterCursor = null)),
        )
    }

    /**
     * The subject's row arrived. Over unsaved words it replaces NOTHING and
     * notes that the vault moved; otherwise it is the draft and the baseline.
     */
    public fun <S, D> loaded(l: AutosaveLens<S, D>, s: S, draft: D, revision: String): Step<S> {
        val a = l.autosave(s)
        if (unsaved(a) && l.dataOf(s) != null) {
            return Step(l.withAutosave(s, a.copy(remote_changed = true)))
        }
        val next = l.withSending(l.withBaseline(l.with(s, ReadContent.Data(draft)), draft), null)
        return Step(
            l.withAutosave(
                next,
                Autosave(
                    phase = Autosave.Phase.PHASE_CLEAN,
                    edit_seq = a.edit_seq,
                    saved_seq = a.edit_seq,
                    base_revision_id = revision,
                ),
            ),
        )
    }

    /** An edit: DIRTY (or still SAVING), a new seq, and a debounce. */
    public fun <S, D> edited(l: AutosaveLens<S, D>, s: S, change: (D) -> D): Step<S> {
        val draft = l.dataOf(s) ?: return Step(s)
        val changed = change(draft)
        if (changed == draft) return Step(s)
        val a = l.autosave(s)
        val seq = a.edit_seq + 1
        return Step(
            l.withAutosave(
                l.with(s, ReadContent.Data(changed)),
                a.copy(
                    phase = if (a.phase == Autosave.Phase.PHASE_SAVING) a.phase else Autosave.Phase.PHASE_DIRTY,
                    edit_seq = seq,
                    failure = null,
                ),
            ),
            listOf(ScreenEffect.Schedule(l.screenId, tokenOf(seq), DEBOUNCE_MS)),
        )
    }

    /** The debounce came due. A token for an edit since overtaken is nothing. */
    public fun <S, D> tick(l: AutosaveLens<S, D>, s: S, token: String): Step<S> {
        val a = l.autosave(s)
        if (token != tokenOf(a.edit_seq) || a.phase != Autosave.Phase.PHASE_DIRTY) return Step(s)
        return save(l, s)
    }

    /**
     * SAVE NOW, if there is anything to save: leaving (close = done), a pin, a
     * member-sent save. A refused save is tried once more — the member closing
     * over it is asking for it to be kept.
     */
    public fun <S, D> flush(l: AutosaveLens<S, D>, s: S): Step<S> {
        val a = l.autosave(s)
        return when (a.phase) {
            Autosave.Phase.PHASE_DIRTY, Autosave.Phase.PHASE_REFUSED ->
                if (unsaved(a)) save(l, s) else Step(s)
            else -> Step(s)
        }
    }

    /** A save's answer. One under another key is not this save's, and ignored. */
    public fun <S, D> settled(l: AutosaveLens<S, D>, s: S, settled: WriteSettled): Step<S> {
        val a = l.autosave(s)
        if (a.phase != Autosave.Phase.PHASE_SAVING || settled.invoke_key != a.invoke_key) return Step(s)
        if (!settled.committed) {
            // THE WORDS STAY. The sentence goes over them, never instead.
            return Step(
                l.withAutosave(
                    l.withSending(s, null),
                    a.copy(phase = Autosave.Phase.PHASE_REFUSED, failure = settled.failure, invoke_key = ""),
                ),
            )
        }
        val committed = l.withBaseline(s, l.sending(s))
        val after = a.copy(saved_seq = a.saving_seq, invoke_key = "", failure = null)
        val cleared = l.withSending(committed, null)
        // Words typed while this save was in flight: save them now, their tick
        // has already come and gone against a SAVING editor.
        if (after.edit_seq > after.saved_seq) {
            return save(l, l.withAutosave(cleared, after.copy(phase = Autosave.Phase.PHASE_DIRTY)))
        }
        // Everything is saved. If the vault moved meanwhile, read it now.
        return if (after.remote_changed) {
            Step(
                l.withAutosave(cleared, after.copy(phase = Autosave.Phase.PHASE_SAVED, remote_changed = false)),
                listOf(ScreenEffect.ReadPage(l.screenId, afterCursor = null)),
            )
        } else {
            Step(l.withAutosave(cleared, after.copy(phase = Autosave.Phase.PHASE_SAVED)))
        }
    }

    /**
     * Rows moved. Not this subject: nothing. Unsaved words or a save in
     * flight: `remote_changed`, and no read. Otherwise re-read.
     *
     * An EMPTY key list is "re-read the table" (`ChangeFeed::tables_changed`
     * emits one for every local commit), so it is this subject too.
     */
    public fun <S, D> rowsChanged(l: AutosaveLens<S, D>, s: S, keys: List<String>): Step<S> {
        if (keys.isNotEmpty() && l.subjectId(s) !in keys) return Step(s)
        val a = l.autosave(s)
        if (unsaved(a) || a.phase == Autosave.Phase.PHASE_SAVING) {
            return Step(l.withAutosave(s, a.copy(remote_changed = true)))
        }
        return Step(s, listOf(ScreenEffect.ReadPage(l.screenId, afterCursor = null)))
    }

    /** Are there words the vault does not have? */
    public fun unsaved(a: Autosave): Boolean = a.edit_seq > a.saved_seq

    private fun <S, D> save(l: AutosaveLens<S, D>, s: S): Step<S> {
        val draft = l.dataOf(s) ?: return Step(s)
        val a = l.autosave(s)
        val baseline = l.baseline(s)
        l.refusal(s, draft, baseline)?.let { failure ->
            return Step(l.withAutosave(s, a.copy(phase = Autosave.Phase.PHASE_REFUSED, failure = failure)))
        }
        val input = l.input(s, draft, baseline)
            // NOTHING CHANGED against the baseline (an edit typed and undone):
            // saved, with no command.
            ?: return Step(
                l.withAutosave(s, a.copy(phase = Autosave.Phase.PHASE_SAVED, saved_seq = a.edit_seq, failure = null)),
            )
        val key = InvokeKeys.of(l.command, l.subjectId(s), "seq=${a.edit_seq}")
        return Step(
            l.withAutosave(
                l.withSending(s, draft),
                a.copy(
                    phase = Autosave.Phase.PHASE_SAVING,
                    saving_seq = a.edit_seq,
                    invoke_key = key,
                    failure = null,
                ),
            ),
            listOf(ScreenEffect.SubmitWrite(command = l.command, inputJson = input, invokeKey = key)),
        )
    }
}
