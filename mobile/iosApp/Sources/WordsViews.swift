import PhotosUI
import SwiftUI
import UIKit

// THE 24 WORDS, DRAWN (#1047 E2, restyled for #1173). Two screens over the shared machines:
// `words.make` (`WordsMakeState`) and `words.enter` (`WordsEnterState`), drawn from Rust's view state.
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
//
// THE LOOK (#1173, the RecoveryKey, RestoreWords and RestoreHeld boards): a page
// of cards in the shell's teal. The words are white chips in three columns, a notice is a
// tinted callout, the leave control is a round X, and the answers sit at the foot in one
// stack: a tonal verb, then the ink one.

/// The three columns the words sit in, numbered across.
private let wordColumns = Array(repeating: GridItem(.flexible(), spacing: 8), count: 3)

// MARK: - words.make

/// MAKE A VAULT, AND ITS 24 WORDS (`VaultWordsState`).
struct VaultWordsView: View {
    let state: Centraid_Core_V1_WordsMakeState
    let send: (Centraid_Core_V1_WordsMakeEvent) -> Void
    /// The screen is finished (made, left): the shell pops it.
    let onDone: () -> Void

    var body: some View {
        WordsShield(secure: state.secure) {
            WordsFrame(
                closeLabel: state.secondaryLabel,
                closeIdentifier: "words-make-secondary",
                onClose: { send(Self.event { $0.secondary = .init() }) },
                identifier: "words-make"
            ) {
                WordsHead(title: state.title, lead: state.body)

                // CHOOSE (R-1047-E18): the vault's name, and whether it is
                // kept on its own 24 words.
                if !state.nameLabel.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(state.nameLabel)
                            .kitType(.meta)
                            .foregroundStyle(Surface.meta)
                        MachineTextField(placeholder: "", value: state.name) { text in
                            send(Self.event { $0.name = .with { $0.text = text } })
                        }
                        .textInputAutocapitalization(.words)
                        .kitType(.row)
                        .wordsFieldBox()
                        .accessibilityLabel(state.nameLabel)
                        .accessibilityIdentifier("words-make-name")
                    }
                }
                if !state.ownLabel.isEmpty {
                    WordsCheckbox(label: state.ownLabel, on: state.ownOn, identifier: "words-make-own") { on in
                        send(Self.event { $0.own = .with { $0.on = on } })
                    }
                }

                if !state.words.isEmpty {
                    ShownWords(cells: state.words)
                }
                // WHERE THE KEY IS KEPT, in the platform's own words: a state the member should
                // act on (Save a copy), so it is amber.
                if !state.custody.isEmpty {
                    WordsCallout(text: state.custody, state: .amber, identifier: "words-custody")
                }

                WordsNotice(notice: state.notice)

                if state.phase == .checking || state.phase == .making {
                    KitSpinner()
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("words-making")
                }
            } footer: {
                if !state.saveLabel.isEmpty, !state.words.isEmpty {
                    WordsTonalButton(label: state.saveLabel, iconKey: "Share", identifier: "words-save-copy") {
                        send(Self.event { $0.saveCopy = .init() })
                    }
                }
                // THE PRIMARY AND RESTORING ARE ALTERNATIVES: one stack, one ink button.
                if !state.primaryLabel.isEmpty {
                    KitInkButton(label: state.primaryLabel) {
                        send(Self.event { $0.primary = .init() })
                    }
                    .disabled(!state.primaryEnabled)
                    .accessibilityIdentifier("words-make-primary")
                }
                if !state.restoreLabel.isEmpty {
                    if state.primaryLabel.isEmpty {
                        KitInkButton(label: state.restoreLabel) {
                            send(Self.event { $0.restore = .init() })
                        }
                        .accessibilityIdentifier("words-make-restore")
                    } else {
                        WordsTonalButton(label: state.restoreLabel, identifier: "words-make-restore") {
                            send(Self.event { $0.restore = .init() })
                        }
                    }
                }
            }
        }
        .onAppear { if state.finished { onDone() } }
        .onChange(of: state.finished) { _, finished in if finished { onDone() } }
    }

    static func event(_ build: (inout Centraid_Core_V1_WordsMakeEvent) -> Void) -> Centraid_Core_V1_WordsMakeEvent {
        var event = Centraid_Core_V1_WordsMakeEvent()
        build(&event)
        return event
    }
}

// MARK: - words.enter

