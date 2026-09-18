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
/// Exactly the band's two verbs beside it, never a third.
struct VaultHeader: View {
    let vault: Centraid_Screen_V1_VaultLockup
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme

    /// No name is a REAL STATE; never render a blank lockup.
    private var name: String {
        let trimmed = vault.vaultName.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? "No vault yet" : trimmed
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
            : "\(vault.originalsWithheld) original\(vault.originalsWithheld == 1 ? "" : "s") waiting for Wi-Fi"
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

    var body: some View {
        HStack(spacing: 12) {
            Button {
                shell.send(screen: "home", event: HomeEvents.vaultSwitch())
            } label: {
                HStack(spacing: 12) {
                    Text(String(name.prefix(1)).uppercased())
                        .centraidType("smallStrong")
                        .foregroundStyle(mark.ink)
                        .frame(width: 30, height: 30)
                        // A static control rung, not `iconChipRadius` — that
                        // ratio is for app chips.
                        .background(mark.ground, in: RoundedRectangle(cornerRadius: 7))
                    VStack(alignment: .leading, spacing: 0) {
                        Text(name)
                            .centraidType("smallStrong")
                            .foregroundStyle(Theme.color("text", scheme))
                            .lineLimit(1)
                        if !line.isEmpty {
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
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)
            // The label REPLACES the two lines for assistive tech, so a screen
            // reader hears one sentence rather than a name and an orphan line.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                [name, line, waiting].filter { !$0.isEmpty }.joined(separator: ", ")
                    + ". Switch vault"
            )
            .accessibilityIdentifier("home-vault-switch")

            // THE DOOR TO THE TRANSFER RULES (#1025 S4). Beside the line that
            // reports them rather than buried in settings: the member reads
            // "12 originals waiting for Wi-Fi" and the next thing they want is
            // the control that decided it.
            if !waiting.isEmpty {
                Button {
                    shell.openTransferRules()
                } label: {
                    CentraidIconView(
                        iconKey: "Settings",
                        tint: Theme.color("textSoft", scheme),
                        size: 16
                    )
                    .frame(width: 34, height: 34)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Download settings")
                .accessibilityIdentifier("home-transfer-rules")
            }

            // BOUNDED, never borderless.
            HeaderAction(iconKey: "Search", spoken: "Search everything")
            // Outlined here; filled only inside the band.
            HeaderAction(iconKey: "NewChat", spoken: "New chat")
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }
}

private struct HeaderAction: View {
    let iconKey: String
    let spoken: String
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        CentraidIconView(
            iconKey: iconKey,
            tint: Theme.color("textSoft", scheme),
            size: 16
        )
        .frame(width: 34, height: 34)
        .overlay(
            RoundedRectangle(cornerRadius: 7)
                .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
        )
        .accessibilityLabel(spoken)
    }
}

/// The route's own name and the ONE control the row carries.
///
/// Search belongs to the lockup and All apps to the band's More tab, so the
/// title row carries Settings alone — which in v0 had no door from Home at all
/// and sat behind All apps, a sheet a member on the springboard has no reason
/// to open.
struct HomeTitleRow: View {
    @Environment(\.colorScheme) private var scheme
    /// Optional so every existing call site — the fixture test's included —
    /// keeps working without a shell.
    var onSettings: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            Text("Home")
                .centraidType("title")
                .foregroundStyle(Theme.color("text", scheme))
            Spacer(minLength: 0)
            // THE GEAR IS THE GATEWAY'S DOOR (#1020, D-1020-B7). It had no
            // action at all; "connect this device to a gateway" is settings and
            // adding a fourth chrome control for it would be adding chrome the
            // rulebook does not have a place for.
            Button {
                onSettings?()
            } label: {
                CentraidIconView(
                    iconKey: "Settings",
                    tint: Theme.color("text", scheme),
                    size: 22
                )
                .frame(minWidth: 44, minHeight: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Settings")
            .accessibilityIdentifier("home-settings")
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.bottom, 14)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Theme.color("line", scheme))
                .frame(height: CentraidGeometry.hairline)
        }
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
    /// **"Synced" and never "connected".** `STATE_ONLINE` is a PAST-TENSE
    /// FACT: the vault is here and whole. Nothing on this side probes
    /// anything, so a word in the present tense would promise a live link no
    /// layer here has checked. `.syncing` and `.offline` left with the pass
    /// they described (#1029 §1, W5) and `.frozen` took their place.
    var stateLine: String {
        switch state {
        case .unspecified: return ""
        case .online: return "synced"
        // THE VAULT MOVED TO THE MEMBER'S OTHER PHONE (#1029 F1, W5). The
        // Android table states the identical sentence; the two shells must
        // read the same. The count of what this phone is still holding rides
        // beside it in `VaultLockup.frozen_line`.
        case .frozen: return "moved to your other phone"
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
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("This is set for this phone, not for one vault. Thumbnails always arrive.")
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))

                ForEach(shell.transferRuleChoices, id: \.stored) { choice in
                    Button {
                        shell.setTransferRule(choice.stored)
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            // THE SELECTION IS THE STORE'S ANSWER, not the tap:
                            // an unknown word settles to the conservative
                            // default, and a tick on a row the next launch
                            // would not tick is worse than a tap that appears
                            // to do nothing.
                            // THE ROW IS THE CONTROL and the dot is its state,
                            // not a second thing to read out: the button
                            // carries the sentence and the selected trait,
                            // which is how VoiceOver says "selected" rather
                            // than "filled circle".
                            Image(systemName: shell.transferRule == choice.stored
                                ? "largecircle.fill.circle"
                                : "circle")
                                .accessibilityHidden(true)
                            Text(choice.sentence)
                                .centraidType("small")
                                .foregroundStyle(Theme.color("text", scheme))
                                .multilineTextAlignment(.leading)
                            Spacer(minLength: 0)
                        }
                        .frame(minHeight: 44)
                    }
                    .accessibilityAddTraits(
                        shell.transferRule == choice.stored ? [.isSelected] : [],
                    )
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("transfer-rule-\(choice.stored)")
                    .accessibilityAddTraits(
                        shell.transferRule == choice.stored ? [.isSelected] : []
                    )
                }
                Spacer(minLength: 0)
            }
            .padding(CentraidGeometry.pageMargin)
            .navigationTitle("Downloads")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
