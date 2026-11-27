import SwiftUI

struct NoteEditorSync: Equatable, Sendable {
    private(set) var lastSentSeq: UInt64 = 0

    mutating func nextSeq() -> UInt64 {
        lastSentSeq &+= 1
        return lastSentSeq
    }

    func shouldAdopt(
        remoteTitle: String,
        remoteBody: String,
        remoteRev: UInt64,
        localTitle: String,
        localBody: String
    ) -> Bool {
        (remoteTitle != localTitle || remoteBody != localBody) && remoteRev >= lastSentSeq
    }
}

enum NoteTriggerDetector {
    struct Match: Equatable, Sendable {
        let trigger: String
        let query: String
    }

    static func detect(in text: String) -> Match? {
        let line: Substring
        if let nl = text.lastIndex(of: "\n") {
            line = text[text.index(after: nl)...]
        } else {
            line = text[...]
        }

        if let openRange = line.range(of: "[[", options: .backwards) {
            let after = line[openRange.upperBound...]
            if !after.contains("]") && !after.contains("[") && after.count <= 64 {
                return Match(trigger: "[[", query: String(after))
            }
        }

        if let atIndex = line.lastIndex(of: "@") {
            let validBoundary: Bool
            if atIndex == line.startIndex {
                validBoundary = true
            } else {
                let before = line[line.index(before: atIndex)]
                validBoundary = before.isWhitespace
            }
            if validBoundary {
                let after = line[line.index(after: atIndex)...]
                let invalidChars = ".,;:[]@"
                if after.count <= 32 && after.allSatisfy({ !invalidChars.contains($0) }) {
                    return Match(trigger: "@", query: String(after))
                }
            }
        }

        return nil
    }
}

enum NoteMarkdownFormat {
    enum Action: String, CaseIterable, Sendable, Identifiable {
        case heading
        case checklist
        case bullet
        case bold
        case italic
        case code
        case wikilink
        case mention

        var id: String { rawValue }
    }

    static func apply(_ action: Action, to body: String) -> String {
        switch action {
        case .heading:
            return appendLinePrefix("# ", to: body)
        case .checklist:
            return appendLinePrefix("- [ ] ", to: body)
        case .bullet:
            return appendLinePrefix("- ", to: body)
        case .bold:
            return body + "**text**"
        case .italic:
            return body + "*text*"
        case .code:
            return body + "`code`"
        case .wikilink:
            return body + "[["
        case .mention:
            if let last = body.last, !last.isWhitespace {
                return body + " @"
            }
            return body + "@"
        }
    }

    private static func appendLinePrefix(_ prefix: String, to body: String) -> String {
        if body.isEmpty || body.hasSuffix("\n") {
            return body + prefix
        }
        return body + "\n" + prefix
    }
}

struct NoteEditorCanvasView: View {
    let editor: Centraid_Core_V1_RoomNoteEditor
    let onTap: (String) -> Void
    let onCanvas: (Centraid_Core_V1_RoomCanvasEvent) -> Void

    private enum Field: Hashable {
        case title
        case body
    }

    @State private var localTitle: String
    @State private var localBody: String
    @State private var lastEmittedTitle: String
    @State private var lastEmittedBody: String
    @State private var sync = NoteEditorSync()
    @State private var lastTrigger: NoteTriggerDetector.Match?
    @FocusState private var focusedField: Field?