/// TYPE THE 24 WORDS BACK (`WordsEntryState`): a restore onto this phone, or
/// this phone's own vaults given their key again (Locker's wall).
struct WordsEntryView: View {
    let state: Centraid_Core_V1_WordsEnterState
    let send: (Centraid_Core_V1_WordsEnterEvent) -> Void
    let onDone: () -> Void

    @Environment(\.colorScheme) private var scheme
    @State private var focus: UInt32?
    @State private var scanning = false
    @State private var choosingPhoto = false
    @State private var photo: PhotosPickerItem?

    private var held: Bool { !state.heldFound.isEmpty }

    var body: some View {
        let working = state.phase == .working
        WordsShield(secure: state.secure) {
            WordsFrame(
                closeLabel: state.secondaryLabel,
                closeIdentifier: "words-enter-secondary",
                onClose: {
                    focus = nil
                    send(Self.event { $0.secondary = .init() })
                },
                identifier: "words-enter",
                dismissesKeyboard: true
            ) {
                WordsHead(title: state.title, lead: state.body)

                // A HELD KEY IS ALREADY HERE: say so, and where it came from.
                if held {
                    WordsHeldCard(found: state.heldFound, place: state.heldPlace)
                }

                if !state.cells.isEmpty {
                    LazyVGrid(columns: wordColumns, spacing: 8) {
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
                                onReturn: {
                                    focus = cell.position < 24 ? cell.position + 1 : nil
                                }
                            )
                        }
                    }
                    .disabled(working)

                    // THE LIST WORDS THE FOCUSED CELL'S PREFIX COULD BE, each a tap that sends
                    // `WordsSuggestionPicked`: one row under the grid, for the cell being typed in.
                    if let cell = suggesting {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(cell.suggestions, id: \.self) { word in
                                    KitChip(
                                        label: word,
                                        selected: false,
                                        identifier: "words-suggestion-\(cell.position)-\(word)"
                                    ) {
                                        send(Self.event { $0.picked = .with { $0.position = cell.position; $0.word = word } })
                                        focus = cell.position < 24 ? cell.position + 1 : nil
                                    }
                                }
                            }
                        }
                        .privacySensitive()
                    }
                }

                WordsNotice(notice: state.notice)

                if !state.endpointLabel.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(state.endpointLabel)
                            .kitType(.meta)
                            .foregroundStyle(Surface.meta)
                            .fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 8) {
                            MachineTextField(placeholder: state.endpointPlaceholder, value: state.endpoint) { text in
                                send(Self.event { $0.endpoint = .with { $0.text = text } })
                            }
                            .keyboardType(.URL)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                            .centraidType(held ? "mono" : "body")
                            .wordsFieldBox()
                            .accessibilityLabel(state.endpointLabel)
                            .accessibilityIdentifier("words-endpoint")

                            // THE CODE IS SCANNED AS WELL AS PASTED, as pairing's is. Beside the
                            // field while the words are typed; a held restore has the room for
                            // a full-width one in the footer.
                            if !state.scanLabel.isEmpty, !held {
                                WordsScanSquare(label: state.scanLabel) { startScan() }
                                    .disabled(working)
                            }
                        }
                    }
                    .disabled(working)
                }

                // A HELD RESTORE NAMES the vaults on their own words it
                // will also bring back (R-1047-E18).
                if !state.heldKeysLabel.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(state.heldKeysLabel)
                            .kitType(.meta)
                            .foregroundStyle(Surface.meta)
                            .fixedSize(horizontal: false, vertical: true)
                        WordsHeldKeys(names: state.heldKeys)
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("words-held-keys")
                }

                if !state.progress.isEmpty {
                    KitSpinner(label: state.progress)
                        .accessibilityIdentifier("words-progress")
                }
            } footer: {
                // LEAVE THE HELD SEED for the grid: a link, then the scan, then the verb.
                if !state.wordsLabel.isEmpty {
                    KitLink(label: state.wordsLabel, tint: AppAccent.shell.text, identifier: "words-use-words") {
                        send(Self.event { $0.useWords = .init() })
                    }
                    .frame(maxWidth: .infinity)
                    .foregroundStyle(AppAccent.shell.text)
                }
                if !state.scanLabel.isEmpty, held {
                    WordsTonalButton(label: state.scanLabel, iconKey: "Maximize", identifier: "words-scan") {
                        startScan()
                    }
                    .disabled(working)
                }
                if !state.primaryLabel.isEmpty {
                    KitInkButton(label: state.primaryLabel) {
                        focus = nil
                        send(Self.event { $0.primary = .init() })
                    }
                    .disabled(!state.primaryEnabled)
                    .accessibilityIdentifier("words-enter-primary")
                }
            }
            .fullScreenCover(isPresented: $scanning) {
                PairScanner(
                    photoLabel: state.photoLabel,
                    onRead: { payload in
                        scanning = false
                        send(Self.event { $0.scanned = .with { $0.payload = payload } })
                    },
                    onPhoto: {},
                    onUnread: {
                        scanning = false
                        send(Self.event { $0.unread = .init() })
                    },
                    onCancel: { scanning = false }
                )
                .ignoresSafeArea()
            }
            .photosPicker(isPresented: $choosingPhoto, selection: $photo, matching: .images)
            .onChange(of: photo) { _, item in
                guard let item else { return }
                photo = nil
                Task {
                    let data = try? await item.loadTransferable(type: Data.self)
                    let code = data.flatMap(PairPhotoReader.read)
                    await MainActor.run {
                        send(Self.event {
                            if let code {
                                $0.scanned = .with { $0.payload = code }
                            } else {
                                $0.unread = .init()
                            }
                        })
                    }
                }
            }
        }
        .onAppear {
            // WHAT THIS PHONE CAN SCAN WITH is the shell's to say, once.
            send(Self.event { $0.capability = .with { $0.camera = PairScanner.available } })
            if state.finished { onDone() }
            if state.phase == .entering, focus == nil, !state.cells.isEmpty { focus = 1 }
        }
        .onChange(of: state.finished) { _, finished in if finished { onDone() } }
        .onChange(of: state.phase) { _, phase in if phase != .entering { focus = nil } }
    }

    /// The camera, or the photo picker where there is none (`scan_camera`).
    private func startScan() {
        if state.scanCamera { scanning = true } else { choosingPhoto = true }
    }

    /// The cell whose list words show: the one being typed in, else the first that has any.
    private var suggesting: Centraid_Core_V1_WordEntry? {
        state.cells.first { $0.position == focus && !$0.suggestions.isEmpty }
            ?? state.cells.first { !$0.suggestions.isEmpty }
    }

    static func event(_ build: (inout Centraid_Core_V1_WordsEnterEvent) -> Void) -> Centraid_Core_V1_WordsEnterEvent {
        var event = Centraid_Core_V1_WordsEnterEvent()
        build(&event)
        return event
    }
}

