import SwiftUI

struct RoomHostView: View {
    @ObservedObject var store: RoomStore

    var body: some View {
        NavigationStack {
            Group {
                if let shown = store.topRoom {
                    RoomView(shown: shown, store: store)
                } else {
                    BarePaper()
                }
            }
        }
        .sheet(
            isPresented: Binding(
                get: { store.sheet != nil },
                set: { presented in if !presented { store.dismissSheet() } }
            )
        ) {
            if let shown = store.sheet {
                RoomView(shown: shown, store: store)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                    .sheetPageGround()
                    .kitRootTint()
            }
        }
        .fullScreenCover(
            isPresented: Binding(
                get: { store.stage != nil },
                set: { presented in if !presented { store.dismissStage() } }
            )
        ) {
            if let shown = store.stage {
                RoomView(shown: shown, store: store)
            }
        }
        .task {
            await store.start()
        }
    }
}

struct RoomView: View {
    let shown: Centraid_Core_V1_RoomShown
    @ObservedObject var store: RoomStore

    @Environment(\.colorScheme) private var scheme
    @Environment(\.appAccent) private var accent
    @State private var restoredAnchor = ""
    @State private var moreMenuPresented = false

    private var room: Centraid_Core_V1_Room { shown.room }

    private var callbacks: RoomCallbacks {
        RoomCallbacks(
            tap: { store.tap(instance: shown.instance, selectorID: $0) },
            change: { selector, seq, value in
                store.change(instance: shown.instance, selectorID: selector, seq: seq, value: value)
            },
            scrolled: { anchor, fraction in
                store.scrolled(instance: shown.instance, anchorSelectorID: anchor, anchorFractionMilli: fraction)
            },
            canvas: { event in
                store.sendCanvas(instance: shown.instance, event: event)
            }
        )
    }

    var body: some View {
        WordsShield(secure: room.secure) {
            roomScaffold
        }
        .privacySensitive(room.secure)
    }

    @ViewBuilder
    private var roomScaffold: some View {
        switch room.kind {
        case .stage:
            stageRoom
        case .sheet:
            sheetRoom
        case .editor:
            editorRoom
        case .home:
            standardRoom(largeLeadingTitle: true, readable: false)
        case .appPlace:
            standardRoom(largeLeadingTitle: true, readable: true)
        case .pushedPage:
            standardRoom(largeLeadingTitle: false, readable: true)
        case .systemPlace, .unspecified, .UNRECOGNIZED:
            standardRoom(largeLeadingTitle: !room.header.hasBack, readable: true)
        }
    }

