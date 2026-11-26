import SwiftUI

struct RoomCallbacks {
    let tap: (String) -> Void
    let change: (String, UInt64, Centraid_Core_V1_RoomChange.OneOf_Value) -> Void
    let scrolled: (String, UInt32) -> Void
    let canvas: (Centraid_Core_V1_RoomCanvasEvent) -> Void
}

enum RoomToneStyle {
    static func color(_ tone: Centraid_Core_V1_RoomTone, scheme: ColorScheme, accent: AppAccent, neutral: Color = Surface.ink) -> Color {
        switch tone {
        case .seam: return Theme.color("seam", scheme)
        case .net: return StateColor.red.text
        case .warning: return StateColor.amber.text
        case .accent: return accent.text
        case .neutral, .unspecified, .UNRECOGNIZED: return neutral
        }
    }

    static func badgeState(_ tone: Centraid_Core_V1_RoomTone) -> StateColor? {
        switch tone {
        case .seam, .warning: return .amber
        case .net: return .red
        case .neutral, .accent, .unspecified, .UNRECOGNIZED: return nil
        }
    }
}

struct RoomBlockView: View {
    let block: Centraid_Core_V1_RoomBlock
    let callbacks: RoomCallbacks

    var body: some View {
        switch block.kind {
        case .hero(let hero)?:
            RoomHeroBlock(hero: hero, onTap: callbacks.tap)
        case .section(let section)?:
            RoomSectionBlock(section: section, callbacks: callbacks)
        case .row(let row)?:
            RoomRowBlock(row: row, onTap: callbacks.tap)
        case .facts(let facts)?:
            RoomFactsBlock(facts: facts, onTap: callbacks.tap)
        case .form(let form)?:
            RoomFormBlock(form: form, callbacks: callbacks)
        case .choice(let choice)?:
            RoomChoiceBlock(choice: choice, callbacks: callbacks)
        case .figure(let figure)?:
            RoomFigureBlock(figure: figure, onTap: callbacks.tap)
        case .prose(let prose)?:
            RoomProseBlock(prose: prose, onTap: callbacks.tap)
        case .media(let media)?:
            RoomMediaBlock(media: media, onTap: callbacks.tap)
        case .progress(let progress)?:
            RoomProgressBlock(progress: progress, onTap: callbacks.tap)
        case .empty(let empty)?:
            RoomEmptyBlock(empty: empty, onTap: callbacks.tap)
        case .wall(let wall)?:
            RoomWallBlock(wall: wall, onTap: callbacks.tap)
        case .tiles(let tiles)?:
            RoomTilesBlock(tiles: tiles, onTap: callbacks.tap)
        case .glance(let glance)?:
            RoomGlanceBlock(glance: glance, onTap: callbacks.tap)
        case .trash(let trash)?:
            RoomTrashBlock(trash: trash, onTap: callbacks.tap)
        case .confirm(let confirm)?:
            RoomConfirmBlock(confirm: confirm, onTap: callbacks.tap)
        case .menu(let menu)?:
            RoomMenuBlock(menu: menu, onTap: callbacks.tap)
        case .attachments(let attachments)?:
            RoomAttachmentsBlock(attachments: attachments, onTap: callbacks.tap)
        case .linked(let linked)?:
            RoomLinkedBlock(linked: linked, onTap: callbacks.tap)
        case .mentionedIn(let mentioned)?:
            RoomMentionedInBlock(mentioned: mentioned, onTap: callbacks.tap)
        case .says(let says)?:
            RoomSaysBlock(says: says, onTap: callbacks.tap)
        case .earlierVersions(let earlier)?:
            RoomEarlierVersionsBlock(earlier: earlier, onTap: callbacks.tap)
        case .origin(let origin)?:
            RoomOriginBlock(origin: origin, onTap: callbacks.tap)
        case .calendarGrid(let grid)?:
            CalendarGridCanvasView(grid: grid, onTap: callbacks.tap, onCanvas: callbacks.canvas)
        case .photoGrid(let grid)?:
            RoomCanvasPlaceholder(title: grid.sections.first?.heading ?? "", selectorID: grid.nextPageSelectorID)
        case .noteEditor(let editor)?:
            NoteEditorCanvasView(editor: editor, onTap: callbacks.tap, onCanvas: callbacks.canvas)
        case .chart(let chart)?:
            ChartCanvasView(chart: chart, onCanvas: callbacks.canvas)
        case nil:
            EmptyView()
        }
    }
}

