import SwiftUI

/// THE TWO FACTS TRUE ON EVERY ROUTE: which vault, and how it stands
/// (#1020, wave A; v0 `screens/home/VaultHeader.tsx`).
///
/// No greeting. **The mark IS the vault switch** — there is no chevron beside
/// it, because a lockup that is not pressable and a control that is are two
/// affordances for one act. The second line is mono and says where this vault
/// stands IN PLACE, never as a banner: none of those states is an incident.
///
/// **It says the VAULT's state and never a gateway's name (#1025).** This drew
/// `gateway_name`, a field no layer on any side ever wrote, so a device that
/// had paired, synced and was holding its rows read "not connected to a
/// gateway" for two waves. Nothing in the pairing exchange names a gateway —
/// a device pairs with a VAULT — so there was no name to fill in and
/// `VaultLockup.State` is the fact that can be told.
///
/// **`State` replaced `Link` because pairing is an ACTION, not a state (#1025
/// S7-9).** Two of `Link`'s five cases were never states of a vault at all:
/// `LINK_UNPAIRED` described the DEVICE — a device holding zero vaults shows
/// the pair flow — and a vault this header is drawing is by definition one the
/// device holds, so it had already been paired and that case could only ever
/// fire as a guess. `LINK_PAIRED` meant "admitted, nothing has reported yet",
/// which a member reads as "the copy is still coming": [.syncing]. What is
/// left is one axis with three values — syncing, online, offline — each
/// derived from the last pass rather than stored.
///
/// One trailing verb, Settings, and only when originals are waiting: the key
/// to the transfer rules that decided it (HomeRoom: one trailing verb).
struct VaultHeader: View {
    /// The lockup and the keys beside it, finished by Rust (`HomeBar`).
    let bar: Centraid_Core_V1_HomeBar
    @ObservedObject var shell: ShellModel
    @ObservedObject var store: ScreenStore
    @Environment(\.colorScheme) private var scheme

    private var vault: Centraid_Core_V1_HomeVault { bar.vault }

    /// The backup's status stands in the line only when Rust sent it (it sends
    /// none for a vault that moved).
    private var status: String { bar.hasBackup ? bar.backup.status : "" }

    private var loud: Bool {
        guard bar.hasBackup else { return false }
        return bar.backup.tone == .attention || bar.backup.tone == .urgent
    }

    private var mark: (ground: Color, ink: Color) {
        guard let hue = VaultHue.parse(vault.color) else {
            return (Theme.color("bgSunken", scheme), Theme.color("text", scheme))
        }
        let share = scheme == .dark
            ? CentraidGeometry.iconChipTintDark
            : CentraidGeometry.iconChipTintLight
        return (VaultHue.mix(hue, over: Theme.color("bg", scheme), share: share), hue)
    }