    private func standardRoom(largeLeadingTitle: Bool, readable: Bool) -> some View {
        VStack(spacing: 0) {
            if room.hasHeader, !room.header.subtitle.isEmpty {
                RoomSubtitleBar(header: room.header, onTap: callbacks.tap)
                    .readableColumn(readable, alignment: .leading)
            }
            if room.hasSearch, room.search.open {
                RoomSearchResultsHeader(search: room.search, onTap: callbacks.tap)
                    .readableColumn(readable, alignment: .leading)
            }
            roomBodyContent(readable: readable)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Surface.page.ignoresSafeArea())
        .navigationTitle(room.header.title)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            roomToolbar(largeLeadingTitle: largeLeadingTitle)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            roomBottomChrome
                .readableColumn()
        }
        .sheet(isPresented: $moreMenuPresented) {
            if room.hasBand, room.band.hasMore {
                OptionSheet(title: KitWords.BAND_MORE) {
                    RoomMenuBlock(menu: room.band.more) { selector in
                        moreMenuPresented = false
                        callbacks.tap(selector)
                    }
                }
            }
        }
    }

    private var editorRoom: some View {
        VStack(spacing: 0) {
            roomBodyContent(readable: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Surface.page.ignoresSafeArea())
        .navigationTitle(room.header.title)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(true)
        .toolbar {
            roomToolbar(largeLeadingTitle: false)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if room.hasStatusLine, !room.statusLine.sentence.isEmpty {
                RoomStatusLineView(status: room.statusLine, onTap: callbacks.tap)
                    .readableColumn()
            }
        }
    }

    private var sheetRoom: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                if room.hasHeader, !room.header.title.isEmpty {
                    Text(room.header.title)
                        .kitType(.section)
                        .foregroundStyle(Surface.ink)
                        .accessibilityAddTraits(.isHeader)
                }
                Spacer(minLength: 0)
                if room.hasHeader, room.header.hasBack {
                    KitIconKey(
                        iconKey: "X",
                        label: room.header.back.label.isEmpty ? KitWords.DISMISS : room.header.back.label,
                        identifier: room.header.back.selectorID,
                        action: { callbacks.tap(room.header.back.selectorID) }
                    )
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 18)
            .padding(.bottom, 8)

            roomBodyContent(readable: false)

            if room.hasStatusLine, !room.statusLine.sentence.isEmpty {
                RoomStatusLineView(status: room.statusLine, onTap: callbacks.tap)
                    .padding(.bottom, 12)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var stageRoom: some View {
        ZStack(alignment: .topTrailing) {
            Theme.color("stage", scheme).ignoresSafeArea()
            roomBodyContent(readable: false)
                .environment(\.colorScheme, .dark)
            Button {
                if room.header.hasBack, !room.header.back.selectorID.isEmpty {
                    callbacks.tap(room.header.back.selectorID)
                } else {
                    store.dismissStage()
                }
            } label: {
                CentraidIconView(iconKey: "X", tint: Theme.color("onStage", scheme), size: 18)
                    .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                    .background(Color.black.opacity(0.45), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(KitWords.DISMISS)
            .padding(16)
        }
        .gesture(
            DragGesture(minimumDistance: 36)
                .onEnded { drag in
                    if drag.translation.height > 80 {
                        if room.header.hasBack, !room.header.back.selectorID.isEmpty {
                            callbacks.tap(room.header.back.selectorID)
                        } else {
                            store.dismissStage()
                        }
                    }
                }
        )
    }

    @ToolbarContentBuilder
    private func roomToolbar(largeLeadingTitle: Bool) -> some ToolbarContent {
        if room.hasHeader, room.header.hasBack {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    callbacks.tap(room.header.back.selectorID)
                } label: {
                    HStack(spacing: 4) {
                        CentraidIconView(iconKey: "ChevronLeft", tint: Surface.ink, size: 16)
                        Text(room.header.back.label.isEmpty ? KitWords.BACK : room.header.back.label)
                            .kitType(.row)
                            .foregroundStyle(Surface.ink)
                            .lineLimit(1)
                    }
                }
                .accessibilityLabel(KitWords.backTo(parent: room.header.back.label))
                .accessibilityIdentifier(room.header.back.selectorID)
            }
        } else if largeLeadingTitle, room.hasHeader, !room.header.title.isEmpty {
            RootBarTitle(title: room.header.title)
        }

        if largeLeadingTitle, !room.header.hasBack {
            ToolbarItem(placement: .principal) {
                Color.clear.frame(width: 1, height: 1).accessibilityHidden(true)
            }
        }

        ToolbarItemGroup(placement: .primaryAction) {
            if room.hasHeader, room.header.hasFilter {
                RoomFilterButton(filter: room.header.filter, onTap: callbacks.tap)
            }
            if room.hasHeader {
                ForEach(room.header.keys, id: \.selectorID) { key in
                    RoomHeaderKeyView(key: key, accent: accent, onTap: callbacks.tap)
                }
            }
        }
    }

    @ViewBuilder
    private func roomBodyContent(readable: Bool) -> some View {
        switch room.state {
        case .loading?:
            RowSkeleton()
                .readableColumn(readable)
        case .failed(let failed)?:
            FailureView(
                sentence: failed.sentence,
                remedy: "",
                retryLabel: failed.retryLabel.isEmpty ? KitWords.RETRY : failed.retryLabel,
                onRetry: failed.retrySelectorID.isEmpty ? nil : { callbacks.tap(failed.retrySelectorID) }
            )
            .readableColumn(readable)
        case .ready(let ready)?:
            RoomReadyContent(
                blocks: ready.blocks,
                restore: room.hasRestore ? room.restore : nil,
                restoredAnchor: $restoredAnchor,
                readable: readable,
                callbacks: callbacks
            )
        case nil:
            BarePaper()
        }
    }

    @ViewBuilder
    private var roomBottomChrome: some View {
        VStack(spacing: 0) {
            if room.hasStatusLine, !room.statusLine.sentence.isEmpty {
                RoomStatusLineView(status: room.statusLine, onTap: callbacks.tap)
            }
            if room.hasSelection, room.selection.on {
                RoomSelectionBar(selection: room.selection, onTap: callbacks.tap)
            } else if room.hasSearch, room.search.open {
                RoomSearchBar(search: room.search, callbacks: callbacks)
            } else if room.hasBand {
                RoomBandBar(
                    band: room.band,
                    onTap: callbacks.tap,
                    onOpenMore: {
                        if !room.band.moreSelectorID.isEmpty {
                            callbacks.tap(room.band.moreSelectorID)
                        } else if room.band.hasMore {
                            moreMenuPresented = true
                        }
                    }
                )
            }
        }
        .bandStrip()
    }
}

private struct RoomReadyContent: View {
    let blocks: [Centraid_Core_V1_RoomBlock]
    let restore: Centraid_Core_V1_RoomPlace?
    @Binding var restoredAnchor: String
    let readable: Bool
    let callbacks: RoomCallbacks

    private var canvasIndex: Int? {
        blocks.firstIndex { block in
            switch block.kind {
            case .calendarGrid?, .photoGrid?, .noteEditor?, .chart?:
                return true
            default:
                return false
            }
        }
    }

    var body: some View {
        if let idx = canvasIndex {
            VStack(spacing: 0) {
                ForEach(0..<idx, id: \.self) { i in
                    RoomBlockView(block: blocks[i], callbacks: callbacks)
                        .readableColumn(readable)
                }
                RoomBlockView(block: blocks[idx], callbacks: callbacks)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                if idx + 1 < blocks.count {
                    ForEach((idx + 1)..<blocks.count, id: \.self) { i in
                        RoomBlockView(block: blocks[i], callbacks: callbacks)
                            .readableColumn(readable)
                    }
                }
            }
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                            let anchor = blockAnchor(block)
                            RoomBlockView(block: block, callbacks: callbacks)
                                .id(anchor)
                        }
                    }
                    .readableColumn(readable)
                    .padding(.bottom, 16)
                }
                .contentMargins(.bottom, 12, for: .scrollContent)
                .softBottomScrollEdge()
                .onAppear { applyRestore(using: proxy) }
                .onChange(of: restore?.anchorSelectorID ?? "") { _, _ in
                    applyRestore(using: proxy)
                }
            }
        }
    }

    private func applyRestore(using proxy: ScrollViewProxy) {
        guard let anchor = restore?.anchorSelectorID, !anchor.isEmpty, anchor != restoredAnchor else { return }
        restoredAnchor = anchor
        proxy.scrollTo(anchor, anchor: .top)
    }

    private func blockAnchor(_ block: Centraid_Core_V1_RoomBlock) -> String {
        switch block.kind {
        case .row(let row)?: return row.selectorID
        case .section(let section)?: return section.selectorID
        case .figure(let figure)?: return figure.selectorID
        case .glance(let glance)?: return glance.selectorID
        case .choice(let choice)?: return choice.selectorID
        case .media(let media)?: return media.selectorID
        case .menu(let menu)?: return menu.selectorID
        case .earlierVersions(let earlier)?: return earlier.selectorID
        case .origin(let origin)?: return origin.selectorID
        default: return ""
        }
    }
}