struct RoomCanvasPlaceholder: View {
    let title: String
    let selectorID: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !title.isEmpty {
                Text(title)
                    .kitType(.row)
                    .foregroundStyle(Surface.meta)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 120, alignment: .center)
        .padding(CentraidGeometry.pageMargin)
        .kitCard()
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .modifier(OptionalIdentifier(identifier: selectorID))
    }
}

struct RoomChipView: View {
    let chip: Centraid_Core_V1_RoomChip
    let onTap: (String) -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.appAccent) private var accent

    var body: some View {
        HStack(spacing: 4) {
            if let state = RoomToneStyle.badgeState(chip.tone) {
                KitBadge(label: chip.label, state: state)
            } else if chip.tone == .accent {
                Text(chip.label)
                    .kitType(.badge)
                    .kitHeld()
                    .foregroundStyle(accent.text)
                    .lineLimit(1)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(accent.tint ?? accent.wash(dark: scheme == .dark), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            } else {
                Text(chip.label)
                    .kitType(.badge)
                    .kitHeld()
                    .foregroundStyle(Surface.meta)
                    .lineLimit(1)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(Surface.fill, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
            if !chip.removeSelectorID.isEmpty {
                Button { onTap(chip.removeSelectorID) } label: {
                    CentraidIconView(iconKey: "X", tint: Surface.meta, size: 10)
                        .frame(width: 20, height: 20)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier(chip.removeSelectorID)
            }
        }
    }
}

struct RoomMarkView: View {
    let mark: Centraid_Core_V1_RoomMark
    let onTap: (String) -> Void
    var size: CGFloat = 32

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        switch mark.kind {
        case .glyph(let glyph)?:
            let fill: Color? = KitHue.role(glyph.hueKey).map { Theme.color($0, scheme) }
            KitTile(iconKey: glyph.icon, size: size, fill: fill)
        case .thumb(let thumb)?:
            let fill: Color = KitHue.role(thumb.hueKey).map { Theme.color($0, scheme) } ?? Surface.fill
            RoundedRectangle(cornerRadius: size * CentraidGeometry.iconChipRadiusRatio, style: .continuous)
                .fill(fill)
                .frame(width: size, height: size)
                .overlay {
                    if !thumb.alt.isEmpty {
                        Text(String(thumb.alt.prefix(1)))
                            .kitType(.meta)
                            .foregroundStyle(Surface.ink)
                    }
                }
                .accessibilityLabel(thumb.alt)
        case .check(let check)?:
            KitCheckBox(
                state: checkState(check.state),
                label: "",
                identifier: check.selectorID,
                round: true,
                action: { onTap(check.selectorID) }
            )
        case nil:
            EmptyView()
        }
    }

    private func checkState(_ state: Centraid_Core_V1_RoomCheckState) -> KitCheckState {
        switch state {
        case .on: return .on
        case .mixed: return .mixed
        case .partial: return .partial
        case .off, .unspecified, .UNRECOGNIZED: return .off
        }
    }
}

struct RoomMenuContent: View {
    let menu: Centraid_Core_V1_RoomMenu
    let onTap: (String) -> Void

    var body: some View {
        ForEach(Array(menu.sections.enumerated()), id: \.offset) { _, section in
            if section.heading.isEmpty {
                Section {
                    items(section.items)
                }
            } else {
                Section(section.heading) {
                    items(section.items)
                }
            }
        }
    }

    @ViewBuilder
    private func items(_ list: [Centraid_Core_V1_RoomMenuItem]) -> some View {
        ForEach(list, id: \.selectorID) { item in
            if !item.submenu.isEmpty {
                Menu(item.label) {
                    ForEach(item.submenu, id: \.selectorID) { sub in
                        menuButton(sub)
                    }
                }
                .disabled(!item.enabled)
                .accessibilityIdentifier(item.selectorID)
            } else {
                menuButton(item)
            }
        }
    }

    @ViewBuilder
    private func menuButton(_ item: Centraid_Core_V1_RoomMenuItem) -> some View {
        if item.checked {
            Toggle(isOn: Binding(get: { item.checked }, set: { _ in onTap(item.selectorID) })) {
                Text(item.label)
            }
            .disabled(!item.enabled)
            .accessibilityIdentifier(item.selectorID)
        } else {
            Button(role: item.destructive ? .destructive : nil) {
                onTap(item.selectorID)
            } label: {
                Text(item.label)
            }
            .disabled(!item.enabled)
            .accessibilityIdentifier(item.selectorID)
        }
    }
}

// MARK: - Hero

struct RoomHeroBlock: View {
    let hero: Centraid_Core_V1_RoomHero
    let onTap: (String) -> Void

    var body: some View {
        VStack(spacing: 10) {
            if hero.hasMark {
                RoomMarkView(mark: hero.mark, onTap: onTap, size: 56)
            }
            if !hero.noun.isEmpty {
                Text(hero.noun)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
            }
            Text(hero.title)
                .kitType(.hero)
                .foregroundStyle(Surface.ink)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            ForEach(Array(hero.lines.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                    .multilineTextAlignment(.center)
            }
            if !hero.chips.isEmpty {
                HStack(spacing: 6) {
                    ForEach(Array(hero.chips.enumerated()), id: \.offset) { _, chip in
                        RoomChipView(chip: chip, onTap: onTap)
                    }
                }
            }
            HStack(spacing: 10) {
                if hero.hasPrimary, !hero.primary.label.isEmpty {
                    KitPillButton(label: hero.primary.label, iconKey: hero.primary.icon) {
                        onTap(hero.primary.selectorID)
                    }
                    .disabled(!hero.primary.enabled)
                    .accessibilityIdentifier(hero.primary.selectorID)
                }
                if hero.hasMenu, !hero.menu.sections.isEmpty {
                    Menu {
                        RoomMenuContent(menu: hero.menu, onTap: onTap)
                    } label: {
                        CentraidIconView(iconKey: "MoreHoriz", tint: Surface.ink, size: 18)
                            .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                            .background(Surface.fill, in: Circle())
                    }
                    .accessibilityIdentifier(hero.menu.selectorID)
                }
            }
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 16)
    }
}

// MARK: - Section

struct RoomSectionBlock: View {
    let section: Centraid_Core_V1_RoomSection
    let callbacks: RoomCallbacks

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !section.heading.isEmpty || !section.countLabel.isEmpty || section.hasTrailing {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if !section.heading.isEmpty {
                        Text(section.heading)
                            .kitType(.group)
                            .foregroundStyle(Surface.meta)
                            .accessibilityAddTraits(.isHeader)
                    }
                    if !section.countLabel.isEmpty {
                        Text(section.countLabel)
                            .kitType(.group)
                            .foregroundStyle(Surface.meta)
                    }
                    Spacer(minLength: 0)
                    if section.hasTrailing, !section.trailing.label.isEmpty {
                        KitLink(
                            label: section.trailing.label,
                            dense: true,
                            identifier: section.trailing.selectorID,
                            action: { callbacks.tap(section.trailing.selectorID) }
                        )
                        .disabled(!section.trailing.enabled)
                    }
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.top, 16)
                .padding(.bottom, 6)
            }
            VStack(spacing: 0) {
                ForEach(Array(section.blocks.enumerated()), id: \.offset) { _, block in
                    RoomBlockView(block: block, callbacks: callbacks)
                }
            }
            if !section.nextPageSelectorID.isEmpty {
                ShowMoreFooter(visible: true) {
                    callbacks.tap(section.nextPageSelectorID)
                }
                .onAppear { callbacks.tap(section.nextPageSelectorID) }
            }
        }
        .modifier(OptionalIdentifier(identifier: section.selectorID))
    }
}

