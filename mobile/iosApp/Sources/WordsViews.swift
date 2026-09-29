import LocalAuthentication
import SwiftUI
import UIKit

#if canImport(CentraidShared)
import CentraidShared
#endif

// THE 24 WORDS, DRAWN (#1047 E2). Two screens over the shared machines:
// `words.make` (`VaultWordsBridge`) and `words.enter` (`WordsEntryBridge`).
//
// **THESE VIEWS DECIDE NOTHING.** Every phase, every word a member reads, when
// the primary control opens and what a verdict says arrive in the state;
// the views draw it and forward events. What is theirs is what only a view
// can do — `screen.proto`'s three platform duties for the words:
//
// 1. While `secure` is set the screen is shielded from capture: the content
//    is drawn inside a secure text field's canvas (`CaptureProof`), which iOS
//    leaves out of screenshots and recordings; a cover is drawn while the
//    screen is being captured (`UIScreen.capturedDidChangeNotification`) and
//    whenever the scene is not active, so the app-switcher snapshot iOS keeps
//    holds no word. The root mask (`CentraidApp`) does not reach a sheet —
//    a sheet is its own presentation layer — so this one is the sheet's own.
// 2. A word never reaches the clipboard: a shown word is plain text with
//    selection off and no context menu, and an entry field (`WordField`)
//    offers no edit menu at all — no paste, no copy, no cut, no drag out and
//    no drop in.
// 3. Every entry field turns off autocorrection, capitalisation, spell
//    checking, inline prediction and smart punctuation, takes the ASCII
//    keyboard and carries no `textContentType`, so the words do not land in a
//    keyboard's dictionary or AutoFill.

// MARK: - words.make

/// MAKE A VAULT, AND ITS 24 WORDS (`VaultWordsState`).
struct VaultWordsView: View {
    let data: Data
    let send: (Data) -> Void

    @Environment(\.colorScheme) private var scheme
    @State private var focus: UInt32?

    private var state: Centraid_Screen_V1_VaultWordsState {
        (try? Centraid_Screen_V1_VaultWordsState(serializedBytes: data)) ?? .init()
    }

    var body: some View {
        let state = state
        WordsShield(secure: state.secure) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    WordsHead(title: state.title, lead: state.body)

                    if !state.words.isEmpty {
                        ShownWords(cells: state.words)
                    }
                    if !state.custody.isEmpty {
                        Text(state.custody)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .accessibilityIdentifier("words-custody")
                    }

                    ForEach(state.asks, id: \.position) { ask in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(ask.prompt)
                                .centraidType("annotLabel")
                                .foregroundStyle(Theme.color("textSoft", scheme))
                                .accessibilityHidden(true)
                            WordBox(tone: Self.tone(ask.mark)) {
                                WordField(
                                    value: ask.typed,
                                    position: ask.position,
                                    spoken: ask.prompt,
                                    identifier: "words-ask-\(ask.position)",
                                    focus: $focus,
                                    font: Theme.uiFont("body", scheme),
                                    color: UIColor(Theme.color("text", scheme)),
                                    onEdit: { text in
                                        send(Self.event { $0.typed = .with { $0.position = ask.position; $0.text = text } })
                                    },
                                    onReturn: {
                                        let later = state.asks.map(\.position).filter { $0 > ask.position }
                                        focus = later.first
                                    }
                                )
                            }
                        }
                    }

                    WordsNotice(notice: state.notice)

                    if state.phase == .checking || state.phase == .making {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .accessibilityIdentifier("words-making")
                    }

                    WordsControls(
                        primary: state.primaryLabel,
                        primaryEnabled: state.primaryEnabled,
                        secondary: state.secondaryLabel,
                        prefix: "words-make",
                        onPrimary: { send(Self.event { $0.primary = .init() }) },
                        onSecondary: { send(Self.event { $0.secondary = .init() }) }
                    )