private struct RoomSubtitleBar: View {
    let header: Centraid_Core_V1_RoomHeader
    let onTap: (String) -> Void

    var body: some View {
        HStack(spacing: 6) {
            Text(header.subtitle)
                .kitType(.meta)
                .foregroundStyle(Surface.meta)
                .lineLimit(1)
            if !header.subtitleClearSelectorID.isEmpty {
                Button { onTap(header.subtitleClearSelectorID) } label: {
                    CentraidIconView(iconKey: "X", tint: Surface.meta, size: 12)
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(KitWords.DISMISS)
                .accessibilityIdentifier(header.subtitleClearSelectorID)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.bottom, 6)
    }
}

private struct RoomHeaderKeyView: View {
    let key: Centraid_Core_V1_RoomKey
    let accent: AppAccent
    let onTap: (String) -> Void

    var body: some View {
        switch key.role {
        case .add:
            KitAccentKey(
                iconKey: key.icon.isEmpty ? "Plus" : key.icon,
                label: key.label,
                identifier: key.selectorID,
                enabled: key.enabled,
                accent: accent,
                action: { onTap(key.selectorID) }
            )
        case .menu:
            if key.hasMenu, !key.menu.sections.isEmpty {
                Menu {
                    RoomMenuContent(menu: key.menu, onTap: onTap)
                } label: {
                    ToolbarIconFace(iconKey: key.icon.isEmpty ? "MoreHoriz" : key.icon)
                }
                .disabled(!key.enabled)
                .accessibilityLabel(key.label)
                .accessibilityIdentifier(key.selectorID)
                .headerKeyTarget()
            } else {
                ToolbarIcon(
                    iconKey: key.icon.isEmpty ? "MoreHoriz" : key.icon,
                    label: key.label,
                    identifier: key.selectorID,
                    action: { onTap(key.selectorID) }
                )
                .disabled(!key.enabled)
            }
        case .verb:
            ToolbarVerb(label: key.label, identifier: key.selectorID) {
                onTap(key.selectorID)
            }
            .disabled(!key.enabled)
        case .tool, .unspecified, .UNRECOGNIZED:
            ToolbarIcon(
                iconKey: key.icon,
                label: key.label,
                identifier: key.selectorID,
                action: { onTap(key.selectorID) }
            )
            .disabled(!key.enabled)
        }
    }
}

private struct RoomFilterButton: View {
    let filter: Centraid_Core_V1_RoomFilterMenu
    let onTap: (String) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Menu {
            if filter.filtering, !filter.clearSelectorID_p.isEmpty {
                Section {
                    Button(KitWords.DISMISS) { onTap(filter.clearSelectorID_p) }
                        .accessibilityIdentifier(filter.clearSelectorID_p)
                }
            }
            if filter.hasMenu {
                RoomMenuContent(menu: filter.menu, onTap: onTap)
            }
        } label: {
            CentraidIconView(
                iconKey: "Filter",
                tint: Theme.color("text", scheme),
                size: 18,
                solid: filter.filtering
            )
        }
        .accessibilityIdentifier(filter.hasMenu ? filter.menu.selectorID : "room-filter-menu")
        .headerKeyTarget()
    }
}

private struct RoomStatusLineView: View {
    let status: Centraid_Core_V1_RoomStatusLine
    let onTap: (String) -> Void

