import SwiftUI

// DOCS' PIECES, SHARED BY THE DRIVE AND THE DOCUMENT PAGE (#1046). The sheet
// (one oneof: actions, choices, labels, new folder), the document row and the
// inline rename. Every word and every enabled flag is the state's.

/// What a Docs sheet's rows do, as closures — the drive and the document page
/// forward them as their own events.
struct DocsSheetActions {
    var onAction: (Centraid_Screen_V1_DocsAction) -> Void = { _ in }
    var onChoice: (String) -> Void = { _ in }
    var onLabelAdd: (String) -> Void = { _ in }
    var onLabelRemove: (String) -> Void = { _ in }
    var onLabelDraft: (String) -> Void = { _ in }
    var onFolderName: (String) -> Void = { _ in }
    var onFolderCreate: () -> Void = {}
}

/// THE DOCS SHEET: the state's `DocsSheet`, whichever body it carries.
struct DocsSheetView: View {
    let sheet: Centraid_Screen_V1_DocsSheet
    let actions: DocsSheetActions

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        switch sheet.body {
        case let .actions(list)?:
            OptionSheet(title: sheet.title, status: list.footer) {
                ForEach(list.actions, id: \.key) { action in
                    VStack(alignment: .leading, spacing: 0) {
                        SheetRow(
                            iconKey: action.iconKey,
                            label: action.label,
                            destructive: action.destructive,
                            identifier: "docs-action-\(action.key)",
                            onTap: { actions.onAction(action) }
                        )
                        .disabled(!action.enabled)
                        .opacity(action.enabled ? 1 : 0.5)
                        if !action.detail.isEmpty {
                            Text(action.detail)
                                .centraidType("annotLabel")
                                .foregroundStyle(Theme.color("textFaint", scheme))
                                .padding(.leading, action.iconKey.isEmpty ? 0 : 36)
                                .padding(.bottom, 6)
                        }
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("docs-sheet-\(sheet.kind.rawValue)")
        case let .choices(list)?:
            OptionSheet(title: sheet.title) {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(list.choices, id: \.key) { choice in
                            SheetRow(
                                label: choice.detail.isEmpty ? choice.label : "\(choice.label) · \(choice.detail)",
                                selected: choice.selected,
                                identifier: "docs-choice-\(choice.key)",
                                onTap: { actions.onChoice(choice.key) }
                            )
                        }
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("docs-sheet-\(sheet.kind.rawValue)")
        case let .labels(labels)?:
            DocsLabelsSheetView(title: sheet.title, labels: labels, actions: actions)
        case let .newFolder(folder)?:
            DocsNewFolderSheetView(title: sheet.title, folder: folder, actions: actions)
        case nil:
            EmptyView()
        }
    }
}

private struct DocsLabelsSheetView: View {
    let title: String
    let labels: Centraid_Screen_V1_DocsLabelsSheet
    let actions: DocsSheetActions

    @State private var draft = ""
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        SheetRoom(title: title) {
            if !labels.current.isEmpty {
                FlowChips(items: labels.current.map { ($0.tagID, $0.label) }) { tagID in
                    actions.onLabelRemove(tagID)
                } spoken: { label in "\(labels.removeLabel) \(label)" }
            }
            HStack(spacing: 8) {
                TextField(labels.placeholder, text: $draft)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
                    .submitLabel(.done)
                    .onSubmit { if labels.canAdd { actions.onLabelAdd(draft) } }
                    .accessibilityLabel(labels.placeholder)
                    .accessibilityIdentifier("docs-label-draft")
                KitOutlineButton(label: labels.addLabel) { actions.onLabelAdd(draft) }
                    .disabled(!labels.canAdd)
                    .accessibilityIdentifier("docs-label-add")
            }
            ForEach(labels.available, id: \.self) { label in
                SheetRow(iconKey: "Tag", label: label, identifier: "docs-label-\(label)") {
                    actions.onLabelAdd(label)
                }
            }
        }
        .onAppear { draft = labels.draft }
        .onChange(of: draft) { _, text in if text != labels.draft { actions.onLabelDraft(text) } }
        .onChange(of: labels.draft) { _, text in if text != draft { draft = text } }
        .accessibilityIdentifier("docs-sheet-labels")
    }
}

private struct DocsNewFolderSheetView: View {
    let title: String
    let folder: Centraid_Screen_V1_DocsNewFolderSheet
    let actions: DocsSheetActions

    @State private var name = ""
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        SheetRoom(
            title: title,
            status: folder.whereLabel,
            primary: SheetPrimary(label: folder.createLabel) { if folder.canCreate { actions.onFolderCreate() } }
        ) {
            TextField(folder.placeholder, text: $name)
                .centraidType("body")
                .foregroundStyle(Theme.color("text", scheme))
                .padding(.vertical, 8)
                .overlay(alignment: .bottom) { KitHairline() }
                .accessibilityLabel(folder.placeholder)
                .accessibilityIdentifier("docs-folder-name")
        }
        .onAppear { name = folder.name }
        .onChange(of: name) { _, text in if text != folder.name { actions.onFolderName(text) } }
        .accessibilityIdentifier("docs-sheet-new-folder")
    }
}

/// Chips that wrap, each a tap target with a spoken verb.
struct FlowChips: View {
    let items: [(id: String, label: String)]
    let onTap: (String) -> Void
    let spoken: (String) -> String

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(items, id: \.id) { item in
                    Button {
                        onTap(item.id)
                    } label: {
                        HStack(spacing: 4) {
                            Text(item.label)
                                .centraidType("annotLabelOn")
                                .foregroundStyle(Theme.color("text", scheme))
                            CentraidIconView(iconKey: "X", tint: Theme.color("textSoft", scheme), size: 10)
                                .accessibilityHidden(true)
                        }
                        .padding(.horizontal, 10)
                        .frame(minHeight: CentraidGeometry.targetMinFine)
                        .overlay(Capsule().strokeBorder(Theme.color("line", scheme), lineWidth: CentraidGeometry.hairline))
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(spoken(item.label))
                }
            }
        }
    }
}

