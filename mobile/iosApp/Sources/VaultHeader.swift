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
    let vault: Centraid_Screen_V1_VaultLockup
    @ObservedObject var shell: ShellModel
    /// THE VAULT'S BACKUP, said as the lockup's second line (R-ONBOARD-11):
    /// `BackupLine.status`, in place of "on this phone". Nil — an example, or
    /// a route with no backup line — keeps the vault's own state line.
    var backup: Centraid_Screen_V1_BackupLine? = nil
    /// The status line's door: the Backup tab. Nil draws it as text.
    var onOpenBackup: (() -> Void)? = nil
    /// HOME'S SEARCH (R-CHROME-6): a framed key at the lockup's trailing edge,
    /// the one way into search over every app but Locker. Nil draws none.
    var onSearch: (() -> Void)? = nil
    var searchLabel: String = ""
    @Environment(\.colorScheme) private var scheme

    /// The backup status to draw, or empty for the vault's own line. A vault
    /// that MOVED keeps its own line: that is the fact, and the backup's
    /// status says the same thing less exactly.
    private var status: String {
        guard let backup, vault.state != .frozen else { return "" }
        return backup.status
    }

    private var loud: Bool {
        guard let backup else { return false }
        return backup.tone == .attention || backup.tone == .urgent
    }

    /// No name is a REAL STATE; never render a blank lockup.
    private var name: String {
        let trimmed = vault.vaultName.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? PhotosWords.vaultNoneYet : trimmed
    }

    /// Where this vault stands, in a member's words. See [stateLine], which
    /// the switcher's rows draw from too so the header and the sheet cannot
    /// word the same fact two ways.
    private var line: String { vault.stateLine }

    /// THE MEMBER'S OWN RULE, SAID IN PLACE (#1025 S4, D-1025-S7-61).
    ///
    /// **A grid of thumbnails with no full-size files is a DECISION and not a
    /// failure**, and a header that says nothing is how a working byte plane
    /// looks broken. It is a SECOND line beside the state and not a
    /// replacement for it: a device can be perfectly current and still be
    /// waiting for Wi-Fi to bring the photographs, and collapsing the two
    /// would make "synced" and "waiting" one word.
    ///
    /// Empty when nothing is withheld, which is the ordinary case.
    private var waiting: String {
        vault.originalsWithheld == 0
            ? ""
            : (vault.originalsWithheld == 1
                ? PhotosWords.transferOriginalWaitingOne
                : PhotosWords.fill(
                    PhotosWords.transferOriginalWaitingMany, "count", "\(vault.originalsWithheld)"))
    }

    /// The vault's hue washed behind the mark, exactly as an app chip is washed.
    ///
    /// The arithmetic is `packages/design`'s and is emitted per app; a vault's
    /// hue is the member's own and is not in that table, so the wash is mixed
    /// here from the SAME tint share the emitter uses. A vault with no colour
    /// takes ink, never a default hue — an invented identity is still an
    /// invented identity when it is only a colour.
    private var mark: (ground: Color, ink: Color) {
        guard let hue = VaultHue.parse(vault.color) else {
            return (Theme.color("bgSunken", scheme), Theme.color("text", scheme))
        }
        let share = scheme == .dark
            ? CentraidGeometry.iconChipTintDark
            : CentraidGeometry.iconChipTintLight
        return (VaultHue.mix(hue, over: Theme.color("bg", scheme), share: share), hue)
    }

    /// THE BACKUP STATUS: a dot in the tone's colour when it wants the member
    /// (none when it is quiet), then the few words. The same mono line the
    /// state line was, so the lockup keeps its shape; a loud status reads in
    /// ink rather than faint.
    private var statusLine: some View {
        Button {
            onOpenBackup?()
        } label: {
            HStack(spacing: 6) {
                if loud {
                    Circle()
                        .fill(Theme.color(backup?.tone == .urgent ? "danger" : "attention", scheme))
                        .frame(width: 6, height: 6)
                }
                Text(status)
                    .centraidType("mono")
                    .foregroundStyle(Theme.color(loud ? "text" : "textFaint", scheme))
                    .lineLimit(1)
            }
            .frame(minHeight: 18)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // NO DOOR (the Backup tab itself) IS PLAIN TEXT, not a dimmed
        // control: the status is still true there.
        .allowsHitTesting(onOpenBackup != nil)
        .accessibilityLabel(status + (onOpenBackup == nil ? "" : ". " + ShellWords.backupStatusOpen))
        .accessibilityIdentifier("home-backup-status")
    }

    var body: some View {
        HStack(spacing: 12) {
            // TWO DOORS IN ONE LOCKUP: the mark and the name are the vault
            // switch; the status under them is the Backup tab's.
            Button {
                shell.send(screen: "home", event: HomeEvents.vaultSwitch())
            } label: {
                Text(String(name.prefix(1)).uppercased())
                    .centraidType("smallStrong")
                    .foregroundStyle(mark.ink)
                    .frame(width: 30, height: 30)
                    // A static control rung, not `iconChipRadius` — that
                    // ratio is for app chips.
                    .background(mark.ground, in: RoundedRectangle(cornerRadius: Theme.radius("md", scheme)))
            }
            .buttonStyle(.plain)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 1) {
                Button {
                    shell.send(screen: "home", event: HomeEvents.vaultSwitch())
                } label: {
                    Text(name)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(name + ". Switch vault")
                .accessibilityIdentifier("home-vault-switch")

                if !status.isEmpty {
                    statusLine
                } else if !line.isEmpty {
                    Text(line)
                        .centraidType("mono")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                        .lineLimit(1)
                }
                if !waiting.isEmpty {
                    Text(waiting)
                        .centraidType("mono")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                        .lineLimit(1)
                        .accessibilityIdentifier("home-originals-waiting")
                }
            }

            // THE DOOR TO THE TRANSFER RULES (#1025 S4). Beside the line that
            // reports them rather than buried in settings: the member reads
            // "12 originals waiting for Wi-Fi" and the next thing they want is
            // the control that decided it.
            if !waiting.isEmpty {
                KitIconKey(
                    iconKey: "Settings",
                    label: "Download settings",
                    identifier: "home-transfer-rules"
                ) {
                    shell.openTransferRules()
                }
            }
            if let onSearch {
                KitIconKey(
                    iconKey: "Search",
                    label: searchLabel,
                    framed: true,
                    identifier: "home-search-open",
                    action: onSearch
                )
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
/// `contracts/tools/export-native-catalog.ts`, because the eight apps are known
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

/// THE ONE PLACE A `State` BECOMES WORDS.
///
/// The header's second line and every row of the vault switcher are two
/// renderings of ONE fact, exactly as `RosterChanged` made them two renderings
/// of one stream (#1025 S7-9) — so the wording lives here rather than in a
/// table copied into each view, where the two copies drift the first time one
/// sentence is reworded.
extension Centraid_Screen_V1_VaultLockup {
    /// EXHAUSTIVE, with no `default:`. A fourth case added to `State` must fail
    /// to compile here rather than fall quietly into somebody else's sentence,
    /// which is the whole failure this line is recovering from.
    ///
    /// `.unspecified` is NEVER EMITTED — it is the lockup nobody filled in, a
    /// vault the shell could not identify — and it draws NOTHING. "No vault
    /// yet" over silence is honest; "No vault yet" over a claim about a
    /// gateway is what this replaced.
    ///
    /// **"On this phone", never "synced" or "connected".** `STATE_ONLINE`
    /// says the vault is here and whole — the phone is the vault. Nothing on
    /// this side probes anything, so "connected" would promise a live link no
    /// layer here has checked, and "synced" claimed a backup over a vault that
    /// was never paired (#1047 walk); what a gateway holds is the backup
    /// status's to say (`BackupLine.status`, drawn in its place on Home, #1080). `.syncing` and `.offline` left with the pass
    /// they described (#1029 §1, W5) and `.frozen` took their place.
    var stateLine: String {
        switch state {
        case .unspecified: return ""
        case .online: return PhotosWords.vaultOnline
        // THE VAULT MOVED TO THE MEMBER'S OTHER PHONE (#1029 F1, W5). The
        // Android table states the identical sentence; the two shells must
        // read the same. The count of what this phone is still holding rides
        // beside it in `VaultLockup.frozen_line`.
        case .frozen: return PhotosWords.vaultMoved
        case .UNRECOGNIZED: return ""
        }
    }
}

/// THE MEMBER'S TRANSFER RULE, AS A SHEET (#1025 S4, D-1025-S7-60).
///
/// Three choices, each a plain SENTENCE rather than a label — a member
/// deciding how their phone spends money is owed something they can act on,
/// and "Wi-Fi only" is a label that does not say what it governs. The
/// sentences come from the shell's own copy source in `commonMain`
/// (`TransferRule`), so this shell and the Android one cannot word the same
/// choice two ways.
///
/// **It sets the rule and starts nothing.** A member who has just chosen to
/// spend less must not be answered by a pass that spends; the new rule governs
/// the next window.
struct TransferRulesSheet: View {
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SheetRoom(
            title: PhotosWords.transferTitle,
            primary: SheetPrimary(label: ShellWords.done) { dismiss() }
        ) {
            Text(PhotosWords.transferSubtitle)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))

            VStack(spacing: 0) {
                ForEach(shell.transferRuleChoices, id: \.stored) { choice in
                    // THE SELECTION IS THE STORE'S ANSWER, not the tap: an
                    // unknown word settles to the conservative default, and a
                    // tick on a row the next launch would not tick is worse
                    // than a tap that appears to do nothing.
                    SheetRow(
                        label: choice.sentence,
                        selected: shell.transferRule == choice.stored,
                        identifier: "transfer-rule-\(choice.stored)"
                    ) {
                        shell.setTransferRule(choice.stored)
                    }
                }
            }
        }
    }
}
