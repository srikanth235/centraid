import SwiftUI

/// `home.settings` (#1173, the Settings board): a pushed page of cards. The appearance is one
/// segmented choice (stacked at the largest text), then a card per section, then About. Every
/// word, the order and where a row goes are Rust's; a tap on a row with a route is `open`.
struct SettingsView: View {
    let state: Centraid_Core_V1_SettingsState
    let send: (Centraid_Core_V1_SettingsEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onBack: () -> Void

    var body: some View {
        PushedPage(title: state.title, parentTitle: state.backLabel, onBack: onBack) {
            EmptyView()
        } content: {
            PageReadStateView(page: state.page, onRetry: nil) {
                if case let .data(data)? = state.content {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            if data.hasAppearance {
                                GroupHead(title: data.appearance.title)
                                SettingsSegmented(choices: data.appearance.choices) { id in
                                    var event = Centraid_Core_V1_SettingsEvent()
                                    event.kind = .appearancePicked(.with { $0.id = id })
                                    send(event)
                                }
                                Text(data.appearance.note)
                                    .kitType(.meta)
                                    .foregroundStyle(Surface.meta)
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 8)
                                    .accessibilityIdentifier("settings-appearance-note")
                            }
                            if data.hasUnits {
                                GroupHead(title: data.units.title)
                                SettingsSegmented(choices: data.units.choices, identifier: "settings-units") { id in
                                    var event = Centraid_Core_V1_SettingsEvent()
                                    event.kind = .unitsPicked(.with { $0.id = id })
                                    send(event)
                                }
                                Text(data.units.note)
                                    .kitType(.meta)
                                    .foregroundStyle(Surface.meta)
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 8)
                                    .accessibilityIdentifier("settings-units-note")
                            }
                            if data.hasNotifications {
                                GroupHead(title: data.notifications.title)
                                Text(data.notifications.label)
                                    .kitType(.row)
                                    .foregroundStyle(Surface.ink)
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 4)
                                SettingsSegmented(choices: data.notifications.choices, identifier: "settings-notifications") { id in
                                    var event = Centraid_Core_V1_SettingsEvent()
                                    event.kind = .detailsPicked(.with { $0.id = id })
                                    send(event)
                                }
                                Text(data.notifications.note)
                                    .kitType(.meta)
                                    .foregroundStyle(Surface.meta)
                                    .padding(.horizontal, 4)
                                    .padding(.vertical, 8)
                                    .accessibilityIdentifier("settings-notifications-note")
                            }
                            ForEach(data.sections, id: \.key) { section in
                                GroupHead(title: section.title)
                                // THE ROWS ARE ONE CARD; the last hairline falls outside the clip.
                                VStack(spacing: 0) {
                                    ForEach(section.rows, id: \.id) { row in
                                        SettingsRowView(row: row, open: open) {
                                            var event = Centraid_Core_V1_SettingsEvent()
                                            event.kind = .rowPressed(.with { $0.id = row.id })
                                            send(event)
                                        }
                                    }
                                }
                                .padding(.bottom, -1)
                                .kitCard()
                                .clipShape(RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
                                .accessibilityIdentifier("settings-section-\(section.key)")
                            }
                            GroupHead(title: data.aboutTitle)
                            HStack {
                                Text(data.versionTitle).kitType(.row).foregroundStyle(Surface.ink)
                                Spacer(minLength: 8)
                                Text(data.version).kitType(.row).foregroundStyle(Surface.meta)
                            }
                            .padding(.horizontal, 16)
                            .frame(maxWidth: .infinity, minHeight: 52)
                            .kitCard()
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier("settings-version")
                        }
                        .padding(.horizontal, CentraidGeometry.pageMargin)
                        .padding(.bottom, 24)
                    }
                }
            }
            // A REFUSED WRITE (units) is Rust's one sentence in the kit's status line, docked at the foot.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if state.hasStatus {
                    StatusLineView(status: state.status, identifier: "settings-status-action")
                        .accessibilityIdentifier("settings-status")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home-settings")
        // THE PAGE HANDED ITS JOB TO HOME (the vault switcher is Home's sheet): it steps aside.
        .onChange(of: state.finished) { _, finished in
            if finished { onBack() }
        }
        // DOWNLOAD SETTINGS is a sheet of its own (Rust's `transfer_sheet`): the member's one
        // transfer rule, the same three choices Home's gear draws. Dismissing it tells Rust.
        .sheet(
            isPresented: Binding(
                get: { state.hasTransferSheet },
                set: { open in
                    if !open { send(Self.event { $0.kind = .transferRulesClosed(.init()) }) }
                }
            )
        ) {
            TransferRulesSheet(
                sheet: state.transferSheet,
                onPick: { stored in send(Self.event { $0.kind = .transferRuleChosen(.with { $0.stored = stored }) }) },
                onClose: { send(Self.event { $0.kind = .transferRulesClosed(.init()) }) }
            )
        }
    }

    private static func event(_ build: (inout Centraid_Core_V1_SettingsEvent) -> Void) -> Centraid_Core_V1_SettingsEvent {
        var event = Centraid_Core_V1_SettingsEvent()
        build(&event)
        return event
    }
}

