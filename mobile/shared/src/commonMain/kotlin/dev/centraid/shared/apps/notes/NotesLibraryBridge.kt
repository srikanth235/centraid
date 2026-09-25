package dev.centraid.shared.apps.notes

import centraid.screen.v1.NotesLibraryEvent
import centraid.screen.v1.NotesLibraryState
import dev.centraid.shared.kit.ScreenBridge

/**
 * What both shells hold for the Notes library. A shell pushes
 * `Destination.NotesLibrary` and forwards `NotesLibraryEvent.Opened` with the
 * notebook (or none); intents (`NewNoteRequested`, `NotePicked`,
 * `TrashOpened`, a `BandPicked` for another place) are the shell's to route.
 */
public class NotesLibraryBridge : ScreenBridge<NotesLibraryState, NotesLibraryEvent>(
    machine = NotesLibraryMachine,
    events = NotesLibraryEvent.ADAPTER,
    wire = { w -> w.session.attachQueries(w.host, NotesLibraryReads, NotesLibraryReads, left = w.left) },
)
