import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

/// ADD OR EDIT AN ITEM (#1047, R-1047-L5): AN EXPLICIT SAVE, NOT AUTOSAVE —
/// a secret saved on a pause mid-typing would be a wrong secret. Cancel with
/// changes asks first (the machine's `confirm`); a committed save sets
/// `done`, and the shell closes the editor.
///
/// A secret input is a `SecureField`: never autocorrected, never suggested,
/// and kept out of the keyboard's learning. On edit, a stored secret left
/// empty stays sealed as it was (the machine's note says so).
///
/// **NO "SAVE PASSWORD?" FROM iOS.** AutoFill offers to copy a login into the
/// system's password store when a form's secure field leaves the screen still
/// holding text — a copy of a Locker secret outside the vault, and no content
/// type stops it (`.oneTimeCode` did not). So the moment the member commits
/// (Save, or Discard on the confirm), every secure field is emptied on screen
/// ([concealing]) before the editor can close: the draft is already the
/// machine's, and a field with nothing in it has nothing to offer. A refused
/// save un-conceals and the fields refill from the machine.
struct LockerEditorView: View {
    let data: Data
    let lock: Data
    let send: (Data) -> Void
    let sendLock: (Data) -> Void
    let onClose: () -> Void
    let onDeparted: () -> Void

    @Environment(\.colorScheme) private var scheme
    @State private var concealing = false

    private var state: Centraid_Screen_V1_LockerEditorState {
        (try? Centraid_Screen_V1_LockerEditorState(serializedBytes: data)) ?? .init()
    }

    static func event(_ build: (inout Centraid_Screen_V1_LockerEditorEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_LockerEditorEvent()
        build(&event)
        return event.encoded
    }

    private func content(_ state: Centraid_Screen_V1_LockerEditorState) -> ScreenContent<Centraid_Screen_V1_LockerEditorData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }

    var body: some View {
        let state = state
        let chrome = state.chrome
        LockerCovered(lock: lock, sendLock: sendLock, onBack: onClose) {
            // THE FORM IS SHIELDED FROM CAPTURE while the gate says `secure`.
            LockerShield(lock: lock) {
                ReadStateView(content: content(state), onRetry: nil) { editor in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            if !chrome.lede.isEmpty {
                                LockerNote(text: chrome.lede)
                            }
                            if !editor.types.isEmpty {
                                SectionHeader(title: editor.typesLabel)
                                LockerChoicePills(choices: editor.types, identifier: "locker-editor-type") { key in
                                    send(Self.event { $0.type = .with { $0.key = key } })
                                }
                            }
                            ForEach(editor.inputs, id: \.key) { input in
                                LockerInputRowView(
                                    input: input,
                                    // ONE FIELD PER ITEM AND TYPE: a type switch
                                    // re-seeds the field rather than keeping the
                                    // last type's keystrokes.
                                    identity: "\(state.itemID)-\(input.key)",
                                    concealed: concealing,
                                    onEdit: { value in send(Self.event { $0.typed = .with { $0.key = input.key; $0.value = value } }) },
                                    onGenerate: { send(Self.event { $0.generate = .with { $0.key = input.key } }) }
                                )
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                Text(editor.tagsLabel)
                                    .centraidType("annotLabel")
                                    .foregroundStyle(Theme.color("textSoft", scheme))
                                MachineTextField(placeholder: editor.tagsHint, value: editor.tagsText) { text in
                                    send(Self.event { $0.tags = .with { $0.text = text } })
                                }
                                .centraidType("body")
                                .textInputAutocapitalization(.never)
                                .accessibilityLabel(editor.tagsLabel)
                                .accessibilityIdentifier("locker-editor-tags")
                            }
                            .padding(.horizontal, CentraidGeometry.pageMargin)
                            .padding(.vertical, 8)
                            .overlay(alignment: .bottom) { KitHairline() }
                            if !editor.compromisedLabel.isEmpty {
                                LockerCompromisedRow(
                                    label: editor.compromisedLabel,
                                    on: editor.compromised,
                                    note: editor.compromisedNote
                                ) { on in
                                    send(Self.event { $0.compromised = .with { $0.on = on } })
                                }
                            }
                            LockerNote(text: editor.blocked)
                        }
                        .padding(.bottom, 24)
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                LockerWriteLine(write: state.write)
            }
            .background(Theme.color("bg", scheme).ignoresSafeArea())
            .navigationTitle(chrome.title)
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { send(Self.event { $0.cancel = .init() }) } label: {
                        Text(chrome.cancelLabel)
                            .centraidType("smallStrong")
                            .lineLimit(1)
                            .fixedSize()
                            .foregroundStyle(Theme.color("text", scheme))
                            .padding(.horizontal, 8)
                            .frame(minHeight: CentraidGeometry.targetMinCoarse)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("locker-editor-cancel")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    let canSave = state.data.canSave
                    Button {
                        concealing = true
                        send(Self.event { $0.save = .init() })
                    } label: {
                        Text(chrome.saveLabel)
                            .centraidType("smallStrong")
                            .lineLimit(1)
                            .fixedSize()
                            .foregroundStyle(Theme.color(canSave ? "text" : "textFaint", scheme))
                            .padding(.horizontal, 8)
                            .frame(minHeight: CentraidGeometry.targetMinCoarse)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSave)
                    .accessibilityIdentifier("locker-editor-save")
                }
            }
        }
        .onChange(of: state.done) { _, done in if done { onClose() } }
        // A refused save is still an open form: give the fields back.
        .onChange(of: state.write.phase) { _, phase in if phase == .refused { concealing = false } }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { open in if !open, state.hasConfirm { send(Self.event { $0.dismissed = .init() }) } }
        )) {
            ConfirmSheet(
                state.confirm,
                onConfirm: {
                    concealing = true
                    send(Self.event { $0.confirmed = .init() })
                },
                onDismiss: { send(Self.event { $0.dismissed = .init() }) }
            )
        }
        .onDisappear(perform: onDeparted)
    }
}