// MARK: - Row

struct RoomRowBlock: View {
    let row: Centraid_Core_V1_RoomRow
    let onTap: (String) -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.appAccent) private var accent
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let content = Group {
            if !row.selectorID.isEmpty {
                Button { onTap(row.selectorID) } label: { rowBody }
                    .buttonStyle(KitRowPress())
            } else {
                rowBody
            }
        }
        .accessibilityElement(children: .combine)
        .modifier(RoomOptionalA11y(label: row.a11yLabel))
        .modifier(OptionalIdentifier(identifier: row.selectorID))
        .modifier(RoomContextMenuModifier(menu: row.hasMenu ? row.menu : nil, onTap: onTap))
        .modifier(RoomSwipeModifier(swipe: row.hasSwipe ? row.swipe : nil, onTap: onTap))

        content
    }

    private var rowBody: some View {
        let stacked = dynamicTypeSize.isAccessibilitySize
        let layout = stacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(spacing: 12))
        return layout {
            if row.hasMark {
                RoomMarkView(mark: row.mark, onTap: onTap, size: 32)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .kitType(.row)
                    .foregroundStyle(row.dimmed ? Surface.meta : Surface.ink)
                    .kitLineLimit(2, wide: 6)
                if !row.meta.isEmpty || row.pending {
                    let metaText = row.pending
                        ? (row.meta.isEmpty ? KitWords.PENDING : "\(row.meta) · \(KitWords.PENDING)")
                        : row.meta
                    Text(metaText)
                        .kitType(.meta)
                        .foregroundStyle(Surface.meta)
                        .kitLineLimit(2, wide: 6)
                }
            }
            if !stacked { Spacer(minLength: 8) }
            if !row.trailing.isEmpty || !row.chips.isEmpty {
                VStack(alignment: stacked ? .leading : .trailing, spacing: 4) {
                    if !row.trailing.isEmpty {
                        Text(row.trailing)
                            .centraidType("smallStrong")
                            .monospacedDigit()
                            .foregroundStyle(
                                row.dimmed
                                    ? Surface.meta
                                    : RoomToneStyle.color(row.trailingTone, scheme: scheme, accent: accent)
                            )
                            .kitLineLimit(1, wide: 2)
                    }
                    if !row.chips.isEmpty {
                        HStack(spacing: 6) {
                            ForEach(Array(row.chips.enumerated()), id: \.offset) { _, chip in
                                RoomChipView(chip: chip, onTap: onTap)
                            }
                        }
                    }
                }
            }
            if row.selected {
                CentraidIconView(iconKey: "Check", tint: accent.text, size: 16)
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .frame(minHeight: CentraidGeometry.targetMinCoarse)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(row.selected ? Theme.color("bgSel", scheme) : Color.clear)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Surface.line)
                .frame(height: CentraidGeometry.hairline)
                .padding(.leading, CentraidGeometry.pageMargin)
        }
        .contentShape(Rectangle())
    }
}

