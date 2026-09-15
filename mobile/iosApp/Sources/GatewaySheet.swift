import SwiftUI

/// CONNECT THIS DEVICE TO A GATEWAY (#1020, D-1020-B7).
///
/// The door behind Settings, and the first screen in this shell that makes the
/// device do something on a network rather than read a file that was placed on
/// it.
///
/// ## Why a field and not a camera
///
/// A pairing ticket is a QR code and a phone has a camera, so the field looks
/// like a stand-in. It is not: the **simulator has no camera**, and the
/// scenarios this shell has to be testable against — pair, go offline, wait,
/// come back — all run there. `AVFoundation` capture is the right production
/// path and it belongs behind the same one call this makes; what it cannot do
/// is be exercised without a device in someone's hand.
///
/// ## Nothing here decides anything
///
/// The sheet holds a string and two buttons. Whether a ticket is valid, whether
/// the gateway answered, whether it expired — all of that is `HomeSession.pair`
/// and, under it, `Handle::pair`. A shell that pre-validated a ticket would be
/// a second opinion about a value only a gateway can judge.
struct GatewaySheet: View {
    @ObservedObject var shell: ShellModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    @State private var ticket = ""
    @State private var working = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Pair with a gateway") {
                    TextField("Pairing code", text: $ticket, axis: .vertical)
                        .lineLimit(2...4)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.footnote, design: .monospaced))
                        .accessibilityIdentifier("gateway-ticket-field")
                    Button(working ? "Pairing…" : "Pair this device") {
                        working = true
                        shell.pair(ticket: ticket) { working = false }
                    }
                    .disabled(ticket.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || working)
                    .accessibilityIdentifier("gateway-pair-button")
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
                        .accessibilityIdentifier("gateway-transfer-rules")
                }

                Section("Sync") {
                    Button(working ? "Syncing…" : "Sync now") {
                        working = true
                        shell.syncNow { working = false }
                    }
                    .disabled(working)
                    .accessibilityIdentifier("gateway-sync-button")

                    // THE LAST OUTCOME, IN A MEMBER'S WORDS. Never a hash,
                    // never a path, never a peer's error text — `gatewayStatus`
                    // carries only what the core already decided was showable.
                    if !shell.gatewayStatus.isEmpty {
                        Text(shell.gatewayStatus)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .accessibilityIdentifier("gateway-status")
                    }
                }
            }
            .navigationTitle("Gateway")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("gateway-done")
                }
            }
        }
    }
}
