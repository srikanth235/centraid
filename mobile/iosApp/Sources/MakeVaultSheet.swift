import SwiftUI

/// MAKE A VAULT ON THIS PHONE (#1029 §1).
///
/// The door behind Settings, and what `GatewaySheet` became. Named apart from
/// `HomeView`'s own private `VaultSheet`, which is the SWITCHER: one lists the
/// vaults this device holds, this one adds to them.
///
/// ## What it was, and why none of it survives
///
/// It was "connect this device to a gateway": a field to paste a pairing ticket
/// into, a "Pair this device" button, a "Sync now" button and the sentence
/// either produced. The ticket had no camera behind it on purpose — the
/// simulator has none and the scenarios this shell had to be testable against
/// all ran there — and `HomeSession.pair` judged nothing locally because only a
/// gateway could judge a ticket.
///
/// **The phone is the vault.** There is no ticket to paste, no gateway to
/// redeem it against and no pass to run, so all three controls are gone and one
/// takes their place: found a vault here.
///
/// ## Nothing here decides anything
///
/// Still true, and it is the reason this sheet is three controls and no state.
/// Whether a vault can be founded, and what it ends up called, are
/// `HomeSession.found` and, under it, the core. A shell that pre-judged either
/// would be a second opinion about a value only the vault can state.
struct MakeVaultSheet: View {
    @ObservedObject var shell: ShellModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    @State private var working = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Make a vault") {
                    Button(working ? "Making…" : "Make a vault on this phone") {
                        working = true
                        shell.found { working = false }
                    }
                    .disabled(working)
                    .accessibilityIdentifier("vault-found-button")

                    // THE LAST OUTCOME, IN A MEMBER'S WORDS. Never a hash,
                    // never a path, never a peer's error text — `gatewayStatus`
                    // carries only what the core already decided was showable.
                    if !shell.gatewayStatus.isEmpty {
                        Text(shell.gatewayStatus)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .accessibilityIdentifier("vault-status")
                    }
                }

                // THE TRANSFER RULES, ALWAYS REACHABLE (#1025 S4).
                //
                // The header's "N originals waiting for Wi-Fi" line is the
                // CONTEXTUAL door and cannot be the only one: on a device where
                // nothing is being withheld the line is empty, so a member who
                // wants to CHANGE the rule before it ever bites — set `manual`
                // on a new phone, say — would have no way in. A setting whose
                // only door appears once the setting has already cost
                // something is a setting a member cannot choose in advance.
                Section("Downloads") {
                    Button("Download settings") { shell.openTransferRules() }
                        .accessibilityIdentifier("vault-transfer-rules")
                }
            }
            .navigationTitle("Vault")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("vault-done")
                }
            }
        }
    }
}