/// One of the 24 cells: its number inside a white box, the field, and a mark on the edge: red
/// for a word that is not on the list, the shell's teal for the cell being typed in.
private struct EntryCell: View {
    let cell: Centraid_Core_V1_WordEntry
    let focus: Binding<UInt32?>
    let onEdit: (String) -> Void
    let onReturn: () -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let focused = focus.wrappedValue == cell.position
        let unknown = cell.mark == .unknown
        HStack(spacing: 6) {
            Text("\(cell.position)")
                .centraidType("mono")
                .foregroundStyle(Surface.meta)
                .accessibilityHidden(true)
            WordField(
                value: cell.typed,
                placeholder: cell.prompt,
                position: cell.position,
                spoken: cell.accessibilityLabel,
                identifier: "words-cell-\(cell.position)",
                focus: focus,
                font: Theme.uiFont("body", scheme, dynamicTypeSize),
                color: UIColor(Surface.ink),
                placeholderColor: UIColor(Surface.meta),
                onEdit: onEdit,
                onReturn: onReturn
            )
        }
        .padding(.horizontal, 10)
        .frame(minHeight: CentraidGeometry.targetMinCoarse)
        .wordsBox(
            border: unknown ? StateColor.red.text : (focused ? AppAccent.shell.text : Surface.border),
            width: unknown || focused ? 1.5 : CentraidGeometry.hairline
        )
    }
}