/// THE DOCUMENT ROW: kind mark, title (or a search hit's snippet under it),
/// meta, labels, star, and the row menu.
struct DocsRowItem: View {
    let row: Centraid_Screen_V1_DocsRowView
    let starredLabel: String
    let menuLabel: String
    let onTap: () -> Void
    let onMenu: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 4) {
            Button(action: onTap) {
                HStack(alignment: .top, spacing: 12) {
                    CentraidIconView(iconKey: row.kindIconKey, tint: Theme.color("textSoft", scheme), size: 20)
                        .frame(width: 28, height: 28)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 4) {
                            Text(row.title)
                                .centraidType("body")
                                .foregroundStyle(Theme.color(row.trashed ? "textFaint" : "text", scheme))
                                .lineLimit(1)
                            if row.starred {
                                CentraidIconView(iconKey: "Star", tint: Theme.color("textSoft", scheme), size: 12)
                                    .accessibilityHidden(true)
                            }
                        }
                        if !row.snippet.isEmpty {
                            DocsSnippet(runs: row.snippet)
                        }
                        if !row.meta.isEmpty {
                            Text(row.meta)
                                .centraidType("annotLabel")
                                .foregroundStyle(Theme.color("textFaint", scheme))
                                .lineLimit(1)
                        }
                        if !row.labels.isEmpty {
                            Text(row.labels.map(\.label).joined(separator: " · "))
                                .centraidType("annotLabel")
                                .foregroundStyle(Theme.color("textSoft", scheme))
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.leading, CentraidGeometry.pageMargin)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(KitRowPress())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(row.accessibilityLabel.isEmpty ? row.title : row.accessibilityLabel)
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("docs-row-\(row.documentID)")
            Button(action: onMenu) {
                CentraidIconView(iconKey: "MoreHoriz", tint: Theme.color("textSoft", scheme), size: 18)
                    .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(menuLabel), \(row.title)")
            .accessibilityIdentifier("docs-row-menu-\(row.documentID)")
            .padding(.trailing, 8)
        }
        .frame(minHeight: CentraidGeometry.targetMinCoarse)
        .overlay(alignment: .bottom) { KitHairline() }
    }
}

/// A search hit's snippet, with the matched runs in strong ink.
struct DocsSnippet: View {
    let runs: [Centraid_Screen_V1_DocsSnippetRun]

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        runs.reduce(Text("")) { text, run in
            text + Text(run.text)
                .foregroundColor(Theme.color(run.match ? "text" : "textSoft", scheme))
                .fontWeight(run.match ? .semibold : .regular)
        }
        .centraidType("annotLabel")
        .lineLimit(2)
    }
}

/// THE INLINE RENAME: the title typed in place, its autosave line, Done.
struct DocsRenameField: View {
    let rename: Centraid_Screen_V1_DocsRename
    let placeholder: String
    let doneLabel: String
    let onEdit: (String) -> Void
    let onClose: () -> Void

    @State private var typed = ""
    @FocusState private var focused: Bool
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                TextField(placeholder, text: $typed)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit(onClose)
                    .accessibilityLabel(placeholder)
                    .accessibilityIdentifier("docs-rename-field")
                Button(action: onClose) {
                    Text(doneLabel)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                        .frame(minHeight: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("docs-rename-done")
            }
            if !rename.statusLabel.isEmpty {
                Text(rename.statusLabel)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color(rename.autosave.phase == .refused ? "net" : "textFaint", scheme))
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 6)
        .overlay(alignment: .bottom) { KitHairline() }
        .onAppear {
            typed = rename.title
            focused = true
        }
        .onChange(of: typed) { _, text in if text != rename.title { onEdit(text) } }
    }
}

/// A write refused, said where the member is looking.
struct DocsWriteLine: View {
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
            .accessibilityIdentifier("docs-write-refused")
        }
    }
}