private struct RoomOptionalA11y: ViewModifier {
    let label: String
    func body(content: Content) -> some View {
        if label.isEmpty { content } else { content.accessibilityLabel(label) }
    }
}

private struct RoomContextMenuModifier: ViewModifier {
    let menu: Centraid_Core_V1_RoomMenu?
    let onTap: (String) -> Void

    func body(content: Content) -> some View {
        if let menu, !menu.sections.isEmpty {
            content.contextMenu {
                RoomMenuContent(menu: menu, onTap: onTap)
            }
        } else {
            content
        }
    }
}

private struct RoomSwipeModifier: ViewModifier {
    let swipe: Centraid_Core_V1_RoomSwipe?
    let onTap: (String) -> Void

    func body(content: Content) -> some View {
        if let swipe, !swipe.selectorID.isEmpty {
            content.swipeActions(edge: .trailing, allowsFullSwipe: true) {
                Button(role: .destructive) {
                    onTap(swipe.selectorID)
                } label: {
                    Text(swipe.label.isEmpty ? KitWords.DELETE : swipe.label)
                }
                .accessibilityIdentifier(swipe.selectorID)
            }
        } else {
            content
        }
    }
}

// MARK: - Facts

struct RoomFactsBlock: View {
    let facts: Centraid_Core_V1_RoomFacts
    let onTap: (String) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(facts.facts.enumerated()), id: \.offset) { index, fact in
                factRow(fact)
                if index < facts.facts.count - 1 {
                    KitHairline()
                }
            }
        }
        .kitCard()
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 6)
    }

    private func factRow(_ fact: Centraid_Core_V1_RoomFact) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(fact.label)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                if !fact.openSelectorID.isEmpty {
                    KitLink(label: fact.value, identifier: fact.openSelectorID) {
                        onTap(fact.openSelectorID)
                    }
                } else {
                    Text(fact.value)
                        .kitType(.row)
                        .foregroundStyle(Surface.ink)
                        .monospacedDigit()
                        .privacySensitive(fact.kind == .secret || fact.sealed)
                }
            }
            Spacer(minLength: 0)
            if fact.sealed, !fact.revealSelectorID.isEmpty {
                KitIconKey(
                    iconKey: "Eye",
                    label: fact.label,
                    identifier: fact.revealSelectorID,
                    action: { onTap(fact.revealSelectorID) }
                )
            }
            if !fact.copySelectorID.isEmpty {
                KitIconKey(
                    iconKey: "Copy",
                    label: fact.label,
                    identifier: fact.copySelectorID,
                    action: { onTap(fact.copySelectorID) }
                )
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
    }
}

