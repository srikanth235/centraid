import SwiftUI

import CentraidShared

// LOCKER'S SHARED PARTS (#1047, #1135): the wall, the item row, the choice
// pills and the quiet note. Every word is Rust's (`crates/screens/src/locker`).

/// The wall's events, built once: Unlock and the member's own Lock.
enum LockerWallEvents {
    static func make(_ build: (inout Centraid_Core_V1_LockerWallEvent) -> Void) -> Centraid_Core_V1_LockerWallEvent {
        var event = Centraid_Core_V1_LockerWallEvent()
        build(&event)
        return event
    }
}

/// THE LOCK WALL (`LockerWall`): the title, what unlocking does, the notice a
/// failed or unavailable phase says, the one ink button that asks the OS, and
/// the way to the recovery words when this phone lacks the key. Nothing of
/// Locker is drawn under it.
struct LockerWallView: View {
    let wall: Centraid_Core_V1_LockerWall
    let send: (Centraid_Core_V1_LockerWallEvent) -> Void
    /// "Enter your recovery key": the shell's custody flow (`words.enter` for a re-key).
    let onWords: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                CentraidIconView(iconKey: "Lock", tint: Theme.color("text", scheme), size: 28)
                    .accessibilityHidden(true)
                    .padding(.top, 24)
                Text(wall.title)
                    .centraidType("title")
                    .foregroundStyle(Theme.color("text", scheme))
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("locker-wall-title")
                if !wall.body.isEmpty {
                    Text(wall.body)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
                if !wall.notice.isEmpty {
                    Text(wall.notice)
                        .centraidType("small")
                        .foregroundStyle(Theme.color(wall.phase == .failed ? "net" : "textSoft", scheme))
                        .accessibilityIdentifier("locker-wall-notice")
                }
                // UNLOCK AND THE WORDS DOOR ARE ALTERNATIVES: one stack.
                if !wall.unlockLabel.isEmpty || !wall.wordsLabel.isEmpty {
                    KitChoiceStack {
                        if !wall.unlockLabel.isEmpty {
                            KitInkButton(label: wall.unlockLabel) {
                                send(LockerWallEvents.make { $0.unlock = .init() })
                            }
                            .accessibilityIdentifier("locker-unlock")
                        }
                        // ONE INK PER VIEW: Unlock is the thing to do; the words
                        // verb is the ink only when it stands alone.
                        if !wall.wordsLabel.isEmpty {
                            if wall.unlockLabel.isEmpty {
                                KitInkButton(label: wall.wordsLabel, action: onWords)
                                    .accessibilityIdentifier("locker-words")
                            } else {
                                KitOutlineButton(label: wall.wordsLabel, action: onWords)
                                    .accessibilityIdentifier("locker-words")
                            }
                        }
                    }
                    .padding(.top, 4)
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("locker-wall")
    }
}

/// A PUSHED LOCKER PAGE, COVERED while the Locker is locked: the wall in a page
/// whose back returns to where the member came from. Unlocked, the page.
struct LockerCovered<Content: View>: View {
    let wall: Centraid_Core_V1_LockerWall?
    let backLabel: String
    let send: (Centraid_Core_V1_LockerWallEvent) -> Void
    let onWords: () -> Void
    let onBack: () -> Void
    let content: () -> Content

    init(
        wall: Centraid_Core_V1_LockerWall?,
        backLabel: String,
        send: @escaping (Centraid_Core_V1_LockerWallEvent) -> Void,
        onWords: @escaping () -> Void,
        onBack: @escaping () -> Void,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.wall = wall
        self.backLabel = backLabel
        self.send = send
        self.onWords = onWords
        self.onBack = onBack
        self.content = content
    }

