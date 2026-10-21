package dev.centraid.shared.apps.agenda

import centraid.screen.v1.AgendaEditorState
import dev.centraid.shared.platform.SecureStore

/**
 * WHAT THE ADD SHEET OPENS ON: the kind the member last ADDED on this device
 * (#1128, R-1128-9) — an event until a task has been added, a task until an
 * event is.
 *
 * ## One per DEVICE, not per vault
 *
 * A habit of this phone, not a fact of the vault: it lives in [SecureStore]
 * for the reason [dev.centraid.shared.shell.Appearance] does (the shell's only
 * durable key-value), written by the editor's bridge when an add COMMITS —
 * a sheet left unsaved, or a write the core refused, changes nothing — and read
 * by the same bridge when a create opens. The machine reads and writes neither;
 * it is handed the kind in `Opened`.
 *
 * An EVENT IS STORED AS ABSENCE, so the store holds a key only while a task
 * was the last thing added; an unknown word opens on an event.
 */
public object AgendaAddKind {
    /** The [SecureStore] key, under that store's own `centraid.v1.` prefix. */
    public const val KEY: String = "agenda_add_kind"

    private const val TASK: String = "task"

    public fun of(stored: String?): AgendaEditorState.Kind =
        if (stored == TASK) AgendaEditorState.Kind.KIND_TASK else AgendaEditorState.Kind.KIND_EVENT

    public suspend fun read(store: SecureStore): AgendaEditorState.Kind = of(store.read(KEY))

    public suspend fun write(store: SecureStore, kind: AgendaEditorState.Kind) {
        store.write(KEY, if (kind == AgendaEditorState.Kind.KIND_TASK) TASK else "")
    }
}