    private var statusLine: some View {
        Button {
            store.sendHome(.backup(.init()))
        } label: {
            HStack(spacing: 6) {
                if loud {
                    Circle()
                        .fill(Theme.color(bar.backup.tone == .urgent ? "danger" : "attention", scheme))
                        .frame(width: 6, height: 6)
                }
                Text(status)
                    .centraidType("mono")
                    .foregroundStyle(Theme.color(loud ? "text" : "textFaint", scheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(minHeight: 18)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // THE BACKUP TAB ITSELF IS PLAIN TEXT, not a dimmed control: the status
        // is still true there.
        .allowsHitTesting(shell.tab != .backup)
        .accessibilityLabel(shell.tab == .backup ? status : bar.backupOpenLabel)
        .accessibilityIdentifier("home-backup-status")
    }

    /// The Backup tab shows the lockup too, but not the search and settings keys.
    private var onHome: Bool { shell.tab == .home }

    @Environment(\.isLargestText) private var largestText

    /// THE VAULT'S MARK: the switch's first half.
    private var markKey: some View {
        // TWO DOORS IN ONE LOCKUP: the mark and the name are the vault
        // switch; the status under them is the Backup tab's.
        Button {
            store.sendHome(.vault(.init()))
        } label: {
            Text(vault.initial)
                .centraidType("smallStrong")
                .foregroundStyle(mark.ink)
                .frame(width: 30, height: 30)
                // A static control rung, not `iconChipRadius` — that
                // ratio is for app chips.
                .background(mark.ground, in: RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
    }
    .buttonStyle(.plain)
    .accessibilityHidden(true)

    }

    /// THE NAME AND THE LINES UNDER IT.
    private var lockupText: some View {
        VStack(alignment: .leading, spacing: 1) {
            Button {
                store.sendHome(.vault(.init()))
            } label: {
                Text(vault.name)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(largestText ? nil : 1)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(bar.switchLabel)
            .accessibilityIdentifier("home-vault-switch")

            if !status.isEmpty {
                statusLine
            } else if !vault.stateLine.isEmpty {
                Text(vault.stateLine)
                    .centraidType("mono")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !vault.originalsLine.isEmpty {
                Text(vault.originalsLine)
                    .centraidType("mono")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("home-originals-waiting")
            }
    }

    }

    /// THE TRAILING KEYS AS ONE GROUP.
    private var keys: some View {
        // THE TRAILING KEYS AS ONE GROUP: their 44pt targets touch, so
        // the 36pt plates stand 8pt apart and read as a pair.
        HStack(spacing: 0) {
            // THE DOOR TO THE TRANSFER RULES (#1025 S4), beside the line that
            // reports them rather than buried in settings.
            if vault.originalsWithheld > 0 {
                KitIconKey(
                    iconKey: "Settings",
                    label: bar.transferRulesLabel,
                    identifier: "home-transfer-rules"
                ) {
                    store.sendHome(.transferRulesPressed(.init()))
                }
            }
            if onHome, bar.hasSearchRoute {
                KitIconKey(
                    iconKey: "Search",
                    label: bar.searchLabel,
                    glass: true,
                    identifier: "home-search-open"
                ) {
                    shell.open(bar.searchRoute)
                }
            }
            // SETTINGS: the appearance, the vault, the backup and the recovery key
            // live behind it (the appearance key retired into it, #1173).
            if onHome, bar.hasSettingsRoute {
                KitIconKey(
                    iconKey: "Settings",
                    label: bar.settingsLabel,
                    glass: true,
                    identifier: "home-settings-open"
                ) {
                    shell.open(bar.settingsRoute)
                }
            }
    }
    // The last plate's edge on the page margin, not 4pt inside it:
    // the target overhangs by its own inset, (44 - 36) / 2.
    .padding(.trailing, -4)
    }

    var body: some View {
        // AT THE LARGEST TEXT THE KEYS DROP UNDER THE LOCKUP (#1173): beside it they left the
        // name a sliver of the row, and it was cut to a few letters.
        Group {
            if largestText {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .top, spacing: 12) {
                        markKey
                        lockupText
                    }
                    HStack(spacing: 0) {
                        Spacer(minLength: 0)
                        keys
                    }
                }
            } else {
                HStack(spacing: 12) {
                    markKey
                    lockupText
                    keys
                }
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }
}

/// A vault's own hue, and the one wash that is not emitted.
///
/// Every APP hue is resolved and composited by
/// `cargo xtask design`, because the seven apps are known
/// at build time. A vault's colour is the member's, chosen at runtime, so it
/// cannot be in that table — and this is the one place the blend is computed
/// rather than read. It uses the SAME tint share the emitter uses, from the
/// same table, so the two cannot drift apart.
enum VaultHue {
    static func parse(_ value: String) -> Color? {
        let hex = value.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "#", with: "")
        guard hex.count == 6, hex.allSatisfy({ $0.isHexDigit }) else { return nil }
        let scanned = UInt32(hex, radix: 16) ?? 0
        return Color(
            .sRGB,
            red: Double((scanned >> 16) & 0xFF) / 255,
            green: Double((scanned >> 8) & 0xFF) / 255,
            blue: Double(scanned & 0xFF) / 255,
            opacity: 1
        )
    }

    /// `color-mix()` exists on no native platform, so the composite is explicit.
    static func mix(_ hue: Color, over page: Color, share: CGFloat) -> Color {
        hue.opacity(share).blended(over: page)
    }
}

private extension Color {
    /// An OPAQUE composite, not a translucent overlay.
    ///
    /// A translucent chip would pick up whatever happens to sit behind it, and
    /// what sits behind a lockup changes with the route. Opacity over an opaque
    /// ground is a colour; opacity over an unknown ground is a guess.
    func blended(over page: Color) -> Color {
        #if canImport(UIKit)
        let top = UIColor(self)
        let bottom = UIColor(page)
        var (tr, tg, tb, ta): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        var (br, bg, bb, ba): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        guard top.getRed(&tr, green: &tg, blue: &tb, alpha: &ta),
              bottom.getRed(&br, green: &bg, blue: &bb, alpha: &ba) else { return page }
        return Color(
            .sRGB,
            red: tr * ta + br * (1 - ta),
            green: tg * ta + bg * (1 - ta),
            blue: tb * ta + bb * (1 - ta),
            opacity: 1
        )
        #else
        return page
        #endif
    }
}

/// THE MEMBER'S TRANSFER RULE, AS A SHEET (#1025 S4, D-1025-S7-60): Rust's
/// (`HomeState.transfer_sheet`). Three choices, each a plain SENTENCE rather than
/// a label — a member deciding how their phone spends money is owed something
/// they can act on — the same three the Backup page draws, from the same store.
/// The tick is the store's answer, never the tap.
///
/// **It sets the rule and starts nothing.** A member who has just chosen to
/// spend less must not be answered by a pass that spends; the new rule governs
/// the next window, and what the OS already holds is cancelled in Rust.
struct TransferRulesSheet: View {
    let sheet: Centraid_Core_V1_HomeTransferSheet
    /// A choice's stored word: Home's and Settings' own events carry it.
    let onPick: (String) -> Void
    let onClose: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        SheetRoom(
            title: sheet.title,
            primary: SheetPrimary(label: KitWords.DONE, action: onClose),
            fit: true
        ) {
            Text(sheet.subtitle)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))

            VStack(spacing: 0) {
                ForEach(sheet.choices, id: \.stored) { choice in
                    SheetRow(
                        label: choice.sentence,
                        selected: choice.picked,
                        identifier: "transfer-rule-\(choice.stored)"
                    ) {
                        onPick(choice.stored)
                    }
                }
            }
            // THE CHOICES STAND ON THE SHEET AS ONE GROUP, as `OptionSheet`'s rows do.
            .sheetRowGroup()
        }
    }
}