                    if !state.restoreLabel.isEmpty {
                        KitInkButton(label: state.restoreLabel) {
                            send(Self.event { $0.restore = .init() })
                        }
                        .accessibilityIdentifier("words-make-restore")
                    }
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.vertical, 24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.color("bg", scheme).ignoresSafeArea())
            .accessibilityIdentifier("words-make")
        }
        .onAppear { focusFirstAsk(state) }
        .onChange(of: state.phase) { _, _ in focusFirstAsk(self.state) }
    }

    /// CONFIRM opens with the keyboard on the first word asked.
    private func focusFirstAsk(_ state: Centraid_Screen_V1_VaultWordsState) {
        if state.phase == .confirm, focus == nil { focus = state.asks.first?.position }
        if state.phase != .confirm { focus = nil }
    }

    static func tone(_ mark: Centraid_Screen_V1_WordAsk.Mark) -> String {
        switch mark {
        case .right: return "success"
        case .wrong: return "net"
        default: return "lineStrong"
        }
    }

    static func event(_ build: (inout Centraid_Screen_V1_VaultWordsEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_VaultWordsEvent()
        build(&event)
        return event.encoded
    }
}

// MARK: - words.enter

/// TYPE THE 24 WORDS BACK (`WordsEntryState`): a restore onto this phone, or
/// this phone's own vaults given their key again (Locker's wall).
struct WordsEntryView: View {
    let data: Data
    let send: (Data) -> Void

    @Environment(\.colorScheme) private var scheme
    @State private var focus: UInt32?

    private var state: Centraid_Screen_V1_WordsEntryState {
        (try? Centraid_Screen_V1_WordsEntryState(serializedBytes: data)) ?? .init()
    }

    var body: some View {
        let state = state
        let working = state.phase == .working
        WordsShield(secure: state.secure) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    WordsHead(title: state.title, lead: state.body)

                    if !state.cells.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(state.cells, id: \.position) { cell in
                                EntryCell(
                                    cell: cell,
                                    focus: $focus,
                                    onEdit: { text in
                                        send(Self.event { $0.typed = .with { $0.position = cell.position; $0.text = text } })
                                        // A SPACE IS HOW A MEMBER MOVES ON: the
                                        // keyboard goes to the cell after the
                                        // last word typed at once, not after the
                                        // machine's answer, so the next letter
                                        // lands where the member is looking.
                                        if text.contains(where: \.isWhitespace) {
                                            let words = text.split(whereSeparator: \.isWhitespace).count
                                            let next = Int(cell.position) + max(words, 1)
                                            focus = next <= 24 ? UInt32(next) : nil
                                        }
                                    },
                                    onPick: { word in
                                        send(Self.event { $0.picked = .with { $0.position = cell.position; $0.word = word } })
                                        focus = cell.position < 24 ? cell.position + 1 : nil
                                    },
                                    onReturn: {
                                        focus = cell.position < 24 ? cell.position + 1 : nil
                                    }
                                )
                            }
                        }
                        .disabled(working)
                    }

                    if !state.endpointLabel.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(state.endpointLabel)
                                .centraidType("small")
                                .foregroundStyle(Theme.color("textSoft", scheme))
                            MachineTextField(placeholder: "", value: state.endpoint) { text in
                                send(Self.event { $0.endpoint = .with { $0.text = text } })
                            }
                            .keyboardType(.URL)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .centraidType("body")
                            .padding(10)
                            .background(
                                RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                                    .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
                            )
                            .accessibilityLabel(state.endpointLabel)
                            .accessibilityIdentifier("words-endpoint")
                        }
                        .disabled(working)
                    }

                    WordsNotice(notice: state.notice)

                    if !state.progress.isEmpty {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text(state.progress)
                                .centraidType("small")
                                .foregroundStyle(Theme.color("textSoft", scheme))
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("words-progress")
                    }

                    ForEach(Array(state.restored.enumerated()), id: \.offset) { _, line in
                        RestoredLine(line: line)
                    }

                    ForEach(Array(state.stayed.enumerated()), id: \.offset) { at, line in
                        StayedLine(line: line, at: at)
                    }

                    WordsControls(
                        primary: state.primaryLabel,
                        primaryEnabled: state.primaryEnabled,
                        secondary: state.secondaryLabel,
                        prefix: "words-enter",
                        onPrimary: {
                            focus = nil
                            send(Self.event { $0.primary = .init() })
                        },
                        onSecondary: {
                            focus = nil
                            send(Self.event { $0.secondary = .init() })
                        }
                    )
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.vertical, 24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.color("bg", scheme).ignoresSafeArea())
            .accessibilityIdentifier("words-enter")
        }
        .onAppear { if state.phase == .entering, focus == nil { focus = 1 } }
        .onChange(of: state.phase) { _, phase in if phase != .entering { focus = nil } }
    }

    static func event(_ build: (inout Centraid_Screen_V1_WordsEntryEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_WordsEntryEvent()
        build(&event)
        return event.encoded
    }
}

