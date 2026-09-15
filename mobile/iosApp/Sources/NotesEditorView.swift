import SwiftUI

/// The Notes editor, in SwiftUI (#1020, D-1020-E3).
///
/// The read law and the write law render in different places. `content` decides
/// whether there is an editor at all; `save` decides what the line above it
/// says. **A refused save leaves the member's words exactly where they were** —
/// an editor that replaced them with an error would have thrown away the only
/// copy.
struct NotesEditorView: View {
    @ObservedObject var shell: ShellModel
    let noteIdentifier: String

    /// THE ONLY PLACE A KEYSTROKE EXISTS BEFORE IT IS SAVED (#1025 S5).
    ///
    /// The machine holds the draft it last read or was told about; a character
    /// the member has just typed is in neither until this view hands it over.
    /// Both fields bound to `.constant` before this, so the editor rendered a
    /// note and could not change one — a screen that looks editable and is not.
    ///
    /// `seeded` is what keeps this from fighting the machine: the typed text is
    /// filled from the draft ONCE, when the draft first arrives, and never
    /// again. Re-seeding on every render would overwrite the member's typing
    /// with the state the machine still holds, which is the same defect as
    /// letting a synced row do it — and `NotesEditorMachine` already refuses
    /// that from the other direction.
    @State private var typedTitle = ""
    @State private var typedBody = ""
    @State private var seeded = false

    var state: NotesEditorStateView { NotesEditorStateView(data: shell.notesState) }

    var body: some View {
        VStack(alignment: .leading) {
            switch state.content {
            case .loading:
                ProgressView()
            case let .failure(sentence, remedy):
                VStack(alignment: .leading) {
                    Text(sentence)
                    if !remedy.isEmpty { Text(remedy) }
                }
            // `ScreenContent`'s third case is `.data`, for every screen
            // (#1020, D-1020-E3). `.draft` was a name this view invented
            // and nothing declared — invisible until the first compile.
            case let .data(draft):
                HStack {
                    Text(state.saveLabel)
                    Spacer()
                    Button {
                        shell.send(screen: "notes.editor", event: state.pinEvent)
                    } label: {
                        Image(systemName: draft.pinned ? "star.fill" : "star")
                            .accessibilityLabel(draft.pinned ? "Unpin note" : "Pin note")
                    }
                    Button("Save") {
                        shell.send(screen: "notes.editor", event: state.saveEvent)
                    }
                    .accessibilityIdentifier("note-save-button")
                }
                TextField("Title", text: $typedTitle)
                    .accessibilityIdentifier("note-title-field")
                    // AN EDIT IS A DIFFERENCE FROM THE DRAFT, not an
                    // assignment to the field. Seeding the field below writes
                    // to it, which fires this — so a guard that only checked
                    // "have we seeded yet" still opened every note claiming
                    // UNSAVED CHANGES before the member had touched it, which
                    // the simulator showed on the first run. Comparing against
                    // the draft is exact: typing the original text back is
                    // correctly not an edit either.
                    .onChange(of: typedTitle) { _, typed in
                        guard typed != draft.title else { return }
                        shell.send(
                            screen: "notes.editor",
                            event: NotesEditorStateView.titleEvent(typed)
                        )
                    }
                TextEditor(text: $typedBody)
                    .accessibilityIdentifier("note-body-field")
                    .onChange(of: typedBody) { _, typed in
                        guard typed != draft.body else { return }
                        shell.send(
                            screen: "notes.editor",
                            event: NotesEditorStateView.bodyEvent(typed)
                        )
                    }
                    .onAppear {
                        // ONCE. See `seeded`.
                        if !seeded {
                            typedTitle = draft.title
                            typedBody = draft.body
                            seeded = true
                        }
                    }
                if let failure = draft.saveFailure {
                    // THE SAVE'S OWN SENTENCE, over the words and not instead
                    // of them.
                    Text(failure)
                }
            }
        }
        .padding()
        .navigationTitle("Note")
    }
}
