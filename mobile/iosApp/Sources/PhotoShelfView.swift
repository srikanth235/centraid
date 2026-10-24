import SwiftUI

import CentraidShared

/// A PHOTO SHELF, drawn from the core's `PhotosShelfState` (#1135): favourites,
/// videos, the archive, the trash, an album, a place, the photographs with no
/// place. `crates/screens/src/photos/shelf.rs` decides everything a member reads
/// and does here (the head, the count, this shelf's empty sentence, the bar's
/// verbs and their confirms, the sheets); this draws it and sends events. The
/// only state kept here is the typed album name in the rename sheet.
///
/// A cell carries the `Route` to the lightbox, so a tap opens it through `open`
/// and no shelf names a destination. `dismissed` (the album is gone) pops.
///
/// The Compose twin is `androidApp/.../screens/PhotoShelfScreen.kt`.
struct PhotoShelfView: View {
    @Environment(\.colorScheme) private var scheme

    let state: Centraid_Core_V1_PhotosShelfState
    let send: (Centraid_Core_V1_PhotosShelfEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onBack: () -> Void

    @State private var draftName = ""

    private var selection: Centraid_Core_V1_PhotosSelection { state.selection }
    private var selecting: Bool { selection.selecting }

    private var cells: [Centraid_Core_V1_PhotosShelfCell] {
        if case let .data(data)? = state.content { return data.cells }
        return []
    }

    private func shelf(_ build: (inout Centraid_Core_V1_PhotosShelfEvent) -> Void) {
        var event = Centraid_Core_V1_PhotosShelfEvent()
        build(&event)
        send(event)
    }

    private func select(_ build: (inout Centraid_Core_V1_PhotosSelectionEvent) -> Void) {
        var event = Centraid_Core_V1_PhotosSelectionEvent()
        build(&event)
        shelf { $0.selection = event }
    }

    private func prompt(_ prompt: Centraid_Core_V1_PhotosShelfState.Prompt) {
        shelf { $0.promptOpened = .with { $0.prompt = prompt } }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                header

                if state.hasAlbum, state.album.trashed {
                    // A TRASHED ALBUM OFFERS ITS WAY BACK, and none of the verbs
                    // of a live one.
                    HStack {
                        Text(state.album.trashedNote)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                        Spacer()
                        KitOutlineButton(label: state.album.restoreLabel, tone: "text") {
                            shelf { $0.albumRestored = .init() }
                        }
                        .accessibilityIdentifier("photos.shelf.restoreAlbum")
                    }
                }

                if state.hasKeepOriginals {
                    Toggle(isOn: Binding(
                        get: { state.keepOriginals.keep },
                        set: { value in shelf { $0.keepToggled = .with { $0.keep = value } } }
                    )) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(state.keepOriginals.title)
                                .centraidType("body")
                                .foregroundStyle(Theme.color("text", scheme))
                            Text(state.keepOriginals.meta)
                                .centraidType("small")
                                .foregroundStyle(Theme.color("textSoft", scheme))
                        }
                    }
                    .kitToggle()
                    .disabled(!state.keepOriginals.ready)
                    .accessibilityLabel(state.keepOriginals.label)
                    .accessibilityHint(state.keepOriginals.meta)
                    .accessibilityIdentifier("photos.shelf.keepOriginals")
                }

                if !state.purgeWindow.isEmpty {
                    Text(state.purgeWindow)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }

                // A REFUSED WRITE, ABOVE THE CELLS AND NEVER INSTEAD OF THEM: it
                // lands in `status`, not in the read's `failure`, so the shelf
                // and the pick stay.
                if state.hasStatus {
                    ScreenFailureView(sentence: state.status.sentence, remedy: "")
                        .accessibilityIdentifier("photos.shelf.writeFailure")
                }

                if !state.notice.isEmpty {
                    Text(state.notice)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                        .accessibilityIdentifier("photos.shelf.exportNotice")
                }