/// One of the 24 cells: its number, the field, and the list words its prefix
/// could be — each a tap that sends `SuggestionPicked`.
private struct EntryCell: View {
    let cell: Centraid_Screen_V1_WordEntry
    let focus: Binding<UInt32?>
    let onEdit: (String) -> Void
    let onPick: (String) -> Void
    let onReturn: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Text("\(cell.position)")
                    .centraidType("mono")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                    .frame(minWidth: 24, alignment: .trailing)
                    .accessibilityHidden(true)
                WordBox(tone: tone) {
                    WordField(
                        value: cell.typed,
                        position: cell.position,
                        spoken: cell.accessibilityLabel,
                        identifier: "words-cell-\(cell.position)",
                        focus: focus,
                        font: Theme.uiFont("body", scheme),
                        color: UIColor(Theme.color("text", scheme)),
                        onEdit: onEdit,
                        onReturn: onReturn
                    )
                }
            }
            if !cell.suggestions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(cell.suggestions, id: \.self) { word in
                            Button { onPick(word) } label: {
                                Text(word)
                                    .centraidType("small")
                                    .foregroundStyle(Theme.color("text", scheme))
                                    .padding(.horizontal, 12)
                                    .frame(minHeight: CentraidGeometry.targetMinFine)
                                    .background(Capsule().fill(Theme.color("bgSunken", scheme)))
                                    .contentShape(Capsule())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("words-suggestion-\(cell.position)-\(word)")
                        }
                    }
                    .padding(.leading, 34)
                }
                .privacySensitive()
            }
        }
    }

    private var tone: String {
        switch cell.mark {
        case .known: return "success"
        case .unknown: return "attention"
        default: return "lineStrong"
        }
    }
}

/// One restored vault: its line, and its safety number large and grouped so
/// it can be read against the laptop's.
private struct RestoredLine: View {
    let line: Centraid_Screen_V1_RestoredVaultLine
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(line.line)
                .centraidType("bodyStrong")
                .foregroundStyle(Theme.color("text", scheme))
            if !line.safetyNumber.isEmpty {
                Text(line.safetyNumber)
                    .centraidType("display")
                    .foregroundStyle(Theme.color("text", scheme))
                    .accessibilityIdentifier("words-safety-number")
                Text(line.safetyLabel)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// One vault that stayed with the other phone (`WordsEntryState.stayed`,
/// R-1047-R5): the machine's sentence behind a `seam` rule — "not yet, and
/// not wrong" (DESIGN.md), since the vault is safe where it is. No control:
/// the core has no retry for one vault.
private struct StayedLine: View {
    let line: String
    let at: Int
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Rectangle()
                .fill(Theme.color("seam", scheme))
                .frame(width: 2)
            Text(line)
                .centraidType("body")
                .foregroundStyle(Theme.color("text", scheme))
                .fixedSize(horizontal: false, vertical: true)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("words-stayed-\(at)")
    }
}

// MARK: - words.show

/// SHOW THE 24 WORDS AGAIN (`WordsShowState`, #1047 E5), from the More sheet.
///
/// ASK's primary is this view's one duty beyond drawing: it runs the phone's
/// owner check (`LAContext` `.deviceOwnerAuthentication` — Face ID, Touch ID
/// or the passcode) with the state's `verify_reason`, and answers `Verified`
/// or `VerifyFailed`. It never sends `Primary` from ASK. The words reach the
/// state only in SHOW, behind the same shield words.make draws; a swipe and
/// leaving the foreground both send `Dismissed` (the shell's).
struct WordsShowView: View {
    let data: Data
    let send: (Data) -> Void

    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_WordsShowState {
        (try? Centraid_Screen_V1_WordsShowState(serializedBytes: data)) ?? .init()
    }

