import SwiftUI

/// THE STYLE SHEET (#1173 wave 2): name, colour and icon of a list or a calendar — one sheet for
/// the new list, the edited list, the new calendar and the edited calendar, which differ only in
/// the words Rust sends (`title`, `submit_label`).
///
/// **THE VIEW DECIDES NOTHING.** The eight colours are the `[list]` palette by key (looked up in
/// the generated colour sets by `AgendaPalette`), the icons are `design/icons.toml` keys drawn from
/// the catalogue, which one is chosen is the state's, and a tap is an event carrying a key. The
/// name is the member's typing (`MachineTextField`'s echo rule); Create or Save is armed by Rust
/// and drawn greyed, never hidden, while it is not.
struct AgendaStyleSheetView: View {
    let style: Centraid_Core_V1_AgendaStyleSheet
    let onName: (String) -> Void
    let onColor: (String) -> Void
    /// An empty key clears the icon.
    let onIcon: (String) -> Void
    let onSubmit: () -> Void
    let onCancel: () -> Void

    @Environment(\.colorScheme) private var scheme

    /// THE BOARD'S GRID: eight to a row, the colours and the icons alike.
    private static let eight = Array(repeating: GridItem(.flexible(), spacing: 0), count: 8)

    var body: some View {
        SheetRoom(
            title: style.title,
            primary: SheetPrimary(
                label: style.submitLabel,
                enabled: style.canSubmit,
                identifier: "agenda-style-submit",
                action: onSubmit
            ),
            outlines: [SheetOutline(label: style.cancelLabel, link: true, identifier: "agenda-style-cancel", action: onCancel)]
        ) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 12) {
                        preview
                        MachineTextField(
                            placeholder: style.namePlaceholder,
                            value: style.name,
                            focusOnAppear: true,
                            onEdit: onName
                        )
                        .centraidType("body")
                        .accessibilityLabel(style.namePlaceholder)
                        .accessibilityIdentifier("agenda-style-name")
                    }
                    Text(style.colorLabel)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                    LazyVGrid(columns: Self.eight, spacing: 0) {
                        ForEach(style.colors, id: \.key) { swatch in
                            Button { onColor(swatch.key) } label: {
                                Circle()
                                    .fill(AgendaPalette.list(swatch.key) ?? Theme.color("textFaint", scheme))
                                    .frame(width: 28, height: 28)
                                    .overlay {
                                        if swatch.selected {
                                            Circle().strokeBorder(Theme.color("text", scheme), lineWidth: 2).padding(-4)
                                        }
                                    }
                                    .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(swatch.label)
                            .accessibilityAddTraits(swatch.selected ? .isSelected : [])
                            .accessibilityIdentifier("agenda-style-color-\(swatch.key)")
                        }
                    }
                    Text(style.iconLabel)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                    LazyVGrid(columns: Self.eight, spacing: 0) {
                        ForEach(style.icons, id: \.key) { icon in
                            Button { onIcon(icon.key) } label: {
                                CentraidIconView(
                                    iconKey: icon.key,
                                    tint: icon.selected ? tint : Theme.color("textSoft", scheme),
                                    size: 22
                                )
                                .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                                .background {
                                    if icon.selected {
                                        Circle().fill(Theme.color("bgSunken", scheme))
                                    }
                                }
                                .frame(maxWidth: .infinity)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(icon.label)
                            .accessibilityAddTraits(icon.selected ? .isSelected : [])
                            .accessibilityIdentifier("agenda-style-icon-\(icon.key)")
                        }
                    }
                    if !style.noIconLabel.isEmpty {
                        SheetRow(label: style.noIconLabel, selected: style.noIconSelected, identifier: "agenda-style-icon-none") {
                            onIcon("")
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        // THE WHOLE GRID IN VIEW (the board's tall sheet; Android's `expanded`): the eight colours
        // and the icon grid under them do not fit a half sheet, which hid the icons below a
        // scroll.
        .presentationDetents([.large])
        // Create and Save wear Agenda's blue, whichever screen presents the sheet.
        .environment(\.appAccent, AppAccent("agenda"))
    }

    /// The chosen colour, or the quiet ink while none is.
    private var tint: Color {
        AgendaPalette.list(style.colorKey) ?? Theme.color("text", scheme)
    }

    /// THE PREVIEW: the chosen icon (or a plain dot) in the chosen colour.
    private var preview: some View {
        ZStack {
            Circle().fill(tint.opacity(0.18))
            if style.iconKey.isEmpty {
                Circle().fill(tint).frame(width: 14, height: 14)
            } else {
                CentraidIconView(iconKey: style.iconKey, tint: tint, size: 22)
            }
        }
        .frame(width: 40, height: 40)
        .accessibilityHidden(true)
    }
}

/// A list's or a calendar's mark: its icon in its colour, else a dot in it. A key with no colour
/// draws the dot in `fallback`.
struct AgendaListMark: View {
    let colorKey: String
    let iconKey: String
    var fallback: Color = .clear
    var size: CGFloat = 12

    var body: some View {
        let tint = AgendaPalette.list(colorKey) ?? fallback
        if iconKey.isEmpty {
            Circle().fill(tint).frame(width: size, height: size)
        } else {
            CentraidIconView(iconKey: iconKey, tint: tint, size: max(size + 4, 16))
        }
    }
}
