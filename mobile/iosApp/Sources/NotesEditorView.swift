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
            case let .draft(draft):
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
                }
                TextField("Title", text: .constant(draft.title))
                    .onSubmit { shell.send(screen: "notes.editor", event: state.titleEvent) }
                TextEditor(text: .constant(draft.body))
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
