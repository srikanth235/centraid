import SwiftUI

/// The Notes editor, in SwiftUI, on the kit (#1020, D-1020-E3; K5; #1029 port).
///
/// **AN EDITOR ROOM: AUTOSAVE, CLOSE = DONE (#1015 D3).** There is no Save
/// button and no save event from here: every edit is handed to the machine,
/// whose `AutosaveLaw` writes after its debounce, and `AutosaveStatus` — hosted
/// by `EditorRoom` — is the one line that says whether the words are safe.
/// Done pops the route; the room going off screen by ANY route calls
/// `onDeparted`, which the registry forwards to `NotesBridge.departed()`: the
/// machine's `Left`, which flushes unsaved words and leaves the bridge alive.
///
/// **EVERY WORD IS THE MACHINE'S** — the close verb, the placeholders, the
/// pin/link/history/send-to-Tasks labels and the status (`NotesEditorChrome`).
/// A body the phone does not hold is read-only (`body_editable`) with the
/// machine's `body_notice` over it. The powerbox (the link picker) is a sheet
/// the machine opens (`link_sheet_open`, also on a typed `[[`); a pick is the
/// editor's `LinkPicked`, and the spliced body is re-seeded when it closes.
struct NotesEditorView: View {
    let data: Data
    let picker: Data
    let opened: Data
    let send: (Data) -> Void
    let sendPicker: (Data) -> Void
    let onClose: () -> Void
    let onDeparted: () -> Void

    /// THE ONLY PLACE A KEYSTROKE EXISTS BEFORE THE MACHINE HEARS IT (#1025 S5).
    ///
    /// Filled from the draft ONCE, when the draft first arrives — and again
    /// only when the powerbox closes, because a pick changed the body under
    /// the field.
    @State private var typedTitle = ""
    @State private var typedBody = ""
    @State private var seeded = false

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_NotesEditorState {
        (try? Centraid_Screen_V1_NotesEditorState(serializedBytes: data)) ?? .init()
    }

    /// ONE BRIDGE SERVES EVERY NOTE: until the state is about the note this
    /// route opened, the last note's draft is still held — seeding from it
    /// would put one note's words in another's fields, and the first
    /// keystroke would write them there. Until then the room draws loading.
    private var mine: Bool {
        guard let route = (try? Centraid_Screen_V1_NotesEditorEvent(serializedBytes: opened))?.opened,
              !route.noteID.isEmpty else { return true }
        return state.noteID == route.noteID
    }

    private var draft: Centraid_Screen_V1_NoteDraft? {
        if mine, case let .draft(draft) = state.content { return draft }
        return nil
    }

    var body: some View {
        let state = state
        let chrome = state.chrome
        EditorRoom(
            title: chrome.title,
            status: state.autosave,
            closeLabel: chrome.close,
            onClose: onClose,
            onDeparted: onDeparted
        ) {
            if let draft {
                Menu {
                    Button(chrome.pinLabel) { send(NotesEditorEvents.make { $0.pin = .init() }) }
                    if state.bodyEditable {
                        Button(chrome.linkLabel) {
                            send(NotesEditorEvents.make {
                                $0.linkRequested = .with { $0.caret = UInt32(typedBody.utf16.count) }
                            })
                        }
                    }
                    if chrome.historyEnabled {
                        Button(chrome.historyLabel) { send(NotesEditorEvents.make { $0.history = .init() }) }
                    }
                    if !chrome.sendToTasksLabel.isEmpty {
                        Button(chrome.sendToTasksLabel) {
                            let text = typedTitle.isEmpty ? typedBody : typedTitle
                            send(NotesEditorEvents.make { $0.sendToTasks = .with { $0.text = text } })
                        }
                    }
                } label: {
                    CentraidIconView(
                        iconKey: "MoreHoriz",
                        tint: Theme.color(draft.pinned ? "text" : "textSoft", scheme),
                        size: 18
                    )
                    .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
                }
                .accessibilityLabel(chrome.menuLabel)
                .accessibilityIdentifier("note-editor-menu")
            }
        } content: {
            ReadStateView(
                content: mine ? content(state) : .loading(true),
                skeleton: { RowSkeleton(rows: 4, meta: false, label: "") },
                onRetry: { send(opened) }
            ) { draft in
                VStack(alignment: .leading, spacing: 8) {
                    if !chrome.status.isEmpty {
                        Text(chrome.status)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textFaint", scheme))
                    }
                    TextField(chrome.titlePlaceholder, text: $typedTitle)
                        .centraidType("title")
                        .foregroundStyle(Theme.color("text", scheme))
                        .accessibilityIdentifier("note-title-field")
                        // AN EDIT IS A DIFFERENCE FROM THE DRAFT, not an
                        // assignment to the field: seeding writes to it too.
                        .onChange(of: typedTitle) { _, typed in
                            guard typed != draft.title else { return }
                            send(NotesEditorEvents.make { $0.title = .with { $0.title = typed } })
                        }
                    if !state.bodyNotice.isEmpty {
                        Text(state.bodyNotice)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .accessibilityIdentifier("note-body-notice")
                    }
                    ZStack(alignment: .topLeading) {
                        if typedBody.isEmpty, state.bodyEditable {
                            Text(chrome.bodyPlaceholder)
                                .centraidType("reading")
                                .foregroundStyle(Theme.color("textFaint", scheme))
                                .padding(.top, 8)
                                .padding(.leading, 5)
                                .allowsHitTesting(false)
                        }
                        TextEditor(text: $typedBody)
                            .centraidType("reading")
                            .foregroundStyle(Theme.color(state.bodyEditable ? "text" : "textSoft", scheme))
                            .scrollContentBackground(.hidden)
                            .disabled(!state.bodyEditable)
                            .accessibilityIdentifier("note-body-field")
                            .onChange(of: typedBody) { _, typed in
                                guard state.bodyEditable, typed != draft.body else { return }
                                send(NotesEditorEvents.make { $0.body = .with { $0.body = typed } })
                            }
                    }
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .onAppear {
                    // ONCE. See `seeded`.
                    if !seeded {
                        typedTitle = draft.title
                        typedBody = draft.body
                        seeded = true
                    }
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { state.linkSheetOpen },
            set: { open in
                guard !open, state.linkSheetOpen else { return }
                send(NotesEditorEvents.make { $0.linkDismissed = .init() })
            }
        )) {
            NotesLinkPickerView(
                data: picker,
                send: sendPicker,
                onPick: { target in send(NotesEditorEvents.make { $0.linkPicked = .with { $0.target = target } }) },
                onClose: { send(NotesEditorEvents.make { $0.linkDismissed = .init() }) }
            )
        }
        .onChange(of: state.linkSheetOpen) { _, open in
            // THE POWERBOX CLOSED: a pick spliced `[[title]]` into the body
            // the machine holds, so the field takes it.
            if !open, let draft { typedBody = draft.body }
        }
    }

    private func content(_ state: Centraid_Screen_V1_NotesEditorState) -> ScreenContent<Centraid_Screen_V1_NoteDraft> {
        switch state.content {
        case let .loading(loading): return .loading(loading.firstLoad)
        case let .failure(failure): return .failed(failure)
        case let .draft(draft): return .data(draft)
        case .none: return .loading(true)
        }
    }
}

/// Encoded `NotesEditorEvent`s.
enum NotesEditorEvents {
    static func make(_ build: (inout Centraid_Screen_V1_NotesEditorEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_NotesEditorEvent()
        build(&event)
        return event.encoded
    }
}