    init(
        editor: Centraid_Core_V1_RoomNoteEditor,
        onTap: @escaping (String) -> Void,
        onCanvas: @escaping (Centraid_Core_V1_RoomCanvasEvent) -> Void
    ) {
        self.editor = editor
        self.onTap = onTap
        self.onCanvas = onCanvas
        _localTitle = State(initialValue: editor.title)
        _localBody = State(initialValue: editor.body)
        _lastEmittedTitle = State(initialValue: editor.title)
        _lastEmittedBody = State(initialValue: editor.body)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if editor.hasAutosave {
                    autosaveStrip(editor.autosave)
                }

                if editor.readOnly {
                    readOnlyContent
                } else {
                    editableContent
                }

                if !editor.assets.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(editor.assets.enumerated()), id: \.offset) { _, asset in
                            RoomMediaBlock(media: asset, onTap: onTap)
                        }
                    }
                    .padding(.top, 8)
                }
            }
            .padding(.vertical, 12)
            .readableColumn()
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !editor.readOnly {
                VStack(spacing: 0) {
                    if editor.hasSuggest, !editor.suggest.candidates.isEmpty {
                        suggestionStrip(editor.suggest)
                    }
                    formattingBar
                }
                .readableColumn()
            }
        }
        .modifier(OptionalIdentifier(identifier: editor.selectorID))
        .onAppear {
            if editor.focused && !editor.readOnly {
                focusedField = localTitle.isEmpty ? .title : .body
            }
        }
        .onChange(of: localTitle) { _, _ in
            emitEditIfNeeded()
        }
        .onChange(of: localBody) { _, next in
            emitEditIfNeeded()
            emitTriggerIfNeeded(for: next)
        }
        .onChange(of: editor.rev) { _, _ in
            adoptRemoteIfNeeded()
        }
        .onChange(of: editor.title) { _, _ in
            adoptRemoteIfNeeded()
        }
        .onChange(of: editor.body) { _, _ in
            adoptRemoteIfNeeded()
        }
    }

    private var readOnlyContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !localTitle.isEmpty {
                Text(localTitle)
                    .kitType(.hero)
                    .foregroundStyle(Surface.ink)
                    .textSelection(.enabled)
                    .accessibilityAddTraits(.isHeader)
            }
            if !localBody.isEmpty {
                Text(localBody)
                    .kitType(.row)
                    .foregroundStyle(Surface.ink)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, CentraidGeometry.pageMargin)
    }

    private var editableContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("", text: $localTitle, axis: .vertical)
                .focused($focusedField, equals: .title)
                .kitType(.hero)
                .foregroundStyle(Surface.ink)
                .submitLabel(.next)
                .onSubmit { focusedField = .body }
                .accessibilityLabel(KitWords.NOTE_EDITOR_TITLE)
                .accessibilityIdentifier("\(editor.selectorID)-title")

            KitHairline()

            TextField("", text: $localBody, axis: .vertical)
                .focused($focusedField, equals: .body)
                .kitType(.row)
                .foregroundStyle(Surface.ink)
                .lineLimit(8...)
                .frame(maxWidth: .infinity, minHeight: 220, alignment: .topLeading)
                .accessibilityLabel(KitWords.NOTE_EDITOR_BODY)
                .accessibilityIdentifier("\(editor.selectorID)-body")
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
    }

    @ViewBuilder
    private func autosaveStrip(_ autosave: Centraid_Core_V1_RoomAutosave) -> some View {
        if !autosave.label.isEmpty || !autosave.reloadLabel.isEmpty {
            HStack(spacing: 8) {
                if autosave.phase == .saving {
                    KitSpinner(label: autosave.label)
                } else if !autosave.label.isEmpty {
                    Text(autosave.label)
                        .kitType(.meta)
                        .foregroundStyle(autosave.refused ? StateColor.red.text : Surface.meta)
                        .accessibilityIdentifier("note-autosave-status")
                }
                Spacer(minLength: 0)
                if !autosave.reloadLabel.isEmpty, !autosave.reloadSelectorID.isEmpty {
                    KitLink(
                        label: autosave.reloadLabel,
                        dense: true,
                        identifier: autosave.reloadSelectorID,
                        action: { onTap(autosave.reloadSelectorID) }
                    )
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
        }
    }

    private func suggestionStrip(_ suggest: Centraid_Core_V1_RoomNoteMentionSuggest) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(suggest.candidates, id: \.selectorID) { candidate in
                    Button { onTap(candidate.selectorID) } label: {
                        HStack(spacing: 6) {
                            Text(candidate.title)
                                .kitType(.meta)
                                .fontWeight(.semibold)
                                .foregroundStyle(Surface.ink)
                                .lineLimit(1)
                            if !candidate.noun.isEmpty {
                                Text(candidate.noun)
                                    .kitType(.badge)
                                    .kitHeld()
                                    .foregroundStyle(Surface.meta)
                                    .lineLimit(1)
                            }
                        }
                        .padding(.horizontal, 10)
                        .frame(minHeight: CentraidGeometry.targetMinFine)
                        .background(Surface.fill, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(candidate.selectorID)
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 6)
        }
        .background(Surface.card)
        .overlay(alignment: .top) { KitHairline() }
    }

    private var formattingBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                formatButton(action: .heading, iconKey: "Hash", label: "Heading")
                formatButton(action: .checklist, iconKey: "ListChecks", label: "Checklist")
                formatButton(action: .bullet, iconKey: "List", label: "List")
                formatTextButton(action: .bold, symbol: "B", label: "Bold", bold: true)
                formatTextButton(action: .italic, symbol: "I", label: "Italic", italic: true)
                formatButton(action: .code, iconKey: "Code", label: "Code")
                formatButton(action: .wikilink, iconKey: "Link", label: "Link")
                formatButton(action: .mention, iconKey: "User", label: "Mention")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
        }
        .background(Surface.card)
        .overlay(alignment: .top) { KitHairline() }
    }

    private func formatButton(
        action: NoteMarkdownFormat.Action,
        iconKey: String,
        label: String
    ) -> some View {
        Button { applyFormat(action) } label: {
            CentraidIconView(iconKey: iconKey, tint: Surface.ink, size: 17)
                .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier("note-format-\(action.rawValue)")
    }

    private func formatTextButton(
        action: NoteMarkdownFormat.Action,
        symbol: String,
        label: String,
        bold: Bool = false,
        italic: Bool = false
    ) -> some View {
        Button { applyFormat(action) } label: {
            Text(symbol)
                .kitType(.row)
                .fontWeight(bold ? .bold : .regular)
                .italic(italic)
                .foregroundStyle(Surface.ink)
                .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier("note-format-\(action.rawValue)")
    }

    private func applyFormat(_ action: NoteMarkdownFormat.Action) {
        guard !editor.readOnly else { return }
        localBody = NoteMarkdownFormat.apply(action, to: localBody)
        focusedField = .body
    }

    private func adoptRemoteIfNeeded() {
        guard sync.shouldAdopt(
            remoteTitle: editor.title,
            remoteBody: editor.body,
            remoteRev: editor.rev,
            localTitle: localTitle,
            localBody: localBody
        ) else { return }
        lastEmittedTitle = editor.title
        lastEmittedBody = editor.body
        localTitle = editor.title
        localBody = editor.body
    }

    private func emitEditIfNeeded() {
        guard !editor.readOnly else { return }
        guard localTitle != lastEmittedTitle || localBody != lastEmittedBody else { return }
        lastEmittedTitle = localTitle
        lastEmittedBody = localBody
        let seq = sync.nextSeq()
        guard !editor.selectorID.isEmpty else { return }
        var edited = Centraid_Core_V1_RoomNoteEdited()
        edited.title = localTitle
        edited.body = localBody
        edited.seq = seq
        edited.baseRevisionID = editor.baseRevisionID
        var event = Centraid_Core_V1_RoomCanvasEvent()
        event.selectorID = editor.selectorID
        event.kind = .noteEdit(edited)
        onCanvas(event)
    }

    private func emitTriggerIfNeeded(for text: String) {
        guard !editor.readOnly, !editor.selectorID.isEmpty else { return }
        let next = NoteTriggerDetector.detect(in: text)
        guard next != lastTrigger else { return }
        lastTrigger = next
        var triggered = Centraid_Core_V1_RoomNoteTriggered()
        triggered.trigger = next?.trigger ?? ""
        triggered.query = next?.query ?? ""
        var event = Centraid_Core_V1_RoomCanvasEvent()
        event.selectorID = editor.selectorID
        event.kind = .noteTrigger(triggered)
        onCanvas(event)
    }
}