private struct GroupHead: View {
    let title: String

    var body: some View {
        Text(title)
            .kitType(.group)
            .foregroundStyle(Surface.meta)
            .padding(.leading, 4)
            .padding(.top, 20)
            .padding(.bottom, 6)
            .accessibilityAddTraits(.isHeader)
    }
}

/// The kit's one segmented track: System · Light · Dark, or Phone's setting · Metric · Imperial.
private struct SettingsSegmented: View {
    let choices: [Centraid_Core_V1_SettingsChoice]
    var identifier: String = "settings-appearance"
    let onPick: (String) -> Void

    var body: some View {
        KitSegmented(
            options: choices.map { (key: $0.id, label: $0.label) },
            selected: choices.first(where: { $0.selected })?.id ?? "",
            identifier: identifier,
            fills: true,
            segmentID: { key, _ in key },
            onSelect: onPick
        )
    }
}

private struct SettingsRowView: View {
    let row: Centraid_Core_V1_SettingsRow
    let open: (Centraid_Core_V1_Route) -> Void
    /// A row with no page behind it is still pressed (`pressable`): Rust is told which.
    let press: () -> Void
    @Environment(\.colorScheme) private var scheme

    /// THE ROW'S TILE, as Rust names it: the vault's round initial, the state-amber fill (the
    /// recovery key), or the shell's colour.
    @ViewBuilder
    private var tile: some View {
        switch row.tile {
        case "initial":
            Text(row.initial)
                .kitType(.row)
                .fontWeight(.bold)
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(AppAccent.shell.fill, in: Circle())
                .accessibilityHidden(true)
        case "amber":
            KitTile(iconKey: row.iconKey, size: 32, fill: StateColor.amber.fill)
        case "neutral":
            KitTile(iconKey: row.iconKey, size: 32, fill: Surface.meta)
        case "add":
            // A ROW THAT MAKES SOMETHING: the shell's tint under the shell's glyph.
            CentraidIconView(iconKey: row.iconKey, tint: AppAccent.shell.text, size: 16)
                .frame(width: 32, height: 32)
                .background(AppAccent.shell.wash(dark: scheme == .dark), in: RoundedRectangle(cornerRadius: 32 * CentraidGeometry.iconChipRadiusRatio, style: .continuous))
                .accessibilityHidden(true)
        default:
            if !row.iconKey.isEmpty { KitTile(iconKey: row.iconKey, size: 32) }
        }
    }

    var body: some View {
        let content = HStack(spacing: 12) {
            tile
            VStack(alignment: .leading, spacing: 1) {
                Text(row.title).kitType(.row).foregroundStyle(row.tile == "add" ? AppAccent.shell.text : Surface.ink)
                if !row.meta.isEmpty {
                    Text(row.meta).kitType(.meta).foregroundStyle(Surface.meta)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !row.value.isEmpty {
                Text(row.value).kitType(.row).foregroundStyle(Surface.meta)
            }
            // A row that MAKES something draws no chevron (the board's Make a vault).
            if (row.hasRoute || row.pressable) && row.tile != "add" {
                CentraidIconView(iconKey: "ChevronRight", tint: Surface.meta, size: 16)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Surface.line).frame(height: CentraidGeometry.hairline).padding(.leading, 56)
        }
        .contentShape(Rectangle())
        Group {
            if row.hasRoute {
                Button { open(row.route) } label: { content }.buttonStyle(.plain)
            } else if row.pressable {
                Button(action: press) { content }.buttonStyle(.plain)
            } else {
                content
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel)
        .accessibilityAddTraits(row.hasRoute || row.pressable ? .isButton : [])
        .accessibilityIdentifier("settings-row-\(row.id)")
    }
}
