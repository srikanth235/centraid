import SwiftUI

/// THE TWO FACTS TRUE ON EVERY ROUTE: which vault, which gateway
/// (#1020, wave A; v0 `screens/home/VaultHeader.tsx`).
///
/// No greeting. **The mark IS the vault switch** — there is no chevron beside
/// it, because a lockup that is not pressable and a control that is are two
/// affordances for one act. The gateway line is mono and says offline IN PLACE,
/// never as a banner: offline is not an incident.
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

    private var line: String {
        let gateway = vault.gatewayName.trimmingCharacters(in: .whitespaces)
        guard !gateway.isEmpty else { return "not connected to a gateway" }
        return vault.offline ? "\(gateway) · offline" : gateway
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
                        Text(line)
                            .centraidType("mono")
                            .foregroundStyle(Theme.color("textFaint", scheme))
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)
            // The label REPLACES the two lines for assistive tech, so a screen
            // reader hears one sentence rather than a name and an orphan line.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(name) on \(line). Switch vault")
            .accessibilityIdentifier("home-vault-switch")

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

    var body: some View {
        HStack(spacing: 8) {
            Text("Home")
                .centraidType("title")
                .foregroundStyle(Theme.color("text", scheme))
            Spacer(minLength: 0)
            CentraidIconView(
                iconKey: "Settings",
                tint: Theme.color("text", scheme),
                size: 22
            )
            .frame(minWidth: 44, minHeight: 44)
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