// MARK: - Choice

struct RoomChoiceBlock: View {
    let choice: Centraid_Core_V1_RoomChoice
    let callbacks: RoomCallbacks

    @State private var seq: UInt64 = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !choice.label.isEmpty, choice.style != .menu {
                Text(choice.label)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                    .padding(.horizontal, CentraidGeometry.pageMargin)
            }
            switch choice.style {
            case .segmented:
                let selectedID = choice.options.first(where: \.selected)?.id ?? ""
                KitSegmented(
                    options: choice.options.map { (key: $0.id, label: $0.label) },
                    selected: selectedID,
                    identifier: choice.selectorID,
                    fills: true,
                    segmentID: { id, _ in id },
                    onSelect: { pick($0) }
                )
                .padding(.horizontal, CentraidGeometry.pageMargin)

            case .menu:
                let current = choice.options.first(where: \.selected)?.label ?? ""
                Menu {
                    ForEach(choice.options, id: \.id) { option in
                        Toggle(
                            isOn: Binding(get: { option.selected }, set: { _ in pick(option.id) })
                        ) {
                            Text(option.label)
                        }
                    }
                } label: {
                    HStack {
                        Text(choice.label)
                            .kitType(.row)
                            .foregroundStyle(Surface.ink)
                        Spacer(minLength: 8)
                        Text(current)
                            .kitType(.row)
                            .foregroundStyle(Surface.meta)
                        CentraidIconView(iconKey: "ChevronDown", tint: Surface.meta, size: 12)
                    }
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .frame(minHeight: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
                }
                .accessibilityIdentifier(choice.selectorID)

            case .chips:
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(choice.options, id: \.id) { option in
                            KitChip(
                                label: option.label,
                                selected: option.selected,
                                identifier: "\(choice.selectorID)-\(option.id)",
                                action: { pick(option.id) }
                            )
                        }
                    }
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                }

            case .list, .unspecified, .UNRECOGNIZED:
                VStack(spacing: 0) {
                    ForEach(choice.options, id: \.id) { option in
                        SheetRow(
                            label: option.label,
                            selected: option.selected,
                            identifier: "\(choice.selectorID)-\(option.id)",
                            onTap: { pick(option.id) }
                        )
                    }
                }
                .kitCard()
                .padding(.horizontal, CentraidGeometry.pageMargin)
            }
        }
        .padding(.vertical, 4)
    }

    private func pick(_ optionID: String) {
        seq &+= 1
        callbacks.change(choice.selectorID, seq, .option(optionID))
    }
}

// MARK: - Figure

struct RoomFigureBlock: View {
    let figure: Centraid_Core_V1_RoomFigure
    let onTap: (String) -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.appAccent) private var accent

    var body: some View {
        let card = VStack(alignment: .leading, spacing: 4) {
            if !figure.label.isEmpty {
                Text(figure.label)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
            }
            Text(figure.value)
                .kitType(.title)
                .monospacedDigit()
                .foregroundStyle(RoomToneStyle.color(figure.tone, scheme: scheme, accent: accent))
            if !figure.caption.isEmpty {
                Text(figure.caption)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .kitCard()
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 4)

        if !figure.selectorID.isEmpty {
            Button { onTap(figure.selectorID) } label: { card }
                .buttonStyle(.plain)
                .accessibilityIdentifier(figure.selectorID)
        } else {
            card
        }
    }
}

// MARK: - Prose

