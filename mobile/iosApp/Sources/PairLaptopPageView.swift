import SwiftUI

import CentraidShared

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
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                WordsHead(title: state.title, lead: state.body)

                if !state.scanLabel.isEmpty {
                    KitOutlineButton(label: state.scanLabel) {
                        send(PairLaptopEvents.make { $0.scan = .init() })
                    }
                    .accessibilityIdentifier("pair-scan")
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
                        .padding(10)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                                .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
                        )
                        .accessibilityLabel(state.payloadLabel)
                        .accessibilityIdentifier("pair-payload")
                    }
                }

                if !state.safetyNumber.isEmpty {
                    // EVERY DIGIT, IN THE GATEWAY'S OWN GROUPS: the comparison is
                    // the member's, so it is drawn to be read, and never shortened.
                    Text(state.safetyNumber)
                        .centraidType("mono")
                        .foregroundStyle(Theme.color("text", scheme))
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                                .fill(Theme.color("bgSunken", scheme))
                        )
                        .accessibilityIdentifier("pair-safety-number")
                }

                WordsNotice(notice: state.notice)

                if !state.progress.isEmpty {
                    KitSpinner(label: state.progress)
                        .accessibilityIdentifier("pair-progress")
                }

                // THE WORDS DOOR AND THE PRIMARY ARE ALTERNATIVES: one stack.
                KitChoiceStack {
                    WordsControls(
                        primary: state.primaryLabel,
                        primaryEnabled: state.primaryEnabled,
                        secondary: state.secondaryLabel,
                        prefix: "pair",
                        onPrimary: { send(PairLaptopEvents.make { $0.primary = .init() }) },
                        onSecondary: { send(PairLaptopEvents.make { $0.secondary = .init() }) }
                    )
                    if !state.wordsLabel.isEmpty {
                        KitOutlineButton(label: state.wordsLabel) {
                            send(PairLaptopEvents.make { $0.words = .init() })
                        }
                        .accessibilityIdentifier("pair-words")
                    }
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.color("bg", scheme).ignoresSafeArea())
        .accessibilityIdentifier("pair-laptop")
        .onChange(of: state.finished) { _, done in if done { onDone() } }
    }
}