                switch state.content {
                case .loading?, nil:
                    RowSkeleton()
                case let .failure(failure)?:
                    ScreenFailureView(sentence: failure.sentence, remedy: failure.remedy)
                case let .data(data)?:
                    if data.hasEmpty {
                        ScreenEmptyView(sentence: data.empty.headline, remedy: data.empty.body)
                    } else {
                        PhotoCellsGrid(
                            cells: data.cells.map(\.tile),
                            selected: Set(selection.selectedIds),
                            onTap: { identifier in
                                if selecting {
                                    select { $0.toggled = .with { $0.photoID = identifier } }
                                } else if let cell = data.cells.first(where: { $0.tile.photoID == identifier }) {
                                    open(cell.open)
                                }
                            }
                        )
                        if data.canShowMore {
                            KitLink(label: data.showMoreLabel) { shelf { $0.loadMore = .init() } }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentMargins(.horizontal, CentraidGeometry.pageMargin, for: .scrollContent)
        .navigationTitle(state.title)
        .toolbar {
            if state.hasAlbum, !state.album.trashed {
                ToolbarItem(placement: .primaryAction) {
                    ToolbarIcon(
                        iconKey: "add",
                        label: state.album.addLabel,
                        identifier: "photos.shelf.add"
                    ) {
                        open(state.album.addRoute)
                    }
                }
                // THE ALBUM'S OWN VERBS, behind one control. Rename and Delete
                // are about the grouping, never about a photograph in it.
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button(state.album.renameLabel) {
                            draftName = state.album.name
                            prompt(.renameAlbum)
                        }
                        .accessibilityIdentifier("photos.shelf.rename")
                        Button(state.album.deleteLabel, role: .destructive) { prompt(.deleteAlbum) }
                            .accessibilityIdentifier("photos.shelf.deleteAlbum")
                    } label: {
                        ToolbarIconFace(iconKey: "MoreHoriz")
                    }
                    .accessibilityLabel(state.album.optionsLabel)
                    .accessibilityIdentifier("photos.shelf.albumMenu")
                }
            }
            if selecting {
                ToolbarItem(placement: .primaryAction) {
                    ToolbarVerb(label: state.chrome.doneLabel, identifier: "photos.shelf.done") {
                        select { $0.mode = .with { $0.selecting = false } }
                    }
                }
            } else if !cells.isEmpty {
                ToolbarItem(placement: .primaryAction) {
                    ToolbarVerb(label: state.chrome.selectLabel, identifier: "photos.shelf.select") {
                        select { $0.mode = .with { $0.selecting = true } }
                    }
                }
            }
        }
        // THE BAR IS THE MODE, and it is absent when there is no mode.
        .safeAreaInset(edge: .bottom) {
            if selecting { selectionBar }
        }
        // THE BATCH CONFIRM (trash, delete forever) is the selection's; this
        // one is the screen's (empty trash, delete album). Both are Rust's words.
        .sheet(isPresented: Binding(
            get: { selection.hasConfirm },
            set: { shown in if !shown, selection.hasConfirm { select { $0.dismissed = .init() } } }
        )) {
            ConfirmSheet(
                selection.confirm.legacy,
                cancelLabel: state.promptCancelLabel,
                onConfirm: { select { $0.confirmed = .init() } },
                onDismiss: { select { $0.dismissed = .init() } }
            )
        }
        .sheet(isPresented: Binding(
            get: { state.hasConfirm },
            set: { shown in if !shown, state.hasConfirm { shelf { $0.promptDismissed = .init() } } }
        )) {
            ConfirmSheet(
                state.confirm.legacy,
                cancelLabel: state.promptCancelLabel,
                onConfirm: { shelf { $0.promptConfirmed = .init() } },
                onDismiss: { shelf { $0.promptDismissed = .init() } }
            )
        }
        // HOW MUCH OF THE PLACE TRAVELS, asked every time (#816).
        .sheet(isPresented: Binding(
            get: { state.hasLocationChoice },
            set: { shown in if !shown, state.hasLocationChoice { shelf { $0.promptDismissed = .init() } } }
        )) {
            OptionSheet(title: state.locationChoice.title) {
                SheetRow(label: state.locationChoice.noneLabel) {
                    shelf { $0.locationChosen = .with { $0.exact = false } }
                }
                SheetRow(label: state.locationChoice.exactLabel) {
                    shelf { $0.locationChosen = .with { $0.exact = true } }
                }
            }
            .presentationDetents([.height(220)])
        }
        .sheet(isPresented: Binding(
            get: { state.hasRename },
            set: { shown in if !shown, state.hasRename { shelf { $0.promptDismissed = .init() } } }
        )) {
            SheetRoom(
                title: state.rename.title,
                // AN EMPTY NAME IS NOT A WRITE: Save is greyed.
                primary: SheetPrimary(
                    label: state.rename.saveLabel,
                    enabled: !draftName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ) {
                    shelf { $0.albumRenamed = .with { $0.title = draftName } }
                }
            ) {
                TextField(state.rename.fieldLabel, text: $draftName)
                    .centraidType("body")
                    .padding(.horizontal, 12)
                    .frame(minHeight: CentraidGeometry.targetMinCoarse)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                            .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
                    )
                    .accessibilityIdentifier("photos.shelf.albumName")
            }
            .presentationDetents([.height(260)])
        }
        // "ADD TO ALBUM" — the shared sheet. `isPresented` is the state's, so a
        // swipe-down reaches Rust rather than leaving it saying "open".
        .sheet(isPresented: Binding(
            get: { state.albumChoice.open },
            set: { open in
                if !open, state.albumChoice.open {
                    shelf { $0.albumChoice = .with { $0.dismissed = .init() } }
                }
            }
        )) {
            PhotosAlbumChoiceSheet(choice: state.albumChoice) { event in shelf { $0.albumChoice = event } }
        }
        .onChange(of: state.dismissed) { _, gone in
            if gone { onBack() }
        }
    }

    /// The count, and the way into and out of selection.
    private var header: some View {
        HStack {
            Text(countLabel)
                .centraidType("control")
                .foregroundStyle(Theme.color("textSoft", scheme))
            Spacer()
            if selecting {
                Text(selection.title)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            } else if case let .data(data)? = state.content, data.hasEmptyTrashLabel {
                // EMPTY TRASH, only on the trash. An outline in `net` and never
                // a filled one: the safety is the confirm behind it.
                KitOutlineButton(label: data.emptyTrashLabel, tone: "net") { prompt(.emptyTrash) }
                    .accessibilityIdentifier("photos.shelf.emptyTrash")
            }
        }
    }

    private var countLabel: String {
        if case let .data(data)? = state.content { return data.countLabel }
        return ""
    }

    /// The icon key for a bar verb, one the catalog has.
    private func icon(_ kind: Centraid_Core_V1_PhotosBatchAction.Kind) -> String {
        switch kind {
        case .favorite, .unfavorite: return "heart"
        case .addToAlbum: return "album"
        case .archive: return "Archive"
        case .unarchive, .restore: return "restore"
        case .trash, .deleteForever: return "trash"
        default: return "MoreHoriz"
        }
    }

    /// THE BAR: the verbs Rust offered for this shelf, in its order, disabled
    /// with nothing picked rather than hidden. The album's Remove and a second
    /// Favorite/Unfavorite sit in the menu with the hand-off verbs.
    private var selectionBar: some View {
        let actions = selection.actions
        let offersFavorite = actions.contains { $0.kind == .favorite }
        let inMenu = { (action: Centraid_Core_V1_PhotosBatchAction) in
            action.kind == .removeFromAlbum || (offersFavorite && action.kind == .unfavorite)
        }
        let trash = actions.contains { $0.kind == .restore }
        return HStack(spacing: BandMetrics.groupGutter) {
            if !trash {
                verb(icon: "share", label: state.bar.sendCopyLabel, identifier: "photos.shelf.send", enabled: state.bar.enabled) {
                    prompt(.sendLocation)
                }
            }
            ForEach(actions.filter { !inMenu($0) }, id: \.kind) { action in
                verb(
                    icon: icon(action.kind),
                    label: action.label,
                    identifier: "photos.shelf.\(action.kind)",
                    enabled: action.enabled
                ) {
                    select { $0.action = .with { $0.kind = action.kind } }
                }
            }
            if !trash { moreMenu(actions.filter(inMenu)) }
        }
        // THE LIBRARY'S SELECTION BAR, IN THE SHELF'S PLACE: one elevated plate
        // on the pill rung with a hairline, a mark over a word per verb.
        .padding(BandMetrics.platePad)
        .frame(maxWidth: .infinity)
        .background(Theme.color("bgElev", scheme), in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline))
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, BandMetrics.inset)
        .padding(.top, BandMetrics.topGap)
        .padding(.bottom, BandMetrics.floorPadding)
        .background(Theme.color("bg", scheme).ignoresSafeArea(edges: .bottom))
        .accessibilityIdentifier("photos-selection-bar")
    }

    /// THE REST OF THE VERBS: download the originals, the menu's batch verbs and
    /// the album's "Make key photo" (exactly one pick).
    private func moreMenu(_ extra: [Centraid_Core_V1_PhotosBatchAction]) -> some View {
        Menu {
            Button(state.bar.downloadLabel) { shelf { $0.download = .init() } }
                .accessibilityIdentifier("photos.shelf.download")
            ForEach(extra, id: \.kind) { action in
                Button(action.label) { select { $0.action = .with { $0.kind = action.kind } } }
                    .disabled(!action.enabled)
            }
            if state.bar.makeKeyOffered {
                Button(state.bar.makeKeyLabel) { shelf { $0.coverChosen = .init() } }
                    .disabled(!state.bar.makeKeyEnabled)
                    .accessibilityIdentifier("photos.shelf.cover")
            }
        } label: {
            selectionFace(icon: "MoreHoriz", label: state.bar.moreLabel, enabled: state.bar.enabled)
        }
        .disabled(!state.bar.enabled)
        .accessibilityLabel(state.bar.moreLabel)
        .accessibilityIdentifier("photos.shelf.more")
    }

    private func verb(
        icon: String,
        label: String,
        identifier: String,
        enabled: Bool,
        run: @escaping () -> Void
    ) -> some View {
        Button(action: run) {
            selectionFace(icon: icon, label: label, enabled: enabled)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }

    /// A MARK OVER A WORD, in the band's metrics. DISABLED IS ITS OWN TOKEN ON
    /// THE LEAF, never an opacity on the tab.
    private func selectionFace(icon: String, label: String, enabled: Bool) -> some View {
        let ink = Theme.color(enabled ? "text" : "textDisabled", scheme)
        return VStack(spacing: BandMetrics.labelGap) {
            CentraidIconView(iconKey: icon, tint: ink, size: BandMetrics.iconSize)
                .frame(width: BandMetrics.markSize, height: BandMetrics.markSize)
            Text(label)
                .centraidType("band")
                .foregroundStyle(ink)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .padding(.top, BandMetrics.tabTop)
        .padding(.bottom, BandMetrics.tabBottom)
        .frame(maxWidth: .infinity, minHeight: BandMetrics.tabMinHeight)
        .contentShape(Rectangle())
    }
}
