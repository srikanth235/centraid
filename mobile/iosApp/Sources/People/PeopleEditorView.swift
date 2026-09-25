import SwiftUI

/// A person's profile editor — or a new person's — as an `EditorRoom` (#1029
/// app port; #1015 D3): autosave, close = done, band hidden.
///
/// There is no Save. Each field's typed text lives here (seeded once, like the
/// Notes editor's) and is handed to the machine as its edit event; the
/// machine's `AutosaveLaw` writes after its debounce, and leaving is the flush
/// (`onDeparted` → the bridge's `departed()` → `Left`). The hue and the
/// cadence are choices the machine lights; the cadence is its own write, whose
/// word is `save_label`.
struct PeopleEditorView: View {
    let data: Data
    let opened: Data
    let send: (Data) -> Void
    let onClose: () -> Void
    let onDeparted: () -> Void

    @State private var name = ""
    @State private var role = ""
    @State private var nickname = ""
    @State private var met = ""
    @State private var seeded = false

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_PeopleEditorState {
        (try? Centraid_Screen_V1_PeopleEditorState(serializedBytes: data)) ?? .init()
    }

    /// ONE BRIDGE SERVES EVERY PERSON: until the state is about the person
    /// this route opened, the last one's draft is still held, and seeding from
    /// it would put one person's words in another's fields.
    private var mine: Bool {
        guard let route = (try? Centraid_Screen_V1_PeopleEditorEvent(serializedBytes: opened))?.opened else { return true }
        let id = route.partyID.isEmpty ? route.mintedPartyID : route.partyID
        return id.isEmpty || state.partyID == id
    }

    private var content: ScreenContent<Centraid_Screen_V1_PeopleProfileDraft> {
        guard mine else { return .loading(true) }
        switch state.content {
        case let .loading(loading): return .loading(loading.firstLoad)
        case let .failure(failure): return .failed(failure)
        case let .denied(denied): return .denied(denied)
        case let .draft(draft): return .data(draft)
        case .gone, .none: return .loading(true)
        }
    }

    var body: some View {
        let state = state
        let chrome = state.chrome
        EditorRoom(
            title: chrome.title,
            status: state.autosave,
            closeLabel: chrome.closeLabel,
            onClose: onClose,
            onDeparted: onDeparted
        ) {
            EmptyView()
        } content: {
            if mine, case let .gone(gone) = state.content {
                EmptyStateView(gone)
            } else {
                ReadStateView(
                    content: content,
                    skeleton: { RowSkeleton(rows: 4, meta: false, label: chrome.loading) },
                    onRetry: { send(opened) }
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
                            hues(chrome)
                            cadences(chrome)
                        }
                    }
                    .onAppear {
                        // ONCE — re-seeding would overwrite typing with the
                        // state the machine still holds.
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

    private func hues(_ chrome: Centraid_Screen_V1_PeopleEditorChrome) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(chrome.colourField)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(state.hues, id: \.hueKey) { hue in
                        Button {
                            send(PeopleEvents.editor { $0.hue = .with { $0.hueKey = hue.hueKey } })
                        } label: {
                            Circle()
                                .fill(Theme.color(peopleHue(hue.hueKey, else: "bgSunken"), scheme))
                                .frame(width: 28, height: 28)
                                .overlay(
                                    Circle()
                                        .strokeBorder(Theme.color("text", scheme), lineWidth: hue.selected ? 2 : 0)
                                        .padding(-4)
                                )
                                .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(hue.accessibilityLabel)
                        .accessibilityAddTraits(hue.selected ? .isSelected : [])
                        .accessibilityIdentifier("people-editor-hue-\(hue.hueKey)")
                    }
                }
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
    }

    private func cadences(_ chrome: Centraid_Screen_V1_PeopleEditorChrome) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(chrome.cadenceField)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(state.cadences, id: \.days) { cadence in
                        Button {
                            send(PeopleEvents.editor { $0.cadence = .with { $0.days = cadence.days } })
                        } label: {
                            Text(cadence.label)
                                .centraidType(cadence.selected ? "smallStrong" : "small")
                                .foregroundStyle(Theme.color(cadence.selected ? "text" : "textSoft", scheme))
                                .padding(.horizontal, 12)
                                .frame(minHeight: 32)
                                .background(Capsule().fill(Theme.color(cadence.selected ? "bgSunken" : "bg", scheme)))
                                .overlay(
                                    Capsule().strokeBorder(
                                        Theme.color(cadence.selected ? "lineStrong" : "line", scheme),
                                        lineWidth: CentraidGeometry.hairline
                                    )
                                )
                                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(cadence.selected ? .isSelected : [])
                        .accessibilityIdentifier("people-editor-cadence-\(cadence.days)")
                    }
                }
            }
            if !state.saveLabel.isEmpty {
                Text(state.saveLabel)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color(state.write.phase == .refused ? "net" : "textFaint", scheme))
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
    }
}
