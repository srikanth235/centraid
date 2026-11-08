import SwiftUI

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

    /// THE LOCK SCREEN (#1173): the lock on a wash of Locker's graphite, the one sentence, what
    /// unlocking does, when it locks itself, and the one ink button in Locker's fill.
    var body: some View {
        let accent = AppAccent("locker")
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                CentraidIconView(iconKey: "Lock", tint: accent.text, size: 28)
                    .frame(width: 64, height: 64)
                    .background(accent.wash(dark: scheme == .dark), in: Circle())
                    .accessibilityHidden(true)
                    .padding(.top, 24)
                Text(wall.title)
                    .kitType(.section)
                    .foregroundStyle(Surface.ink)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("locker-wall-title")
                if !wall.body.isEmpty {
                    Text(wall.body)
                        .kitType(.row)
                        .foregroundStyle(Surface.body)
                }
                if !wall.notice.isEmpty {
                    Text(wall.notice)
                        .kitType(.meta)
                        .foregroundStyle(wall.phase == .failed ? StateColor.red.text : Surface.meta)
                        .accessibilityIdentifier("locker-wall-notice")
                }
                // UNLOCK AND THE WORDS DOOR ARE ALTERNATIVES: one stack.
                if !wall.unlockLabel.isEmpty || !wall.wordsLabel.isEmpty {
                    KitChoiceStack {
                        if !wall.unlockLabel.isEmpty {
                            KitInkButton(label: wall.unlockLabel, iconKey: wall.unlockIcon) {
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
        .environment(\.appAccent, accent)
        .accessibilityIdentifier("locker-wall")
    }
}

/// The existing `locker.lock` state rendered as the wall in a pushed page,
/// matching Android's LockerLockPage. Rust owns the wall, labels and completion.
struct LockerLockPageView: View {
    let state: Centraid_Core_V1_LockerLockState
    let sendWall: (Centraid_Core_V1_LockerWallEvent) -> Void
    let onWords: () -> Void
    let onClose: () -> Void

    var body: some View {
        LockerShield(secure: state.secure) {
            PushedPage(title: "", parentTitle: state.closeLabel, onBack: onClose) {
                EmptyView()
            } content: {
                if state.hasWall {
                    LockerWallView(wall: state.wall, send: sendWall, onWords: onWords)
                }
            }
        }
        .onChange(of: state.finished, initial: true) { _, finished in
            if finished { onClose() }
        }
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
            // EVERY LOCKER PAGE WEARS THE APP'S GRAPHITE, pushed ones included.
            content().environment(\.appAccent, AppAccent("locker"))
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

    @Environment(\.appAccent) private var accent

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                LockerTypeChip(letters: row.typeChip)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .kitType(.row)
                        .foregroundStyle(Surface.ink)
                        .lineLimit(1)
                    if !row.meta.isEmpty {
                        Text(row.meta)
                            .kitType(.meta)
                            .foregroundStyle(Surface.meta)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                ForEach(Array(row.chips.enumerated()), id: \.offset) { _, chip in StatusChipView(chip) }
                if row.starred {
                    // THE STAR WEARS THE APP'S COLOUR: amber only ever means a state.
                    CentraidIconView(iconKey: "Star", tint: accent.text, size: 14)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
            .overlay(alignment: .bottom) { KitHairline().padding(.leading, 58) }
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("locker-row-\(row.itemID)")
    }
}

/// Two letters in the app's graphite, white on its fill.
struct LockerTypeChip: View {
    let letters: String

    @Environment(\.appAccent) private var accent
    /// 32 in a row; the item's hero draws it at 64.
    var side: CGFloat = 32

    var body: some View {
        Text(letters)
            .kitType(side > 40 ? .title : .badge)
            .foregroundStyle(Color.white)
            .frame(width: side, height: side)
            .background(accent.fill, in: RoundedRectangle(cornerRadius: side * CentraidGeometry.iconChipRadiusRatio, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// A ROW OF PILLS: a choice, lit when selected. Tapping sends the choice's key.
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
                .kitType(.meta)
                .foregroundStyle(Surface.meta)
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

/// A WHITE CARD OF ROWS under an optional group head: Starred, Recently used, a category's list.
struct LockerRowGroup: View {
    let title: String
    let rows: [Centraid_Core_V1_LockerRow]
    let open: (Centraid_Core_V1_Route) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !title.isEmpty {
                Text(title).kitType(.group).foregroundStyle(Surface.meta)
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.top, 10)
            }
            VStack(spacing: 0) {
                ForEach(rows, id: \.itemID) { row in
                    LockerRowView(row: row) { open(row.route) }
                }
            }
            .kitCard()
            .clipShape(RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
            .padding(.horizontal, CentraidGeometry.pageMargin)
        }
    }
}

/// ONE CATEGORY CARD: a glyph tile in a list-palette colour, the count, the word.
struct LockerCategoryCard: View {
    let category: Centraid_Core_V1_LockerCategory
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    KitTile(iconKey: category.iconKey, size: 30, fill: AgendaPalette.list(category.colorKey))
                    Spacer(minLength: 0)
                    Text("\(category.count)").kitType(.title).foregroundStyle(Surface.ink)
                }
                Text(category.label).kitType(.row).fontWeight(.semibold).foregroundStyle(Surface.ink)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .kitCard()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(category.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("locker-category-\(category.key)")
    }
}

extension Centraid_Core_V1_LockerCategory: Identifiable {
    public var id: String { key }
}