    var body: some View {
        if let wall {
            PushedPage(title: "", parentTitle: backLabel, onBack: onBack) {
                EmptyView()
            } content: {
                LockerWallView(wall: wall, send: send, onWords: onWords)
            }
        } else {
            content()
        }
    }
}

/// THE CAPTURE SHIELD FOR AN OPEN LOCKER (#1047, D-10): `secure` is Rust's,
/// set exactly while the Locker is open, drawn with the words screens' own
/// `WordsShield` — the content in a secure canvas screenshots and recordings
/// leave out, and covered while the screen is captured or the scene is not
/// active. The view decides nothing of when; a relock clears `secure` and the
/// wall replaces the page.
struct LockerShield<Content: View>: View {
    let secure: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        WordsShield(secure: secure, content: content)
    }
}

/// THE ITEM ROW (the handoff's): the two-letter type chip on the rose wash, the
/// title, the secret-free meta, a star, the chips. Never a secret. A tap opens
/// the route Rust put on the row.
struct LockerRowView: View {
    let row: Centraid_Core_V1_LockerRow
    let onTap: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                LockerTypeChip(letters: row.typeChip)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                    if !row.meta.isEmpty {
                        Text(row.meta)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                ForEach(Array(row.chips.enumerated()), id: \.offset) { _, chip in StatusChipView(chip.legacy) }
                if row.starred {
                    CentraidIconView(iconKey: "Star", tint: Theme.color("textSoft", scheme), size: 14)
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
            .overlay(alignment: .bottom) { KitHairline() }
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("locker-row-\(row.itemID)")
    }
}

/// Two letters on the app's rose wash.
struct LockerTypeChip: View {
    let letters: String

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Text(letters)
            .centraidType("annotLabelOn")
            .foregroundStyle(Theme.color("cRose", scheme))
            .frame(width: 32, height: 32)
            .background(
                RoundedRectangle(cornerRadius: Theme.radius("sm", scheme))
                    .fill(Theme.color("cRose", scheme).opacity(scheme == .dark ? CentraidGeometry.iconChipTintDark : CentraidGeometry.iconChipTintLight))
            )
            .accessibilityHidden(true)
    }
}

/// A ROW OF PILLS: a choice, lit when selected, its detail (a count) beside the
/// label. Tapping sends the choice's key.
struct LockerChoicePills: View {
    let choices: [Centraid_Core_V1_LockerChoice]
    var identifier: String = "locker-choice"
    let onPick: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(choices, id: \.key) { choice in
                    KitChip(
                        label: choice.label,
                        count: choice.detail,
                        selected: choice.selected,
                        identifier: "\(identifier)-\(choice.key)"
                    ) {
                        onPick(choice.key)
                    }
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
        }
    }
}

/// One quiet line of Rust's — a status, a note, a window's end.
struct LockerNote: View {
    let text: String

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if !text.isEmpty {
            Text(text)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.vertical, 8)
        }
    }
}

/// A ONE-TIME CODE'S LIFE (Q-1047-16): a small ring that empties as the step
/// runs out. The seconds are also in the row's note, so the ring is decoration
/// and hidden from VoiceOver.
struct LockerCountdownRing: View {
    let countdown: Centraid_Core_V1_LockerCountdown

    @Environment(\.colorScheme) private var scheme

    private var fraction: Double {
        guard countdown.period > 0 else { return 0 }
        return min(1, Double(countdown.secondsLeft) / Double(countdown.period))
    }

    var body: some View {
        ZStack {
            Circle()
                .stroke(Theme.color("line", scheme), lineWidth: 2)
            Circle()
                .trim(from: 0, to: fraction)
                .stroke(Theme.color(countdown.secondsLeft <= 5 ? "net" : "textSoft", scheme), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.linear(duration: 1), value: fraction)
        }
        .frame(width: 14, height: 14)
        .accessibilityHidden(true)
        .accessibilityIdentifier("locker-code-countdown")
    }
}

/// The content of a Locker view state's `oneof content`, as the kit's read states take it.
func lockerContent<Value>(
    loading: Bool,
    failure: Centraid_Core_V1_Failure?,
    denied: Centraid_Core_V1_Denied?,
    data: Value?
) -> ScreenContent<Value> {
    if let data { return .data(data) }
    if let failure { return .failed(failure) }
    if let denied { return .gated(denied) }
    return .loading(true)
}
