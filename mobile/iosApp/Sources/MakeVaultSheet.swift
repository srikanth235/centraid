import SwiftUI

/// MAKE A VAULT ON THIS PHONE (#1029 §1).
///
/// The door behind Settings, and what `GatewaySheet` became. A device that
/// holds no vault never reaches it: that is `FirstLaunchView`'s. Named apart from
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
/// Still true, and it is the reason this sheet is two doors and no state.
/// Making a vault opens `words.make` (#1047 E2): whether this phone mints its
/// 24 words, makes the next vault from a seed it already holds, or must
/// restore first is `VaultWordsMachine`'s, and the vault's name is the
/// core's. Restoring opens `words.enter`. A shell that pre-judged either
/// would be a second opinion about a value only the vault can state.
struct MakeVaultSheet: View {
    @ObservedObject var shell: ShellModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var removingSample = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Make a vault") {
                    Button("Make a vault on this phone") { shell.makeVault() }
                        .accessibilityIdentifier("vault-found-button")

                    // BRING THIS MEMBER'S VAULTS BACK from their 24 words. A
                    // fresh install meets this door on `FirstLaunchView`; here
                    // it serves a phone that already holds a vault.
                    Button(ShellWords.wordsRestore) { shell.openRestore() }
                        .accessibilityIdentifier("vault-restore-button")

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

                // THE SAMPLE VAULT'S DOOR (R-SAMPLE-1): remove it while it is
                // held, add a fresh one back when it is not. Removal deletes a
                // vault, so it asks first — the same confirm Home's notice
                // raises.
                Section(ShellWords.sampleMark) {
                    if shell.hasSample {
                        Button(ShellWords.sampleRemove) { removingSample = true }
                            .foregroundStyle(Theme.color("net", scheme))
                            .accessibilityIdentifier("vault-sample-remove")
                    } else if shell.addingSample {
                        // SEEDING: quiet and not tappable, so a second tap
                        // cannot start a second found.
                        Button(ShellWords.sampleAdding) {}
                            .disabled(true)
                            .accessibilityIdentifier("vault-sample-adding")
                    } else {
                        Button(ShellWords.sampleAdd) { shell.addSample() }
                            .accessibilityIdentifier("vault-sample-add")
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
            .sampleRemoveConfirm(isPresented: $removingSample, shell: shell)
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
