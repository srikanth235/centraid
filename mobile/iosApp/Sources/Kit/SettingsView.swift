import SwiftUI

/// `home.settings` (#1173, the Settings board): a pushed page of cards. The appearance is one
/// segmented choice (stacked at the largest text), then a card per section, then About. Every
/// word, the order and where a row goes are Rust's; a tap on a row with a route is `open`.
struct SettingsView: View {
    let state: Centraid_Core_V1_SettingsState
    let send: (Centraid_Core_V1_SettingsEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onBack: () -> Void

    private var content: ScreenContent<Centraid_Core_V1_SettingsData> {
        switch state.content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }

    var body: some View {
        PushedPage(title: state.title, parentTitle: state.backLabel, onBack: onBack, showsTitle: true) {
            EmptyView()
        } content: {
            ReadStateView(content: content, onRetry: nil) { data in
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
                        ForEach(data.sections, id: \.key) { section in
                            GroupHead(title: section.title)
                            // THE ROWS ARE ONE CARD; the last hairline falls outside the clip.
                            VStack(spacing: 0) {
                                ForEach(section.rows, id: \.id) { row in
                                    SettingsRowView(row: row, open: open)
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
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home-settings")
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

/// SYSTEM · LIGHT · DARK. At the largest text the three stack, so no word is cut.
private struct SettingsSegmented: View {
    let choices: [Centraid_Core_V1_SettingsChoice]
    let onPick: (String) -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let stacked = dynamicTypeSize >= Theme.textSizeCap
        let layout = stacked ? AnyLayout(VStackLayout(spacing: 2)) : AnyLayout(HStackLayout(spacing: 2))
        layout {
            ForEach(choices, id: \.id) { choice in
                Button { onPick(choice.id) } label: {
                    Text(choice.label)
                        .kitType(.row)
                        .fontWeight(choice.selected ? .semibold : .regular)
                        .foregroundStyle(choice.selected ? Surface.ink : Surface.meta)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                        .background(choice.selected ? Surface.card : Color.clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(choice.selected ? [.isButton, .isSelected] : .isButton)
                .accessibilityIdentifier("settings-appearance-\(choice.id)")
            }
        }
        .padding(3)
        .background(Surface.fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityIdentifier("settings-appearance")
    }
}

private struct SettingsRowView: View {
    let row: Centraid_Core_V1_SettingsRow
    let open: (Centraid_Core_V1_Route) -> Void

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
        default:
            if !row.iconKey.isEmpty { KitTile(iconKey: row.iconKey, size: 32) }
        }
    }

    var body: some View {
        let content = HStack(spacing: 12) {
            tile
            VStack(alignment: .leading, spacing: 1) {
                Text(row.title).kitType(.row).foregroundStyle(Surface.ink)
                if !row.meta.isEmpty {
                    Text(row.meta).kitType(.meta).foregroundStyle(Surface.meta)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if row.hasRoute {
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
            } else {
                content
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel)
        .accessibilityAddTraits(row.hasRoute ? .isButton : [])
        .accessibilityIdentifier("settings-row-\(row.id)")
    }
}
