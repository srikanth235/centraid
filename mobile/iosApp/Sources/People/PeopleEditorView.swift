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
    @Environment(\.appAccent) private var accent

    var body: some View {
        let chrome = state.chrome
        EditorRoom(
            title: chrome.title,
            status: state.autosave,
            closeLabel: chrome.closeLabel,
            onClose: onClose,
            onDeparted: {}
        ) {
            EmptyView()
        } content: {
            PageReadStateView(
                page: state.page,
                onRetry: { send(PeopleEvents.editor { $0.refreshed = .init() }) },
                skeleton: { RowSkeleton(rows: 4, meta: false, label: chrome.loading) }
            ) {
                let draft = state.draft
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        // THE FOUR FIELDS ARE ONE WHITE CARD on the page (#1173).
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
                        }
                        .background(
                            Surface.card,
                            in: RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous)
                        )
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                        .padding(.top, 8)
                        cadences(chrome)
                    }
                }
                .background(Surface.page.ignoresSafeArea())
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

    private func cadences(_ chrome: Centraid_Core_V1_PeopleEditorChrome) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(chrome.cadenceField.uppercased())
                .kitType(.group)
                .foregroundStyle(Surface.meta)
                .accessibilityAddTraits(.isHeader)
            // THE FIVE CHOICES WRAP: none is pushed off the edge to be found by scrolling.
            KitFlow(spacing: 8) {
                    ForEach(state.cadences, id: \.days) { cadence in
                        // THE CHOSEN CADENCE IS FILLED in the app's colour under a white label; the
                        // others are white pills with a hairline.
                        Button {
                            send(PeopleEvents.editor { $0.cadence = .with { $0.days = cadence.days } })
                        } label: {
                            Text(cadence.label)
                                .kitType(.row)
                                .fontWeight(cadence.selected ? .semibold : .regular)
                                .foregroundStyle(cadence.selected ? Color.white : Surface.ink)
                                .padding(.horizontal, 16)
                                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                                .background(cadence.selected ? accent.fill : Surface.card, in: Capsule())
                                .overlay(Capsule().strokeBorder(Surface.border, lineWidth: cadence.selected ? 0 : CentraidGeometry.hairline))
                                .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(cadence.selected ? .isSelected : [])
                        .accessibilityIdentifier("people-editor-cadence-\(cadence.days)")
                    }
            }
            if state.hasStatus, !state.status.sentence.isEmpty {
                Text(state.status.sentence)
                    .kitType(.meta)
                    .foregroundStyle(state.status.refused ? StateColor.red.text : Surface.meta)
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin + 4)
        .padding(.top, 22)
        .padding(.bottom, 8)
    }
}
