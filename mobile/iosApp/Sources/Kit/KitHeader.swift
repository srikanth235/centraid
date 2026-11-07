import SwiftUI

/// THE PAGE'S HEADER (#1173): the title at 34 bold, and under it at most one line of scope at
/// 13 (Notes' notebook, Money's month, "Trash · 3"). A scope the member can clear carries an
/// X; one that opens something carries a chevron. The keys are the system bar's, above this.
///
/// Drawn in the page and not in the bar so every app's title is one size in one place, and so
/// the page's own colour runs under it. It is a heading for VoiceOver.
struct KitHeader: View {
    let title: String
    var subtitle: SubtitleSlot? = nil
    /// A plain scope line that is just words ("All apps", "Trash · 3"), for a page with no
    /// `SubtitleSlot`.
    var meta: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .kitType(.title)
                .foregroundStyle(Surface.ink)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("kit-header-title")
            if let subtitle {
                scope(subtitle)
            } else if !meta.isEmpty {
                Text(meta)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                    .lineLimit(1)
                    .accessibilityIdentifier("kit-header-meta")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, CentraidGeometry.pageMargin + 2)
        .padding(.top, 2)
        .padding(.bottom, 8)
    }

    @ViewBuilder
    private func scope(_ slot: SubtitleSlot) -> some View {
        HStack(spacing: 4) {
            if slot.subtitle.tappable {
                Button(action: slot.onTap) { words(slot) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(slot.subtitle.spoken)
                    .accessibilityIdentifier("room-subtitle")
            } else {
                words(slot)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(slot.subtitle.spoken)
                    .accessibilityIdentifier("room-subtitle")
            }
            if slot.subtitle.clearable {
                Button(action: slot.onClear) {
                    CentraidIconView(iconKey: "X", tint: Surface.meta, size: 12)
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(slot.subtitle.clearSpoken_p)
                .accessibilityIdentifier("room-subtitle-clear")
            }
        }
    }

    private func words(_ slot: SubtitleSlot) -> some View {
        HStack(spacing: 2) {
            Text(slot.subtitle.label)
                .kitType(.meta)
                .foregroundStyle(Surface.meta)
                .lineLimit(1)
            if slot.subtitle.tappable {
                CentraidIconView(iconKey: "ChevronDown", tint: Surface.meta, size: 12)
            }
        }
    }
}

/// THE HEADER'S FILLED KEY (#1173): the app's create verb as a `+` in the app's accent, white
/// glyph on its fill, the one filled element in the bar. The glass tool key beside it is the
/// system's own. On iOS 26 the bar draws it as tinted glass; before it, a prominent circle.
struct KitAccentKey: View {
    let iconKey: String
    let label: String
    var identifier: String = "room-action"
    var enabled: Bool = true
    /// THE APP'S COLOUR, stated: a toolbar item is hosted by the navigation bar and does not
    /// inherit the place's environment, so the place hands its accent in.
    var accent: AppAccent = .shell
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            CentraidIconView(iconKey: iconKey, tint: .white, size: 18)
                .frame(width: 30, height: 30)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.circle)
        .tint(accent.fill)
        .disabled(!enabled)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
}