    var body: some View {
        let state = state
        WordsShield(secure: state.secure) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    WordsHead(title: state.title, lead: state.body)

                    if !state.words.isEmpty {
                        ShownWords(cells: state.words)
                    }

                    WordsNotice(notice: state.notice)

                    if state.phase == .loading {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .accessibilityIdentifier("words-show-loading")
                    }

                    WordsControls(
                        primary: state.primaryLabel,
                        primaryEnabled: !state.primaryLabel.isEmpty,
                        secondary: state.secondaryLabel,
                        prefix: "words-show",
                        onPrimary: {
                            if state.phase == .ask {
                                verify(reason: state.verifyReason)
                            } else {
                                send(Self.event { $0.primary = .init() })
                            }
                        },
                        onSecondary: { send(Self.event { $0.secondary = .init() }) }
                    )
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.vertical, 24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Theme.color("bg", scheme).ignoresSafeArea())
            .accessibilityElement(children: .contain)
            .accessibilityLabel(state.accessibilityLabel)
            .accessibilityIdentifier("words-show")
        }
    }

    /// THE OWNER CHECK. A phone with no passcode cannot evaluate the policy,
    /// and that is a failed check, never a pass.
    private func verify(reason: String) {
        LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
            DispatchQueue.main.async {
                send(Self.event { event in
                    if ok { event.verified = .init() } else { event.verifyFailed = .init() }
                })
            }
        }
    }

    static func event(_ build: (inout Centraid_Screen_V1_WordsShowEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_WordsShowEvent()
        build(&event)
        return event.encoded
    }
}

// MARK: - shared parts

struct WordsHead: View {
    let title: String
    let lead: String
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !title.isEmpty {
                Text(title)
                    .centraidType("title")
                    .foregroundStyle(Theme.color("text", scheme))
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("words-title")
            }
            if !lead.isEmpty {
                Text(lead)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct WordsNotice: View {
    let notice: String
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if !notice.isEmpty {
            Text(notice)
                .centraidType("small")
                .foregroundStyle(Theme.color("net", scheme))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("words-notice")
        }
    }
}

struct WordsControls: View {
    let primary: String
    let primaryEnabled: Bool
    let secondary: String
    let prefix: String
    let onPrimary: () -> Void
    let onSecondary: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: 4) {
            if !primary.isEmpty {
                KitInkButton(label: primary, action: onPrimary)
                    .disabled(!primaryEnabled)
                    .opacity(primaryEnabled ? 1 : 0.4)
                    .accessibilityIdentifier("\(prefix)-primary")
            }
            if !secondary.isEmpty {
                Button(action: onSecondary) {
                    Text(secondary)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("link", scheme))
                        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("\(prefix)-secondary")
            }
        }
        .padding(.top, 8)
    }
}