struct RoomProseBlock: View {
    let prose: Centraid_Core_V1_RoomProse
    let onTap: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(prose.text)
                .kitType(.meta)
                .foregroundStyle(Surface.body)
                .fixedSize(horizontal: false, vertical: true)
            if !prose.spans.isEmpty {
                HStack(spacing: 12) {
                    ForEach(Array(prose.spans.enumerated()), id: \.offset) { _, span in
                        let label = spanLabel(span)
                        if !label.isEmpty {
                            KitLink(label: label, dense: true, identifier: span.selectorID) {
                                onTap(span.selectorID)
                            }
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 6)
    }

    private func spanLabel(_ span: Centraid_Core_V1_RoomLinkSpan) -> String {
        let utf8 = prose.text.utf8
        let start = Int(span.start)
        let end = Int(span.end)
        guard start >= 0, end > start, end <= utf8.count else { return "" }
        let sIdx = utf8.index(utf8.startIndex, offsetBy: start)
        let eIdx = utf8.index(utf8.startIndex, offsetBy: end)
        return String(prose.text[sIdx..<eIdx])
    }
}

// MARK: - Media

struct RoomMediaBlock: View {
    let media: Centraid_Core_V1_RoomMedia
    let onTap: (String) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let ratio = media.aspectMilli > 0 ? CGFloat(media.aspectMilli) / 1000.0 : 16.0 / 9.0
        let tile = VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .bottomTrailing) {
                RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous)
                    .fill(KitHue.role(media.thumb.hueKey).map { Theme.color($0, scheme) } ?? Surface.fill)
                    .aspectRatio(ratio, contentMode: .fit)
                    .overlay {
                        CentraidIconView(iconKey: mediaIcon, tint: Surface.meta, size: 28)
                    }
                if !media.durationLabel.isEmpty {
                    Text(media.durationLabel)
                        .kitType(.badge)
                        .foregroundStyle(Color.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(Color.black.opacity(0.65), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .padding(8)
                }
            }
            if !media.caption.isEmpty {
                Text(media.caption)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 6)

        if !media.selectorID.isEmpty {
            Button { onTap(media.selectorID) } label: { tile }
                .buttonStyle(.plain)
                .accessibilityIdentifier(media.selectorID)
        } else {
            tile
        }
    }

    private var mediaIcon: String {
        switch media.kind {
        case .video: return "Video"
        case .scan: return "Scan"
        case .file: return "File"
        case .image, .unspecified, .UNRECOGNIZED: return "Image"
        }
    }
}

// MARK: - Progress

struct RoomProgressBlock: View {
    let progress: Centraid_Core_V1_RoomProgress
    let onTap: (String) -> Void

    @Environment(\.appAccent) private var accent

    var body: some View {
        let fraction = progress.total > 0 ? min(CGFloat(progress.done) / CGFloat(progress.total), 1) : 0
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(progress.label)
                    .kitType(.row)
                    .foregroundStyle(Surface.ink)
                Spacer(minLength: 8)
                if !progress.countLabel.isEmpty {
                    Text(progress.countLabel)
                        .kitType(.meta)
                        .monospacedDigit()
                        .foregroundStyle(Surface.meta)
                }
            }
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Surface.fill)
                    Capsule()
                        .fill(accent.fill)
                        .frame(width: proxy.size.width * fraction)
                }
            }
            .frame(height: 6)
            .accessibilityHidden(true)
            if progress.hasCancel, !progress.cancel.label.isEmpty {
                KitOutlineButton(
                    label: progress.cancel.label,
                    action: { onTap(progress.cancel.selectorID) }
                )
                .disabled(!progress.cancel.enabled)
                .accessibilityIdentifier(progress.cancel.selectorID)
            }
        }
        .padding(14)
        .kitCard()
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 6)
    }
}

// MARK: - Empty

struct RoomEmptyBlock: View {
    let empty: Centraid_Core_V1_RoomEmpty
    let onTap: (String) -> Void

    var body: some View {
        var kitEmpty = Centraid_Core_V1_EmptyState()
        kitEmpty.headline = empty.title
        kitEmpty.body = empty.body
        kitEmpty.iconKey = empty.glyph.icon
        kitEmpty.actionLabel = empty.hasAction ? empty.action.label : ""
        return EmptyStateView(
            kitEmpty,
            actionIdentifier: empty.hasAction ? empty.action.selectorID : "kit-empty-action",
            onAction: empty.hasAction && empty.action.enabled ? { onTap(empty.action.selectorID) } : nil
        )
    }
}

// MARK: - Wall

struct RoomWallBlock: View {
    let wall: Centraid_Core_V1_RoomWall
    let onTap: (String) -> Void

