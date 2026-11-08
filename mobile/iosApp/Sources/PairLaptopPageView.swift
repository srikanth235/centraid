import SwiftUI

// PAIR WITH A GATEWAY, DRAWN (#1135) — `pair.laptop` as a Rust screen.
//
// **THIS VIEW DECIDES NOTHING.** The phase, every sentence, whether the primary
// is enabled and the safety number to compare arrive in the state. What is the
// view's is what only a platform can do: the paste field's keystrokes. Scan is
// an intent Rust turns into the `ScanCode` effect (`PairScan.swift`); the code
// it reads comes back to Rust, which pairs at once. The code is spent on first
// use and expires, so the screen is not shielded and pasting is allowed.

/// The pairing screen's events, built once.
enum PairLaptopEvents {
    static func make(_ build: (inout Centraid_Core_V1_PairLaptopEvent) -> Void) -> Centraid_Core_V1_PairLaptopEvent {
        var event = Centraid_Core_V1_PairLaptopEvent()
        build(&event)
        return event
    }
}

/// `Centraid_Core_V1_PairLaptopState`: the scan control and the paste field
/// while WAITING or FAILED, a spinner while PAIRING, the safety number to
/// compare once PAIRED, and the door to the words while NEEDS_WORDS.
struct PairLaptopPageView: View {
    let state: Centraid_Core_V1_PairLaptopState
    let send: (Centraid_Core_V1_PairLaptopEvent) -> Void
    let onDone: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        // THE LOOK (PairDevice, PairCheck): the words pages' frame, a round X to leave, a tinted
        // badge over a centred title, and the answers pinned at the foot, a tonal scan over the ink.
        WordsFrame(
            closeLabel: state.secondaryLabel,
            closeIdentifier: "pair-secondary",
            onClose: { send(PairLaptopEvents.make { $0.secondary = .init() }) },
            identifier: "pair-laptop",
            dismissesKeyboard: true
        ) {
            VStack(spacing: 12) {
                CentraidIconView(
                    iconKey: state.safetyGroups.isEmpty ? "Monitor" : "Check",
                    tint: AppAccent.shell.text,
                    size: 28
                )
                .frame(width: 64, height: 64)
                .background(AppAccent.shell.fill.opacity(0.14), in: RoundedRectangle(cornerRadius: Theme.radius("lg", scheme), style: .continuous))
                .accessibilityHidden(true)
                WordsHead(title: state.title, lead: state.body, centered: true)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 12)

            // THE COMMAND TO RUN, drawn as the terminal line it is (PairDevice).
            if !state.command.isEmpty {
                HStack(spacing: 8) {
                    Text("$")
                        .foregroundStyle(Color.white.opacity(0.55))
                        .accessibilityHidden(true)
                    Text(state.command)
                        .foregroundStyle(Color.white)
                }
                .centraidType("mono")
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                        .fill(Color(red: 0.11, green: 0.11, blue: 0.10))
                )
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("pair-command")
            }

            if !state.payloadLabel.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text(state.payloadLabel)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                        .accessibilityHidden(true)
                    MachineTextField(placeholder: "", value: state.payload, axis: .vertical) { text in
                        send(PairLaptopEvents.make { $0.typed = .with { $0.text = text } })
                    }
                    .lineLimit(2...5)
                    .keyboardType(.asciiCapable)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .centraidType("mono")
                    .padding(12)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                            .fill(Surface.card)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                            .strokeBorder(Surface.border, lineWidth: CentraidGeometry.hairline)
                    )
                    .accessibilityLabel(state.payloadLabel)
                    .accessibilityIdentifier("pair-payload")
                }
            }

            if !state.safetyGroups.isEmpty {
                // EVERY DIGIT, IN THE GATEWAY'S OWN GROUPS: the comparison is the member's, so it
                // is drawn to be read, and never shortened. Four groups to a row (PairCheck); the
                // whole number is what a screen reader says.
                VStack(spacing: 8) {
                    if !state.safetyLabel.isEmpty {
                        Text(state.safetyLabel)
                            .centraidType("eyebrow")
                            .foregroundStyle(Theme.color("textFaint", scheme))
                            .accessibilityHidden(true)
                    }
                    let rows = stride(from: 0, to: state.safetyGroups.count, by: 4).map {
                        Array(state.safetyGroups[$0 ..< min($0 + 4, state.safetyGroups.count)])
                    }
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        HStack(spacing: 16) {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, group in
                                Text(group)
                                    .centraidType("title")
                                    .monospacedDigit()
                                    .foregroundStyle(Theme.color("text", scheme))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.6)
                            }
                        }
                    }
                    if !state.safetyHint.isEmpty {
                        Text(state.safetyHint)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 4)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity)
                .background(
                    RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                        .fill(Surface.card)
                )
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(state.safetyNumber)
                .accessibilityIdentifier("pair-safety-number")
            }

            WordsNotice(notice: state.notice)

            if !state.progress.isEmpty {
                KitSpinner(label: state.progress)
                    .accessibilityIdentifier("pair-progress")
            }
        } footer: {
            if !state.scanLabel.isEmpty {
                WordsTonalButton(label: state.scanLabel, iconKey: "Maximize", identifier: "pair-scan") {
                    send(PairLaptopEvents.make { $0.scan = .init() })
                }
            }
            if !state.wordsLabel.isEmpty {
                WordsTonalButton(label: state.wordsLabel, identifier: "pair-words") {
                    send(PairLaptopEvents.make { $0.words = .init() })
                }
            }
            if !state.primaryLabel.isEmpty {
                KitInkButton(label: state.primaryLabel) { send(PairLaptopEvents.make { $0.primary = .init() }) }
                    .disabled(!state.primaryEnabled)
                    .accessibilityIdentifier("pair-primary")
            }
        }
        .onChange(of: state.finished) { _, done in if done { onDone() } }
    }
}