    var body: some View {
        var kitStatus = Centraid_Core_V1_StatusLine()
        kitStatus.sentence = status.sentence
        kitStatus.actionLabel = status.actionLabel
        kitStatus.refused = status.refused
        return StatusLineView(
            status: kitStatus,
            identifier: status.actionSelectorID.isEmpty ? "status-action" : status.actionSelectorID,
            onAct: status.actionSelectorID.isEmpty ? nil : { onTap(status.actionSelectorID) }
        )
    }
}

private struct RoomSearchResultsHeader: View {
    let search: Centraid_Core_V1_RoomSearch
    let onTap: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !search.corrected.isEmpty {
                Text(search.corrected)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .accessibilityIdentifier("search-corrected")
            }
            ForEach(Array(search.containers.enumerated()), id: \.offset) { _, row in
                RoomRowBlock(row: row, onTap: onTap)
            }
            if search.hasAsk, !search.ask.title.isEmpty {
                RoomRowBlock(row: search.ask, onTap: onTap)
            }
        }
    }
}

private struct RoomSearchBar: View {
    let search: Centraid_Core_V1_RoomSearch
    let callbacks: RoomCallbacks

    @State private var typed = ""
    @State private var seq: UInt64 = 0
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 8) {
                CentraidIconView(iconKey: "Search", tint: Surface.meta, size: BandMetrics.searchGlyph)
                    .accessibilityHidden(true)
                TextField(search.placeholder.isEmpty ? KitWords.SEARCH : search.placeholder, text: $typed)
                    .focused($focused)
                    .kitType(.row)
                    .foregroundStyle(Surface.ink)
                    .submitLabel(.search)
                    .accessibilityIdentifier(search.selectorID)
            }
            .padding(.horizontal, 12)
            .frame(height: BandMetrics.searchHeight)
            .bandGround(Capsule(), solid: "bgElev")

            if !search.closeSelectorID.isEmpty {
                BandKey(
                    iconKey: "X",
                    spoken: KitWords.CLOSE_SEARCH,
                    identifier: search.closeSelectorID,
                    action: { callbacks.tap(search.closeSelectorID) }
                )
            }
        }
        .padding(.horizontal, BandMetrics.inset)
        .padding(.top, BandMetrics.topGap)
        .padding(.bottom, BandMetrics.floorPadding)
        .onAppear {
            typed = search.term
            focused = true
        }
        .onChange(of: typed) { _, next in
            seq &+= 1
            callbacks.change(search.selectorID, seq, .text(next))
        }
        .onChange(of: search.term) { _, remote in
            if remote != typed { typed = remote }
        }
    }
}