    var body: some View {
        VStack(spacing: 12) {
            CentraidIconView(iconKey: "Lock", tint: Surface.ink, size: 32)
                .accessibilityHidden(true)
            Text(wall.title)
                .kitType(.section)
                .foregroundStyle(Surface.ink)
                .multilineTextAlignment(.center)
            if !wall.body.isEmpty {
                Text(wall.body)
                    .kitType(.row)
                    .foregroundStyle(Surface.body)
                    .multilineTextAlignment(.center)
            }
            if !wall.failure.isEmpty {
                Text(wall.failure)
                    .kitType(.meta)
                    .foregroundStyle(StateColor.red.text)
                    .multilineTextAlignment(.center)
            }
            if wall.hasUnlock, !wall.unlock.label.isEmpty {
                KitInkButton(
                    label: wall.unlock.label,
                    identifier: wall.unlock.selectorID,
                    action: { onTap(wall.unlock.selectorID) }
                )
                .disabled(!wall.unlock.enabled)
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(24)
        .kitCard()
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 12)
    }
}

// MARK: - Tiles

struct RoomTilesBlock: View {
    let tiles: Centraid_Core_V1_RoomTiles
    let onTap: (String) -> Void

    @Environment(\.colorScheme) private var scheme

    private let columns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12),
    ]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 12) {
            ForEach(tiles.tiles, id: \.selectorID) { tile in
                Button { onTap(tile.selectorID) } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        if tile.hasGlyph {
                            let fill: Color? = KitHue.role(tile.glyph.hueKey).map { Theme.color($0, scheme) }
                            KitTile(iconKey: tile.glyph.icon, size: 36, fill: fill)
                        }
                        Text(tile.label)
                            .kitType(.row)
                            .fontWeight(.semibold)
                            .foregroundStyle(Surface.ink)
                            .lineLimit(1)
                        if !tile.subtitle.isEmpty {
                            Text(tile.subtitle)
                                .kitType(.meta)
                                .foregroundStyle(Surface.meta)
                                .lineLimit(2)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 96, alignment: .topLeading)
                    .padding(14)
                    .kitCard()
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier(tile.selectorID)
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
    }
}

// MARK: - Glance

struct RoomGlanceBlock: View {
    let glance: Centraid_Core_V1_RoomGlance
    let onTap: (String) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let card = VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                if glance.hasGlyph {
                    let fill: Color? = KitHue.role(glance.glyph.hueKey).map { Theme.color($0, scheme) }
                    KitTile(iconKey: glance.glyph.icon, size: 24, fill: fill)
                }
                Text(glance.title)
                    .kitType(.meta)
                    .fontWeight(.semibold)
                    .foregroundStyle(Surface.meta)
                    .lineLimit(1)
            }
            ForEach(Array(glance.lines.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .kitType(.row)
                    .foregroundStyle(Surface.ink)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .kitCard()
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 4)

        if !glance.selectorID.isEmpty {
            Button { onTap(glance.selectorID) } label: { card }
                .buttonStyle(.plain)
                .accessibilityIdentifier(glance.selectorID)
        } else {
            card
        }
    }
}

// MARK: - Trash

struct RoomTrashBlock: View {
    let trash: Centraid_Core_V1_RoomTrash
    let onTap: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !trash.heading.isEmpty || !trash.retention.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    if !trash.heading.isEmpty {
                        Text(trash.heading)
                            .kitType(.section)
                            .foregroundStyle(Surface.ink)
                            .accessibilityAddTraits(.isHeader)
                    }
                    if !trash.retention.isEmpty {
                        Text(trash.retention)
                            .kitType(.meta)
                            .foregroundStyle(Surface.meta)
                    }
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.top, 8)
            }
            ForEach(Array(trash.rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 12) {
                    if row.hasMark {
                        RoomMarkView(mark: row.mark, onTap: onTap, size: 32)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.title)
                            .kitType(.row)
                            .foregroundStyle(Surface.ink)
                        if !row.meta.isEmpty {
                            Text(row.meta)
                                .kitType(.meta)
                                .foregroundStyle(Surface.meta)
                        }
                    }
                    Spacer(minLength: 8)
                    if !row.restoreSelectorID.isEmpty {
                        KitLink(label: KitWords.OPEN, dense: true, identifier: row.restoreSelectorID) {
                            onTap(row.restoreSelectorID)
                        }
                    }
                    if !row.purgeSelectorID.isEmpty {
                        KitIconKey(
                            iconKey: "Trash",
                            label: KitWords.DELETE,
                            tint: "net",
                            identifier: row.purgeSelectorID,
                            action: { onTap(row.purgeSelectorID) }
                        )
                    }
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.vertical, 8)
                .overlay(alignment: .bottom) { KitHairline() }
                .modifier(OptionalIdentifier(identifier: row.selectorID))
            }
            if !trash.nextPageSelectorID.isEmpty {
                ShowMoreFooter(visible: true) { onTap(trash.nextPageSelectorID) }
            }
            if trash.hasEmptyTrash, !trash.emptyTrash.label.isEmpty {
                KitInkButton(
                    label: trash.emptyTrash.label,
                    destructive: true,
                    identifier: trash.emptyTrash.selectorID,
                    action: { onTap(trash.emptyTrash.selectorID) }
                )
                .disabled(!trash.emptyTrash.enabled)
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.top, 8)
            }
        }
    }
}

