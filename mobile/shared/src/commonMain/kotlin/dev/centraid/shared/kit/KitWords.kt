package dev.centraid.shared.kit

import centraid.screen.v1.Autosave
import dev.centraid.design.copy.SharedCopy

/**
 * THE KIT'S OWN WORDS, ONCE FOR BOTH SHELLS (#1047).
 *
 * The room and state views need a handful of words no app machine names —
 * the retry verb, the skeleton's spoken label, a pushed page's spoken back,
 * the autosave line. They were spelt twice, in Compose's `KitWords` and in
 * the SwiftUI kit, and had already drifted ("Edited" on one shell, "Saving…"
 * on the other). They live in `copy/shared.json` now, and this is the one
 * place that composes them.
 */
public object KitWords {
    public const val RETRY: String = SharedCopy.KIT_RETRY
    public const val OPENING: String = SharedCopy.KIT_OPENING
    public const val SHOW_MORE: String = SharedCopy.KIT_SHOW_MORE
    public const val LOADING_MORE: String = SharedCopy.KIT_LOADING_MORE
    public const val PENDING: String = SharedCopy.KIT_PENDING
    public const val CANCEL: String = SharedCopy.KIT_CANCEL
    public const val DONE: String = SharedCopy.KIT_DONE
    public const val BACK: String = SharedCopy.BACK
    public const val SEARCH: String = SharedCopy.KIT_SEARCH
    public const val CLOSE_SEARCH: String = SharedCopy.KIT_CLOSE_SEARCH
    public const val REFRESH: String = SharedCopy.KIT_REFRESH

    /** A pushed page's back control, spoken: "Back to People"; "Back" with no parent. */
    public fun backTo(parent: String): String =
        if (parent.isBlank()) SharedCopy.BACK else SharedCopy.BACK_TO.replace("{parent}", parent)

    /**
     * THE AUTOSAVE LINE'S WORDS for [autosave]'s phase — what [AutosaveLaw]
     * writes into `Autosave.label`. A refusal says the core's own sentence
     * when there is one.
     */
    public fun autosave(autosave: Autosave): String = when (autosave.phase) {
        Autosave.Phase.PHASE_CLEAN, Autosave.Phase.PHASE_SAVED -> SharedCopy.AUTOSAVE_SAVED
        Autosave.Phase.PHASE_DIRTY -> SharedCopy.AUTOSAVE_EDITED
        Autosave.Phase.PHASE_SAVING -> SharedCopy.AUTOSAVE_SAVING
        Autosave.Phase.PHASE_REFUSED ->
            autosave.failure?.sentence?.takeIf { it.isNotEmpty() } ?: SharedCopy.AUTOSAVE_NOT_SAVED
        Autosave.Phase.PHASE_CONFLICT -> SharedCopy.AUTOSAVE_CHANGED_ELSEWHERE
        else -> ""
    }
}