/// The card that says a recovery key is already on this phone, and where it came from.
private struct WordsHeldCard: View {
    let found: String
    let place: String
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let accent = AppAccent.shell
        HStack(spacing: 12) {
            CentraidIconView(iconKey: "Key", tint: accent.text, size: 20)
                .frame(width: 44, height: 44)
                .wordsBox(fill: accent.wash(dark: scheme == .dark), border: nil)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(found)
                    .kitType(.row)
                    .fontWeight(.semibold)
                    .foregroundStyle(Surface.ink)
                if !place.isEmpty {
                    Text(place)
                        .kitType(.meta)
                        .foregroundStyle(Surface.meta)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .kitCard()
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("words-held-found")
    }
}

/// The vaults on their own recovery key, one white card of rows: an initial, then the name.
private struct WordsHeldKeys: View {
    let names: [String]

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(names.enumerated()), id: \.offset) { at, name in
                HStack(spacing: 12) {
                    Text(String(name.prefix(1)).uppercased())
                        .kitType(.row)
                        .fontWeight(.semibold)
                        .foregroundStyle(Surface.ink)
                        .frame(width: 32, height: 32)
                        .wordsBox(fill: Surface.fill, border: nil)
                        .accessibilityHidden(true)
                    Text(name)
                        .kitType(.row)
                        .foregroundStyle(Surface.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                if at < names.count - 1 {
                    Rectangle().fill(Surface.line).frame(height: CentraidGeometry.hairline)
                }
            }
        }
        .kitCard()
    }
}

// MARK: - words.show

/// SHOW THE RECOVERY KEY AGAIN (`WordsShowState`, #1047 E5), from the Backup
/// tab.
///
/// The owner check is Rust's to ask (the generic `OwnerCheck` effect, which the
/// store performs): while `check_now` nothing is drawn; after a failed check,
/// ASK is drawn and its primary asks again. The words reach the state only in
/// SHOW, behind the same shield words.make draws.
struct WordsShowView: View {
    let state: Centraid_Core_V1_WordsShowState
    let send: (Centraid_Core_V1_WordsShowEvent) -> Void
    let onDone: () -> Void

    /// THE OWNER CHECK IS UP: nothing is drawn, only the page's own colour, until it answers
    /// (every label is empty while `check_now` is set).
    var body: some View {
        Group {
            if state.checkNow {
                BarePaper()
            } else {
                shown
            }
        }
        // Cancellation can finish while the owner-check branch still draws BarePaper.
        .onAppear { if state.finished { onDone() } }
        .onChange(of: state.finished) { _, finished in if finished { onDone() } }
        // A SWIPE AWAY drops the words (leaving the foreground does too, in Rust).
        .onDisappear { if !state.finished { send(Self.event { $0.dismissed = .init() }) } }
    }