// MARK: - Confirm

struct RoomConfirmBlock: View {
    let confirm: Centraid_Core_V1_RoomConfirm
    let onTap: (String) -> Void

    var body: some View {
        let destructive = confirm.`class` == .outlined
        VStack(alignment: .leading, spacing: 14) {
            if !confirm.title.isEmpty {
                Text(confirm.title)
                    .kitType(.section)
                    .foregroundStyle(Surface.ink)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("kit-confirm")
            }
            if !confirm.warning.isEmpty {
                Text(confirm.warning)
                    .kitType(.row)
                    .foregroundStyle(StateColor.amber.text)
                    .accessibilityIdentifier("kit-confirm-warning")
            }
            if !confirm.body.isEmpty {
                Text(confirm.body)
                    .kitType(.row)
                    .foregroundStyle(Surface.body)
            }
            VStack(spacing: 8) {
                if !confirm.confirmLabel.isEmpty {
                    KitInkButton(
                        label: confirm.confirmLabel,
                        destructive: destructive,
                        identifier: confirm.confirmSelectorID,
                        action: { onTap(confirm.confirmSelectorID) }
                    )
                }
                if !confirm.cancelLabel.isEmpty {
                    KitLink(
                        label: confirm.cancelLabel,
                        tint: Surface.ink,
                        identifier: confirm.cancelSelectorID,
                        action: { onTap(confirm.cancelSelectorID) }
                    )
                }
            }
            .padding(.top, 6)
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 12)
    }
}

// MARK: - Menu (inline / sheet)

struct RoomMenuBlock: View {
    let menu: Centraid_Core_V1_RoomMenu
    let onTap: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(menu.sections.enumerated()), id: \.offset) { _, section in
                VStack(alignment: .leading, spacing: 0) {
                    if !section.heading.isEmpty {
                        Text(section.heading)
                            .kitType(.group)
                            .foregroundStyle(Surface.meta)
                            .padding(.horizontal, CentraidGeometry.pageMargin)
                            .padding(.bottom, 4)
                    }
                    VStack(spacing: 0) {
                        ForEach(section.items, id: \.selectorID) { item in
                            if !item.submenu.isEmpty {
                                Menu {
                                    ForEach(item.submenu, id: \.selectorID) { sub in
                                        Button(role: sub.destructive ? .destructive : nil) {
                                            onTap(sub.selectorID)
                                        } label: {
                                            Text(sub.label)
                                        }
                                        .disabled(!sub.enabled)
                                    }
                                } label: {
                                    SheetRow(
                                        iconKey: item.icon,
                                        label: item.label,
                                        detail: item.secondary,
                                        destructive: item.destructive,
                                        selected: item.checked,
                                        chevron: true,
                                        identifier: item.selectorID,
                                        onTap: {}
                                    )
                                    .allowsHitTesting(false)
                                }
                                .disabled(!item.enabled)
                            } else {
                                SheetRow(
                                    iconKey: item.icon,
                                    label: item.label,
                                    detail: item.secondary,
                                    destructive: item.destructive,
                                    selected: item.checked,
                                    identifier: item.selectorID,
                                    onTap: { onTap(item.selectorID) }
                                )
                                .disabled(!item.enabled)
                            }
                        }
                    }
                    .sheetRowGroup()
                }
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .modifier(OptionalIdentifier(identifier: menu.selectorID))
    }
}