/// THE COMPROMISED FLAG (R-1047-F7): a toggle row, its note under it — what
/// the flag does and, over a newly typed password, that saving clears it. The
/// machine decides both; this draws them.
struct LockerCompromisedRow: View {
    let label: String
    let on: Bool
    let note: String
    let onToggle: (Bool) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Toggle(isOn: Binding(get: { on }, set: { value in if value != on { onToggle(value) } })) {
                Text(label)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
            }
            .tint(Theme.color("accent", scheme))
            .frame(minHeight: CentraidGeometry.targetMinCoarse)
            .accessibilityIdentifier("locker-editor-compromised")
            if !note.isEmpty {
                Text(note)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textFaint", scheme))
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .overlay(alignment: .bottom) { KitHairline() }
    }
}

/// A refused write, in the core's words (the kit's `DocsWriteLine` shape).
struct LockerWriteLine: View {
    let write: Centraid_Screen_V1_WriteState

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if write.phase == .refused, write.hasFailure {
            VStack(alignment: .leading, spacing: 2) {
                Text(write.failure.sentence)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("net", scheme))
                if !write.failure.remedy.isEmpty {
                    Text(write.failure.remedy)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 6)
            .background(Theme.color("bg", scheme))
            .accessibilityIdentifier("locker-write-refused")
        }
    }
}

/// ONE INPUT: its label, the field (secure for a secret), the note under it
/// and, on a password, Generate.
struct LockerInputRowView: View {
    let input: Centraid_Screen_V1_LockerInputRow
    let identity: String
    /// The editor is closing: a secure field shows nothing (see the editor's note).
    let concealed: Bool
    let onEdit: (String) -> Void
    let onGenerate: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(input.label)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
            HStack(spacing: 8) {
                field
                    .centraidType(input.secret ? "mono" : "body")
                    .foregroundStyle(Theme.color("text", scheme))
                    .accessibilityLabel(input.label)
                    .accessibilityIdentifier("locker-input-\(input.key)")
                    .id(identity)
                if !input.generateLabel.isEmpty {
                    Button(action: onGenerate) {
                        Text(input.generateLabel)
                            .centraidType("smallStrong")
                            .foregroundStyle(Theme.color("text", scheme))
                            .frame(minHeight: CentraidGeometry.targetMinFine)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("locker-input-\(input.key)-generate")
                }
            }
            if !input.note.isEmpty {
                Text(input.note)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textFaint", scheme))
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .overlay(alignment: .bottom) { KitHairline() }
    }

    @ViewBuilder
    private var field: some View {
        if input.secret {
            LockerSecretField(placeholder: input.placeholder, value: input.value, concealed: concealed, onEdit: onEdit)
        } else {
            MachineTextField(
                placeholder: input.placeholder,
                value: input.value,
                axis: input.kind == .multiline ? .vertical : .horizontal,
                onEdit: onEdit
            )
            .keyboardType(Self.keyboard(input.kind))
            // No autofill pairing either (see `LockerSecretField`).
            .textContentType(nil)
            .textInputAutocapitalization(Self.capitalization(input.kind))
            .autocorrectionDisabled(input.kind != .text && input.kind != .multiline)
        }
    }

    static func keyboard(_ kind: Centraid_Screen_V1_LockerInputRow.Kind) -> UIKeyboardType {
        switch kind {
        case .email: return .emailAddress
        case .url: return .URL
        case .phone: return .phonePad
        case .number: return .numberPad
        default: return .default
        }
    }

    static func capitalization(_ kind: Centraid_Screen_V1_LockerInputRow.Kind) -> TextInputAutocapitalization {
        switch kind {
        case .email, .url, .phone, .number: return .never
        default: return .sentences
        }
    }
}

/// A SECRET'S FIELD: `MachineTextField`'s shape over a `SecureField`, so a
/// keystroke never waits on the machine and a Generate seeds the field.
struct LockerSecretField: View {
    let placeholder: String
    let value: String
    /// Empty the field on screen WITHOUT telling the machine: the draft stays
    /// the machine's, and AutoFill finds nothing to offer to save.
    let concealed: Bool
    let onEdit: (String) -> Void

    @State private var typed = ""
    @FocusState private var focused: Bool

    var body: some View {
        SecureField(placeholder, text: $typed)
            .focused($focused)
            // NOT A LOGIN FORM: without this iOS pairs the field with the
            // username above it and offers to save the secret to the system
            // password manager on leave — a copy of a Locker secret outside
            // the vault. A one-time-code field is never offered for saving.
            .textContentType(.oneTimeCode)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled(true)
            .privacySensitive()
            .onAppear { typed = concealed ? "" : value }
            .onChange(of: typed) { _, text in if !concealed, text != value { onEdit(text) } }
            .onChange(of: value) { _, text in if !concealed, text != typed, text.isEmpty || !focused { typed = text } }
            .onChange(of: concealed) { _, now in
                if now {
                    focused = false
                    typed = ""
                } else {
                    typed = value
                }
            }
    }
}
