import SwiftUI

/// `people.editor` — a person's profile, or a new person's, as an `EditorRoom`
/// (#1135; #1015 D3): autosave, close = done, band hidden.
///
/// There is no Save. Each field's typed text lives here (seeded once, like the
/// Notes editor's) and is handed to Rust as its edit event; Rust's autosave
/// writes after its debounce, and leaving is the flush (`Left`, which Rust sends
/// when the page pops). The cadence is a choice Rust lights; it is its own write,
/// on the tap, and a refusal is the state's `status`.
struct PeopleEditorView: View {
    let state: Centraid_Core_V1_PeopleEditorState
    let send: (Centraid_Core_V1_PeopleEditorEvent) -> Void
    let onClose: () -> Void

    @State private var name = ""
    @State private var role = ""
    @State private var nickname = ""
    @State private var met = ""
    @State private var seeded = false

    @Environment(\.colorScheme) private var scheme

    private var content: ScreenContent<Centraid_Core_V1_PeopleProfileDraft> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        case let .draft(draft)?: return .data(draft)
        case .gone?, nil: return .loading(true)
        }
    }

    var body: some View {
        let chrome = state.chrome
        EditorRoom(
            title: chrome.title,
            status: state.autosave.legacy,
            closeLabel: chrome.closeLabel,
            onClose: onClose,
            onDeparted: {}
        ) {
            EmptyView()
        } content: {
            if case let .gone(gone)? = state.content {
                EmptyStateView(gone.legacy)
            } else {
                ReadStateView(
                    content: content,
                    skeleton: { RowSkeleton(rows: 4, meta: false, label: chrome.loading) },
                    onRetry: { send(PeopleEvents.editor { $0.refreshed = .init() }) }
                ) { draft in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            EditableFieldRow(key: chrome.nameField, text: $name, identifier: "people-editor-name") { typed in
                                guard typed != draft.displayName else { return }
                                send(PeopleEvents.editor { $0.name = .with { $0.text = typed } })
                            }
                            EditableFieldRow(
                                key: chrome.roleField,
                                text: $role,
                                placeholder: chrome.rolePlaceholder,
                                identifier: "people-editor-role"
                            ) { typed in
                                guard typed != draft.role else { return }
                                send(PeopleEvents.editor { $0.role = .with { $0.text = typed } })
                            }
                            EditableFieldRow(key: chrome.nicknameField, text: $nickname, identifier: "people-editor-nickname") { typed in
                                guard typed != draft.nickname else { return }
                                send(PeopleEvents.editor { $0.nickname = .with { $0.text = typed } })
                            }
                            EditableFieldRow(key: chrome.metField, text: $met, identifier: "people-editor-met") { typed in
                                guard typed != draft.met else { return }
                                send(PeopleEvents.editor { $0.met = .with { $0.text = typed } })
                            }
                            cadences(chrome)
                        }
                    }
                    .onAppear {
                        // ONCE — re-seeding would overwrite typing with the
                        // state Rust still holds.
                        if !seeded {
                            name = draft.displayName
                            role = draft.role
                            nickname = draft.nickname
                            met = draft.met
                            seeded = true
                        }
                    }
                }
            }
        }
    }

    private func cadences(_ chrome: Centraid_Core_V1_PeopleEditorChrome) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(chrome.cadenceField)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(state.cadences, id: \.days) { cadence in
                        KitChip(
                            label: cadence.label,
                            selected: cadence.selected,
                            identifier: "people-editor-cadence-\(cadence.days)"
                        ) {
                            send(PeopleEvents.editor { $0.cadence = .with { $0.days = cadence.days } })
                        }
                    }
                }
            }
            if state.hasStatus, !state.status.sentence.isEmpty {
                Text(state.status.sentence)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color(state.status.refused ? "net" : "textFaint", scheme))
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
    }
}
