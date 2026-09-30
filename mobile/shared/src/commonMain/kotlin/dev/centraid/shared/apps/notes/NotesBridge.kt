package dev.centraid.shared.apps.notes

import centraid.screen.v1.NotesEditorEvent
import centraid.screen.v1.NotesEditorState
import dev.centraid.shared.kit.ScreenBridge

/**
 * What SwiftUI holds instead of the Notes editor's `StateFlow` (#1025 S5).
 *
 * The kit's [ScreenBridge], named so the Swift symbol stays `NotesBridge`.
 * Closing the editor is `leave()`, not `close()`: close = done (#1015 D3), so
 * unsaved words are saved on the way out, on the session's scope.
 */
public class NotesBridge : ScreenBridge<NotesEditorState, NotesEditorEvent>(
    machine = NotesEditorMachine,
    events = NotesEditorEvent.ADAPTER,
    wire = { w -> w.session.attachScreen(w.host, NotesReads, NotesReads, left = w.left) },
)
