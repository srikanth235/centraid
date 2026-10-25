import SwiftUI

/// The editor's events, built once.
enum LockerEditorEvents {
    static func make(_ build: (inout Centraid_Core_V1_LockerEditorEvent) -> Void) -> Centraid_Core_V1_LockerEditorEvent {
        var event = Centraid_Core_V1_LockerEditorEvent()
        build(&event)
        return event
    }
}

/// ADD OR EDIT AN ITEM (#1047, R-1047-L5): AN EXPLICIT SAVE, NOT AUTOSAVE — a
/// secret saved on a pause mid-typing would be a wrong secret. Cancel with
/// changes asks first (Rust's `confirm`); a committed save sets `finished`, and
/// the shell closes the editor.
///
/// A secret input is a `SecureField`: never autocorrected, never suggested, and
/// kept out of the keyboard's learning. On edit, a stored secret left empty
/// stays sealed as it was (the row's note says so).
///
/// **NO "SAVE PASSWORD?" FROM iOS.** AutoFill offers to copy a login into the
/// system's password store when a form's secure field leaves the screen still
/// holding text — a copy of a Locker secret outside the vault, and no content
/// type stops it. So the moment the member commits (Save, or Discard on the
/// confirm), every secure field is emptied on screen ([concealing]) before the
/// editor can close: the draft is already Rust's, and a field with nothing in
/// it has nothing to offer. A refused save un-conceals and the fields refill.
struct LockerEditorView: View {
    let state: Centraid_Core_V1_LockerEditorState
    let send: (Centraid_Core_V1_LockerEditorEvent) -> Void
    let sendWall: (Centraid_Core_V1_LockerWallEvent) -> Void
    let onWords: () -> Void
    let onClose: () -> Void

    @Environment(\.colorScheme) private var scheme
    @State private var concealing = false

    private var content: ScreenContent<Centraid_Core_V1_LockerEditorData> {
        switch state.content {
        case .loading?, nil: return .loading(true)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .gated(denied)
        case let .data(data)?: return .data(data)
        }
    }

    private var canSave: Bool {
        if case let .data(data)? = state.content { return data.canSave }
        return false
    }

    var body: some View {
        let chrome = state.chrome
        LockerCovered(wall: state.hasWall ? state.wall : nil, backLabel: chrome.title, send: sendWall, onWords: onWords, onBack: onClose) {
            // THE FORM IS SHIELDED FROM CAPTURE while Rust says `secure`.
            LockerShield(secure: state.secure) {
                ReadStateView(content: content, onRetry: { send(LockerEditorEvents.make { $0.refreshed = .init() }) }) { editor in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            if !chrome.lede.isEmpty {
                                LockerNote(text: chrome.lede)
                            }
                            if !editor.types.isEmpty {
                                SectionHeader(title: editor.typesLabel)
                                LockerChoicePills(choices: editor.types, identifier: "locker-editor-type") { key in
                                    send(LockerEditorEvents.make { $0.type = .with { $0.key = key } })
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
                                    onEdit: { value in send(LockerEditorEvents.make { $0.typed = .with { $0.key = input.key; $0.value = value } }) },
                                    onGenerate: { send(LockerEditorEvents.make { $0.generate = .with { $0.key = input.key } }) }
                                )
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                Text(editor.tagsLabel)
                                    .centraidType("annotLabel")
                                    .foregroundStyle(Theme.color("textSoft", scheme))
                                MachineTextField(placeholder: editor.tagsHint, value: editor.tagsText) { text in
                                    send(LockerEditorEvents.make { $0.tags = .with { $0.text = text } })
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
                                    send(LockerEditorEvents.make { $0.compromised = .with { $0.on = on } })
                                }
                            }
                            LockerNote(text: editor.blocked)
                        }
                        .padding(.bottom, 24)
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if state.hasStatus, state.status.refused {
                    Text(state.status.sentence)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("net", scheme))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                        .padding(.vertical, 6)
                        .background(Theme.color("bg", scheme))
                        .accessibilityIdentifier("locker-write-refused")
                }
            }
            .background(Theme.color("bg", scheme).ignoresSafeArea())
            .navigationTitle(chrome.title)
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ToolbarVerb(label: chrome.cancelLabel, identifier: "locker-editor-cancel") {
                        send(LockerEditorEvents.make { $0.cancel = .init() })
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    ToolbarVerb(label: chrome.saveLabel, identifier: "locker-editor-save") {
                        concealing = true
                        send(LockerEditorEvents.make { $0.save = .init() })
                    }
                    .disabled(!canSave)
                }
            }
        }
        .onChange(of: state.finished) { _, done in if done { onClose() } }
        // A refused save is still an open form: give the fields back.
        .onChange(of: state.hasStatus && state.status.refused) { _, refused in if refused { concealing = false } }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { isOpen in if !isOpen, state.hasConfirm { send(LockerEditorEvents.make { $0.dismissed = .init() }) } }
        )) {
            ConfirmSheet(
                state.confirm,
                onConfirm: {
                    concealing = true
                    send(LockerEditorEvents.make { $0.confirmed = .init() })
                },
                onDismiss: { send(LockerEditorEvents.make { $0.dismissed = .init() }) }
            )
        }
    }
}

/// THE COMPROMISED FLAG (R-1047-F7): a toggle row, its note under it — what the
/// flag does and, over a newly typed password, that saving clears it. Rust
/// decides both; this draws them.
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
            .kitToggle()
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

/// ONE INPUT: its label, the field (secure for a secret), the note under it
/// and, on a password, Generate.
struct LockerInputRowView: View {
    let input: Centraid_Core_V1_LockerInputRow
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
                    KitLink(
                        label: input.generateLabel,
                        dense: true,
                        identifier: "locker-input-\(input.key)-generate",
                        action: onGenerate
                    )
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

    static func keyboard(_ kind: Centraid_Core_V1_LockerInputRow.Kind) -> UIKeyboardType {
        switch kind {
        case .email: return .emailAddress
        case .url: return .URL
        case .phone: return .phonePad
        case .number: return .numberPad
        default: return .default
        }
    }

    static func capitalization(_ kind: Centraid_Core_V1_LockerInputRow.Kind) -> TextInputAutocapitalization {
        switch kind {
        case .email, .url, .phone, .number: return .never
        default: return .sentences
        }
    }
}

/// A SECRET'S FIELD: `MachineTextField`'s shape over a `SecureField`, so a
/// keystroke never waits on Rust and a Generate seeds the field.
struct LockerSecretField: View {
    let placeholder: String
    let value: String
    /// Empty the field on screen WITHOUT telling Rust: the draft stays Rust's,
    /// and AutoFill finds nothing to offer to save.
    let concealed: Bool
    let onEdit: (String) -> Void

    @State private var typed = ""
    @FocusState private var focused: Bool

    var body: some View {
        SecureField(placeholder, text: $typed)
            .focused($focused)
            // NOT A LOGIN FORM: without this iOS pairs the field with the
            // username above it and offers to save the secret to the system
            // password manager on leave. A one-time-code field is never offered
            // for saving.
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