    private var shown: some View {
        WordsShield(secure: state.secure) {
            WordsFrame(
                closeLabel: state.secondaryLabel,
                closeIdentifier: "words-show-secondary",
                onClose: { send(Self.event { $0.secondary = .init() }) },
                identifier: "words-show"
            ) {
                WordsHead(title: state.title, lead: state.body)

                if !state.words.isEmpty {
                    ShownWords(cells: state.words)
                }

                WordsNotice(notice: state.notice)

                if state.phase == .loading {
                    KitSpinner()
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("words-show-loading")
                }
            } footer: {
                if !state.saveLabel.isEmpty, !state.words.isEmpty {
                    WordsTonalButton(label: state.saveLabel, iconKey: "Share", identifier: "words-save-copy") {
                        send(Self.event { $0.saveCopy = .init() })
                    }
                }
                if !state.primaryLabel.isEmpty {
                    KitInkButton(label: state.primaryLabel) {
                        send(Self.event { $0.primary = .init() })
                    }
                    .accessibilityIdentifier("words-show-primary")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(state.accessibilityLabel)
        }
    }

    static func event(_ build: (inout Centraid_Core_V1_WordsShowEvent) -> Void) -> Centraid_Core_V1_WordsShowEvent {
        var event = Centraid_Core_V1_WordsShowEvent()
        build(&event)
        return event
    }
}

// MARK: - shared parts

/// THE WORDS PAGES' FRAME: a round X at the top leading edge (the screen's own leave control,
/// `secondary_label`, spoken as its label), the content scrolling, and the answers pinned at
/// the foot. With no leave control and no answers it is just the page.
struct WordsFrame<Content: View, Footer: View>: View {
    let closeLabel: String
    let closeIdentifier: String
    let onClose: () -> Void
    let identifier: String
    var dismissesKeyboard = false
    @ViewBuilder let content: () -> Content
    @ViewBuilder let footer: () -> Footer

    var body: some View {
        VStack(spacing: 0) {
            if !closeLabel.isEmpty {
                HStack {
                    Button(action: onClose) {
                        CentraidIconView(iconKey: "X", tint: Surface.ink, size: 16)
                            .frame(width: 44, height: 44)
                            .background(Surface.card, in: Circle())
                            .overlay(Circle().strokeBorder(Surface.border, lineWidth: CentraidGeometry.hairline))
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(closeLabel)
                    .accessibilityIdentifier(closeIdentifier)
                    Spacer()
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.top, 8)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    content()
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.top, 12)
                .padding(.bottom, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(dismissesKeyboard ? .interactively : .automatic)
            VStack(spacing: 12) {
                footer()
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Surface.page.ignoresSafeArea())
        // THE ROUND X IS THE WAY OUT: with it drawn the stack's own back chevron would be a
        // second one (the board has a single control).
        .toolbar(closeLabel.isEmpty ? .automatic : .hidden, for: .navigationBar)
        .accessibilityIdentifier(identifier)
    }
}

struct WordsHead: View {
    let title: String
    let lead: String
    /// A badge page (PairDevice, PairCheck) centres its head over the badge.
    var centered = false

    var body: some View {
        VStack(alignment: centered ? .center : .leading, spacing: 8) {
            if !title.isEmpty {
                Text(title)
                    .kitType(.title)
                    .foregroundStyle(Surface.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(centered ? .center : .leading)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("words-title")
            }
            if !lead.isEmpty {
                Text(lead)
                    .kitType(.row)
                    .foregroundStyle(Surface.body)
                    .multilineTextAlignment(centered ? .center : .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A SENTENCE ABOUT A STATE on a pale ground of that state's colour, with its mark: a red one
/// for what went wrong, an amber one for what the member should do.
struct WordsCallout: View {
    let text: String
    let state: StateColor
    var identifier = ""

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            CentraidIconView(iconKey: "AlertCircle", tint: state.text, size: 18)
                .padding(.top, 1)
                .accessibilityHidden(true)
            Text(text)
                .kitType(.row)
                .foregroundStyle(state.text)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .wordsBox(fill: state.tint, border: nil)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }
}

struct WordsNotice: View {
    let notice: String

    var body: some View {
        if !notice.isEmpty {
            WordsCallout(text: notice, state: .red, identifier: "words-notice")
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

    var body: some View {
        // NOTHING DRAWN WHEN THERE IS NOTHING TO DRAW: an empty stack would
        // still spend its top padding and a gap in whatever holds it.
        if !primary.isEmpty || !secondary.isEmpty {
            VStack(spacing: 4) {
                if !primary.isEmpty {
                    KitInkButton(label: primary, action: onPrimary)
                        .disabled(!primaryEnabled)
                        .accessibilityIdentifier("\(prefix)-primary")
                }
                if !secondary.isEmpty {
                    KitLink(label: secondary, tint: AppAccent.shell.text, identifier: "\(prefix)-secondary", action: onSecondary)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.top, 8)
        }
    }
}

/// A SECOND VERB IN THE SHELL'S TINT: the shell's teal over its own pale ground, full width,
/// beside the one ink button ("Save a copy", "Scan QR code", "Try again").
struct WordsTonalButton: View {
    let label: String
    var iconKey: String? = nil
    var identifier = ""
    let action: () -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        let accent = AppAccent.shell
        Button(action: action) {
            HStack(spacing: 8) {
                if let iconKey {
                    CentraidIconView(iconKey: iconKey, tint: enabled ? accent.text : Surface.meta, size: 16)
                }
                Text(label)
                    .kitType(.row)
                    .fontWeight(.semibold)
            }
            .foregroundStyle(enabled ? accent.text : Surface.meta)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
            .background(accent.wash(dark: scheme == .dark), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
    }
}

/// THE SCAN CONTROL BESIDE THE CODE'S FIELD: a square tonal key with the viewfinder, its words
/// spoken, not drawn.
private struct WordsScanSquare: View {
    let label: String
    let action: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let accent = AppAccent.shell
        Button(action: action) {
            CentraidIconView(iconKey: "Maximize", tint: accent.text, size: 20)
                .frame(width: 52, height: 52)
                .wordsBox(fill: accent.wash(dark: scheme == .dark), border: nil)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier("words-scan")
    }
}

private extension View {
    /// A field's box: a white card with a hairline edge, the shape every words field wears.
    func wordsFieldBox() -> some View {
        padding(.horizontal, 12)
            .frame(minHeight: 52)
            .wordsBox()
    }
}

/// A BOX OF THE WORDS PAGES: the control radius from the token scale, white by default with a
/// hairline edge; a pale ground (a state, a tint) passes its fill and no edge.
private struct WordsBox: ViewModifier {
    var fill: Color
    var border: Color?
    var width: CGFloat

    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: Theme.radius("lg", scheme), style: .continuous)
        content
            .background(fill, in: shape)
            .overlay {
                if let border { shape.strokeBorder(border, lineWidth: width) }
            }
    }
}

extension View {
    fileprivate func wordsBox(
        fill: Color = Surface.card,
        border: Color? = Surface.border,
        width: CGFloat = CentraidGeometry.hairline
    ) -> some View {
        modifier(WordsBox(fill: fill, border: border, width: width))
    }
}

/// A CHECKBOX on the words screens: the make flow's "Give this vault its own
/// recovery key" (`VaultWordsState.own_label`).
private struct WordsCheckbox: View {
    let label: String
    let on: Bool
    var identifier = "words-check"
    let toggle: (Bool) -> Void

    var body: some View {
        HStack(spacing: 0) {
            KitCheckBox(checked: on, label: label, identifier: identifier) { toggle(!on) }
            // The words beside the box are a target too; the box speaks them.
            Button { toggle(!on) } label: {
                WordsCheckboxLabel(label: label)
            }
            .buttonStyle(.plain)
            .accessibilityHidden(true)
        }
    }
}

private struct WordsCheckboxLabel: View {
    let label: String

    var body: some View {
        Text(label)
            .kitType(.row)
            .foregroundStyle(Surface.ink)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
            .contentShape(Rectangle())
    }
}

/// THE WORDS, SHOWN ONCE: numbered across three columns, each a white chip. Plain text with
/// selection off and no menu — nothing here can put a word on the clipboard.
private struct ShownWords: View {
    let cells: [Centraid_Core_V1_WordCell]

    var body: some View {
        LazyVGrid(columns: wordColumns, spacing: 8) {
            ForEach(cells, id: \.position) { cell in
                HStack(spacing: 6) {
                    Text("\(cell.position)")
                        .centraidType("mono")
                        .foregroundStyle(Surface.meta)
                    Text(cell.word)
                        .kitType(.row)
                        .fontWeight(.semibold)
                        .foregroundStyle(Surface.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
                .padding(.horizontal, 10)
                .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
                .wordsBox()
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(cell.accessibilityLabel)
                .accessibilityIdentifier("words-word-\(cell.position)")
            }
        }
        .textSelection(.disabled)
        .privacySensitive()
        .accessibilityIdentifier("words-shown")
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
    /// What the cell says while it is empty ("Word 19").
    let placeholder: String
    let position: UInt32
    let spoken: String
    let identifier: String
    let focus: Binding<UInt32?>
    let font: UIFont
    let color: UIColor
    let placeholderColor: UIColor
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
        field.attributedPlaceholder = NSAttributedString(
            string: placeholder,
            attributes: [.foregroundColor: placeholderColor, .font: font]
        )
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
        } else if !coordinator.sent.contains(value) || Self.keptWord(of: shown) == value {
            // THE SECOND CLAUSE IS A RUN THIS CELL SPREAD. Typing
            // "abandon ability …" sent "abandon" on its way to the space, so
            // the machine's answer — this cell keeps "abandon" and the rest go
            // on — looked like a stale echo of that keystroke and the cell kept
            // showing the whole run (#1047 E5). A cell holds one word, so text
            // with a separator in it is never what it rests on: the machine's
            // kept word replaces it.
            field.text = value
            coordinator.sent = [value]
        }
        field.isEnabled = context.environment.isEnabled
        // THE FONT FOLLOWS THE SYSTEM TEXT SIZE: `makeUIView` set it once, and a
        // setting changed while the field is on screen arrives here.
        if field.font != font { field.font = font }
        if field.placeholder != placeholder {
            field.attributedPlaceholder = NSAttributedString(
                string: placeholder,
                attributes: [.foregroundColor: placeholderColor, .font: font]
            )
        }
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

    /// The word the machine keeps in this cell when `text` runs on past it:
    /// everything before the first space, newline or tab, split exactly as
    /// `WordsEntry`'s `spread` splits. Nil when `text` is one word.
    nonisolated static func keptWord(of text: String) -> String? {
        let parts = text.split(
            omittingEmptySubsequences: false,
            whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" }
        )
        return parts.count > 1 ? String(parts[0]) : nil
    }

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
