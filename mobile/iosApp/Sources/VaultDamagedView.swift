import SwiftUI

/// THE LAUNCH SCREEN FOR A DAMAGED VAULT (#1191, row B16). `centraid_open` answered
/// `CENTRAID_VAULT_DAMAGED`, so there is no core and no Rust screen to draw this: the words are the
/// Backup screen's own sentences, carried in `KitWords` (generated from the Rust catalogue by
/// `cargo xtask design`), and nothing here words or decides anything. The board is
/// `design/mockups/BackupVaultDamagedOpen.dc.html`.
struct VaultDamagedView: View {
    @Environment(\.colorScheme) private var scheme
    @ScaledMetric(relativeTo: .title) private var titleSize = 24
    @ScaledMetric(relativeTo: .body) private var bodySize = CentraidScale.rowSize

    var body: some View {
        ZStack {
            Theme.color("bg", scheme).ignoresSafeArea()
            ScrollView {
                VStack(spacing: 12) {
                    CentraidIconView(iconKey: "AlertCircle", tint: Color(CentraidAsset.textInk), size: 32)
                        .accessibilityHidden(true)
                    Text(KitWords.VAULT_DAMAGED_TITLE)
                        .font(.system(size: titleSize, weight: .bold))
                        .foregroundStyle(Color(CentraidAsset.textInk))
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("vault-damaged-title")
                    Text(KitWords.VAULT_DAMAGED_LINE)
                        .font(.system(size: bodySize))
                        .foregroundStyle(Color(CentraidAsset.textMeta))
                        .accessibilityIdentifier("vault-damaged-line")
                    Text(KitWords.VAULT_DAMAGED_SAFE)
                        .font(.system(size: bodySize))
                        .foregroundStyle(Color(CentraidAsset.textInk))
                        .accessibilityIdentifier("vault-damaged-safe")
                    KitPillButton(label: KitWords.VAULT_DAMAGED_RESTORE, action: reopenForRestore)
                        .accessibilityIdentifier("vault-damaged-restore")
                        .padding(.top, 12)
                }
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
                .frame(maxWidth: .infinity, minHeight: 600)
            }
        }
    }
}

/// REOPEN FOR RESTORE: the single place the core's "open without the damaged vault" key goes.
/// The core session owns that key (decision 35); until it lands the button does nothing.
private func reopenForRestore() {}
