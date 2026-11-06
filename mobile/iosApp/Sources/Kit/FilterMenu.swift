import SwiftUI

// THE ONE FILTER AND SORT MENU (product-intuition/references/design-behaviour.md § App roots).
//
// The header's filter button opens a platform `Menu` that Rust finished
// (`FilterMenu`): its sections, options, counts, checks and words. This file is
// the only drawing of it, so every app's menu is the same control, and it keeps no
// state — a pick goes back as `FilterMenuPicked`, the clear row as
// `FilterMenuCleared`, and the next state says what is checked. The Compose twin
// is `androidApp/.../kit/FilterMenu.kt`.

/// A FILTER MENU AS AN `AppPlace` CARRIES IT: Rust's menu and the two events it
/// answers with. Nil on the room where the app has nothing to filter.
struct FilterSlot {
    let menu: Centraid_Core_V1_FilterMenu
    let onPick: (_ section: String, _ option: String) -> Void
    let onClear: () -> Void
}

/// THE HEADER'S SECOND LINE, as an `AppPlace` carries it: the scope the page is in.
/// The words (and the close key, when `clearable`) are Rust's `HeaderSubtitle`;
/// `onTap` is the app's own event for a tap on the words (Money's month sheet) and
/// `onClear` the app's clear (Notes' notebook).
struct SubtitleSlot {
    let subtitle: Centraid_Core_V1_HeaderSubtitle
    var onTap: () -> Void = {}
    var onClear: () -> Void = {}
}

/// THE FILTER BUTTON AND ITS MENU.
///
/// **LIT, NOT BADGED.** While Rust says `filtering` the funnel is drawn solid (the same ink,
/// filled in), the way a toggle that is on is — never an accent, a dot or a count.
///
/// **EVERY OPTION IS A `Toggle`.** The system draws its own checkmark, so no glyph is ours, and a
/// multi pick does not close the menu (a member choosing three tags is not done after one).
struct FilterMenuButton: View {
    let app: String
    let slot: FilterSlot

    var body: some View {
        let menu = slot.menu
        Menu {
            if menu.filtering {
                Section {
                    Button(menu.clearLabel_p) { slot.onClear() }
                        .accessibilityIdentifier("\(app)-filter-clear")
                }
            }
            ForEach(menu.sections, id: \.key) { section in
                if section.nested {
                    Menu {
                        options(of: section)
                    } label: {
                        Text(section.summary.isEmpty ? section.title : "\(section.title) · \(section.summary)")
                    }
                    .accessibilityIdentifier("\(app)-filter-\(section.key)")
                } else {
                    Section(section.title) { options(of: section) }
                }
            }
        } label: {
            CentraidIconView(
                iconKey: "Filter",
                tint: Theme.color("text", scheme),
                size: 18,
                solid: menu.filtering
            )
        }
        .accessibilityLabel(menu.spoken)
        .accessibilityIdentifier("\(app)-filter-menu")
    }

    @Environment(\.colorScheme) private var scheme

    /// A section's options as `Toggle`s, which the system draws with its own checkmark (a `Picker`
    /// inside a section lost the section's header). A multi pick leaves the menu open — a member
    /// choosing three tags is not done after one — and a single pick closes it as any item does.
    @ViewBuilder
    private func options(of section: Centraid_Core_V1_MenuSection) -> some View {
        let rows = ForEach(section.options, id: \.key) { option in
            Toggle(
                isOn: Binding(
                    get: { option.selected },
                    set: { _ in slot.onPick(section.key, option.key) }
                )
            ) {
                Text(Self.words(option))
            }
            .accessibilityIdentifier("\(app)-filter-\(section.key)-\(option.key)")
        }
        if section.kind == .multi {
            rows.menuActionDismissBehavior(.disabled)
        } else {
            rows
        }
    }

    /// An option's label with its count beside it, when it has one.
    private static func words(_ option: Centraid_Core_V1_MenuOption) -> String {
        option.count > 0 ? "\(option.label) · \(option.count)" : option.label
    }
}

/// THE HEADER'S TITLE WITH A SECOND LINE: the app's name over the scope, which may
/// carry a close key, and may open something. Drawn in the bar's principal slot, so
/// the system keeps the back label ("Notes") from `navigationTitle`.
struct RoomTitle: View {
    let title: String
    let slot: SubtitleSlot

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: 0) {
            Text(title)
                .centraidType("control")
                .foregroundStyle(Theme.color("text", scheme))
                .lineLimit(1)
            HStack(spacing: 4) {
                if slot.subtitle.tappable {
                    Button(action: slot.onTap) { words }
                        .buttonStyle(.plain)
                        .accessibilityLabel(slot.subtitle.spoken)
                        .accessibilityIdentifier("room-subtitle")
                } else {
                    words
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(slot.subtitle.spoken)
                        .accessibilityIdentifier("room-subtitle")
                }
                if slot.subtitle.clearable {
                    Button(action: slot.onClear) {
                        CentraidIconView(iconKey: "X", tint: Theme.color("textSoft", scheme), size: 12)
                            .frame(width: 24, height: 24)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(slot.subtitle.clearSpoken_p)
                    .accessibilityIdentifier("room-subtitle-clear")
                }
            }
        }
    }

    private var words: some View {
        HStack(spacing: 2) {
            Text(slot.subtitle.label)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .lineLimit(1)
            if slot.subtitle.tappable {
                CentraidIconView(iconKey: "ChevronDown", tint: Theme.color("textSoft", scheme), size: 12)
            }
        }
    }
}