private struct RoomSelectionBar: View {
    let selection: Centraid_Core_V1_RoomSelection
    let onTap: (String) -> Void

    var body: some View {
        VStack(spacing: 8) {
            HStack {
                if !selection.selectAllSelectorID.isEmpty {
                    KitLink(label: KitWords.SELECT, dense: true, identifier: selection.selectAllSelectorID) {
                        onTap(selection.selectAllSelectorID)
                    }
                }
                Spacer(minLength: 8)
                Text(selection.label)
                    .kitType(.meta)
                    .fontWeight(.semibold)
                    .foregroundStyle(Surface.ink)
                Spacer(minLength: 8)
                if !selection.doneSelectorID.isEmpty {
                    KitLink(label: KitWords.DONE, dense: true, identifier: selection.doneSelectorID) {
                        onTap(selection.doneSelectorID)
                    }
                }
            }
            if !selection.actions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(selection.actions, id: \.selectorID) { action in
                            KitOutlineButton(
                                label: action.label,
                                tone: action.destructive ? "net" : "text",
                                iconKey: action.icon,
                                action: { onTap(action.selectorID) }
                            )
                            .disabled(!action.enabled)
                            .accessibilityIdentifier(action.selectorID)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 10)
        .bandGround(RoundedRectangle(cornerRadius: 18, style: .continuous), solid: "bgElev")
        .padding(.horizontal, BandMetrics.inset)
        .padding(.bottom, BandMetrics.floorPadding)
    }
}

private struct RoomBandBar: View {
    let band: Centraid_Core_V1_RoomBand
    let onTap: (String) -> Void
    let onOpenMore: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        BandGlassGroup(spacing: BandMetrics.groupSpacing) {
            HStack(spacing: BandMetrics.plateGap) {
                if !band.homeSelectorID.isEmpty {
                    BandKey(
                        iconKey: "Home",
                        spoken: KitWords.BAND_HOME,
                        identifier: band.homeSelectorID,
                        action: { onTap(band.homeSelectorID) }
                    )
                }
                if !band.tabs.isEmpty || band.hasMore || !band.moreSelectorID.isEmpty {
                    HStack(spacing: BandMetrics.groupGutter) {
                        ForEach(band.tabs, id: \.selectorID) { tab in
                            roomTabButton(
                                iconKey: tab.icon,
                                label: tab.label,
                                selected: tab.selected,
                                identifier: tab.selectorID,
                                action: { onTap(tab.selectorID) }
                            )
                        }
                        if band.hasMore || !band.moreSelectorID.isEmpty {
                            roomTabButton(
                                iconKey: "MoreHoriz",
                                label: KitWords.BAND_MORE,
                                selected: band.moreSelected,
                                identifier: band.moreSelectorID.isEmpty ? "band-more" : band.moreSelectorID,
                                action: onOpenMore
                            )
                        }
                    }
                    .padding(BandMetrics.platePad)
                    .frame(maxWidth: .infinity)
                    .bandGround(Capsule(), solid: "bgElev")
                }
                if !band.searchSelectorID.isEmpty {
                    BandKey(
                        iconKey: "Search",
                        spoken: KitWords.SEARCH,
                        identifier: band.searchSelectorID,
                        action: { onTap(band.searchSelectorID) }
                    )
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, BandMetrics.inset)
        .padding(.top, BandMetrics.topGap)
        .padding(.bottom, BandMetrics.floorPadding)
    }

    private func roomTabButton(
        iconKey: String,
        label: String,
        selected: Bool,
        identifier: String,
        action: @escaping () -> Void
    ) -> some View {
        let ink = selected ? Surface.ink : Surface.meta
        return Button(action: action) {
            VStack(spacing: BandMetrics.labelGap) {
                CentraidIconView(
                    iconKey: iconKey,
                    tint: ink,
                    size: BandMetrics.iconSize,
                    strokeWidth: CentraidGeometry.appMarkStroke
                )
                .frame(width: BandMetrics.markSize, height: BandMetrics.markSize)
                Text(label)
                    .centraidType(selected ? "control" : "band", scales: false)
                    .foregroundStyle(ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .padding(.top, BandMetrics.tabTop)
            .padding(.bottom, BandMetrics.tabBottom)
            .frame(maxWidth: .infinity, minHeight: BandMetrics.tabMinHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
        .accessibilityLabel(label + (selected ? ", " + KitWords.BAND_CURRENT : ""))
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : [.isButton])
    }
}