/// THE WORDS, SHOWN ONCE: numbered, in two columns, in order down each
/// column. Plain text with selection off and no menu — nothing here can put a
/// word on the clipboard.
private struct ShownWords: View {
    let cells: [Centraid_Screen_V1_WordCell]
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let half = (cells.count + 1) / 2
        HStack(alignment: .top, spacing: 16) {
            column(Array(cells.prefix(half)))
            column(Array(cells.dropFirst(half)))
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                .fill(Theme.color("bgSunken", scheme))
        )
        .textSelection(.disabled)
        .privacySensitive()
        .accessibilityIdentifier("words-shown")
    }

    private func column(_ cells: [Centraid_Screen_V1_WordCell]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(cells, id: \.position) { cell in
                HStack(spacing: 8) {
                    Text("\(cell.position)")
                        .centraidType("mono")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                        .frame(minWidth: 22, alignment: .trailing)
                    Text(cell.word)
                        .centraidType("bodyStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(cell.accessibilityLabel)
                .accessibilityIdentifier("words-word-\(cell.position)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The box a word field sits in, inked by the state's mark.
private struct WordBox<Content: View>: View {
    let tone: String
    @ViewBuilder let content: () -> Content
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        content()
            .padding(.horizontal, 12)
            .frame(minHeight: CentraidGeometry.targetMinCoarse)
            .background(
                RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                    .strokeBorder(Theme.color(tone, scheme), lineWidth: 1.5)
            )
    }
}

// MARK: - the word field (duties 2 and 3)

/// A FIELD FOR ONE WORD, with nothing a keyboard could learn from and no
/// menu that could paste or copy.
///
/// The keystrokes live in the field (a round trip per key loses letters —
/// `MachineTextField`'s reason), and each difference goes over as the
/// screen's edit event. The field ADOPTS the machine's value only when it is
/// something the field did not send: a picked suggestion, or the words a
/// space ran on from this cell (the machine keeps this cell's word and
/// spreads the rest).
struct WordField: UIViewRepresentable {
    let value: String
    let position: UInt32
    let spoken: String
    let identifier: String
    let focus: Binding<UInt32?>
    let font: UIFont
    let color: UIColor
    let onEdit: (String) -> Void
    let onReturn: () -> Void

    func makeUIView(context: Context) -> WordTextField {
        let field = WordTextField()
        field.font = font
        field.textColor = color
        // DUTY 3: nothing the keyboard may learn or complete from.
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.spellCheckingType = .no
        field.smartQuotesType = .no
        field.smartDashesType = .no
        field.smartInsertDeleteType = .no
        field.inlinePredictionType = .no
        field.keyboardType = .asciiCapable
        // No `textContentType`: AutoFill must not offer, or keep, a word.
        field.returnKeyType = .next
        field.inputAssistantItem.leadingBarButtonGroups = []
        field.inputAssistantItem.trailingBarButtonGroups = []
        // DUTY 2: no drag out, no drop in.
        field.textDragInteraction?.isEnabled = false
        field.textDropDelegate = context.coordinator
        field.pasteConfiguration = nil
        field.accessibilityLabel = spoken
        field.accessibilityIdentifier = identifier
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.text = value
        context.coordinator.sent = [value]
        return field
    }

    func updateUIView(_ field: WordTextField, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        let shown = field.text ?? ""
        if shown == value {
            coordinator.sent = [value]
        } else if !coordinator.sent.contains(value) {
            field.text = value
            coordinator.sent = [value]
        }
        field.isEnabled = context.environment.isEnabled
        // FOCUS MOVES ON A CHANGE, NEVER ON A RE-RENDER. A cell that took the
        // keyboard back whenever `focus` still named it stole it from the
        // endpoint field on its first keystroke — that edit re-renders every
        // cell — and the rest of the address landed in a word cell (#1047 E5,
        // seen on the simulator).
        let wanted = focus.wrappedValue
        defer { coordinator.appliedFocus = wanted }
        guard wanted != coordinator.appliedFocus else { return }
        if wanted == position, !field.isFirstResponder {
            DispatchQueue.main.async { field.becomeFirstResponder() }
        } else if wanted == nil, field.isFirstResponder {
            DispatchQueue.main.async { field.resignFirstResponder() }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UITextFieldDelegate, UITextDropDelegate {
        var parent: WordField
        /// What this field sent since it last agreed with the machine.
        var sent: Set<String> = []
        /// The `focus` this field last acted on (see `updateUIView`).
        var appliedFocus: UInt32?

        init(parent: WordField) { self.parent = parent }

        @objc func changed(_ field: UITextField) {
            let text = field.text ?? ""
            sent.insert(text)
            parent.onEdit(text)
        }

        func textFieldDidBeginEditing(_ field: UITextField) {
            appliedFocus = parent.position
            if parent.focus.wrappedValue != parent.position { parent.focus.wrappedValue = parent.position }
        }

        func textFieldShouldReturn(_ field: UITextField) -> Bool {
            parent.onReturn()
            return false
        }

        func textDroppableView(_ view: UIView & UITextDroppable, proposalForDrop drop: UITextDropRequest) -> UITextDropProposal {
            UITextDropProposal(operation: .cancel)
        }
    }
}

/// A text field with NO edit menu: no paste (the clipboard is never read
/// into a word), no copy or cut (a word is never put on it), no share, no
/// look-up and no Scan Text.
final class WordTextField: UITextField {
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool { false }

    override func paste(_ sender: Any?) {}

    override func copy(_ sender: Any?) {}

    override func cut(_ sender: Any?) {}
}

// MARK: - the shield (duty 1)

/// SHIELD THE SCREEN while `secure` is set: capture-proof content, and a cover
/// while the screen is being recorded or mirrored, or the scene is not active.
struct WordsShield<Content: View>: View {
    let secure: Bool
    @ViewBuilder let content: () -> Content

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var scheme
    @State private var captured = WordsShieldCapture.now

    var body: some View {
        Group {
            if secure {
                CaptureProof(content: content())
            } else {
                content()
            }
        }
        .overlay {
            if secure, captured || scenePhase != .active {
                Theme.color("bg", scheme)
                    .ignoresSafeArea()
                    .accessibilityHidden(true)
                    .accessibilityIdentifier("words-cover")
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIScreen.capturedDidChangeNotification)) { note in
            captured = (note.object as? UIScreen)?.isCaptured ?? WordsShieldCapture.now
        }
    }
}

enum WordsShieldCapture {
    /// Whether any screen this app draws on is being recorded or mirrored.
    @MainActor static var now: Bool {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.screen.isCaptured }
            .contains(true)
    }
}

/// CONTENT A SCREENSHOT OR A RECORDING DOES NOT SEE.
///
/// A secure text field draws its text into a canvas view whose layer the
/// system leaves out of every capture — screenshots, screen recording,
/// AirPlay. That canvas is lifted out of a secure field and the SwiftUI
/// content is hosted inside it, so the whole screen inherits the exclusion
/// while staying interactive. When a future UIKit no longer has the canvas,
/// the content is hosted plainly and the capture cover in `WordsShield` is
/// what remains (it still blanks recordings; a still screenshot is then not
/// prevented).
struct CaptureProof<Content: View>: UIViewRepresentable {
    let content: Content

    func makeUIView(context: Context) -> CaptureProofView {
        CaptureProofView(root: AnyView(content))
    }

    func updateUIView(_ view: CaptureProofView, context: Context) {
        view.host.rootView = AnyView(content)
    }
}

final class CaptureProofView: UIView {
    let host: UIHostingController<AnyView>
    private let field = UITextField()

    init(root: AnyView) {
        host = UIHostingController(rootView: root)
        super.init(frame: .zero)
        // THE OUTER VIEW ALREADY MOVES FOR THE KEYBOARD AND THE SAFE AREA; an
        // inner host that did it again would double both.
        host.safeAreaRegions = []
        host.view.backgroundColor = .clear
        backgroundColor = .clear

        field.isSecureTextEntry = true
        field.layoutIfNeeded()
        let canvas = field.subviews.first { String(describing: type(of: $0)).contains("Canvas") }
            ?? field.subviews.first
            ?? UIView()
        canvas.removeFromSuperview()
        canvas.subviews.forEach { $0.removeFromSuperview() }
        canvas.isUserInteractionEnabled = true
        canvas.backgroundColor = .clear
        canvas.translatesAutoresizingMaskIntoConstraints = false
        addSubview(canvas)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        canvas.addSubview(host.view)
        NSLayoutConstraint.activate([
            canvas.leadingAnchor.constraint(equalTo: leadingAnchor),
            canvas.trailingAnchor.constraint(equalTo: trailingAnchor),
            canvas.topAnchor.constraint(equalTo: topAnchor),
            canvas.bottomAnchor.constraint(equalTo: bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: canvas.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: canvas.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: canvas.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: canvas.bottomAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
}
