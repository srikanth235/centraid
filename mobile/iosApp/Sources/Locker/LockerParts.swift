import SwiftUI
import UIKit
import UniformTypeIdentifiers

#if canImport(CentraidShared)
import CentraidShared
#endif

// LOCKER'S SHARED PARTS (#1047): the wall, the covered page, the item row,
// the choice pills and the clipboard. Every word is the machines'.

extension Centraid_Screen_V1_LockerLockState {
    /// DRAW THE WALL. Bytes that have not arrived yet decode as UNSPECIFIED,
    /// and a Locker that has not heard its gate fails CLOSED: nothing of it is
    /// drawn before the machine says the Locker is open.
    var covers: Bool { cover || phase == .unspecified }

    static func of(_ data: Data) -> Self {
        (try? Self(serializedBytes: data)) ?? .init()
    }
}

/// THE LOCK WALL (`LockerLockState`): the title, what unlocking does, the
/// notice a failed or unavailable phase says, the one ink button that asks
/// the OS, and what a session is. Nothing of Locker is drawn under it.
struct LockerWall: View {
    let lock: Centraid_Screen_V1_LockerLockState
    let sendLock: (Data) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                CentraidIconView(iconKey: "Lock", tint: Theme.color("text", scheme), size: 28)
                    .accessibilityHidden(true)
                    .padding(.top, 24)
                Text(lock.title)
                    .centraidType("title")
                    .foregroundStyle(Theme.color("text", scheme))
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("locker-wall-title")
                if !lock.body.isEmpty {
                    Text(lock.body)
                        .centraidType("body")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
                if !lock.notice.isEmpty {
                    Text(lock.notice)
                        .centraidType("small")
                        .foregroundStyle(Theme.color(lock.phase == .failed ? "net" : "textSoft", scheme))
                        .accessibilityIdentifier("locker-wall-notice")
                }
                if !lock.unlockLabel.isEmpty {
                    KitInkButton(label: lock.unlockLabel) {
                        sendLock(LockerLockSeam.event { $0.unlock = .init() })
                    }
                    .accessibilityIdentifier("locker-unlock")
                    .padding(.top, 4)
                }
                // THE KEY IS NOT ON THIS PHONE: "Enter your 24 words", the
                // intent the shell routes to words.enter (#1047 E2).
                if !lock.wordsLabel.isEmpty {
                    KitInkButton(label: lock.wordsLabel) {
                        sendLock(LockerLockSeam.event { $0.words = .init() })
                    }
                    .accessibilityIdentifier("locker-words")
                    .padding(.top, 4)
                }
                if !lock.facts.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(Array(lock.facts.enumerated()), id: \.offset) { _, fact in
                            FieldRow(key: fact.label, value: fact.detail)
                                .padding(.horizontal, -CentraidGeometry.pageMargin)
                        }
                    }
                    .padding(.top, 12)
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("locker-wall")
    }
}

/// A PUSHED LOCKER PAGE, COVERED while the Locker is locked: the wall in a
/// page whose back returns to where the member came from. Unlocked, the page.
struct LockerCovered<Content: View>: View {
    let lock: Data
    let sendLock: (Data) -> Void
    let onBack: () -> Void
    let content: () -> Content

    init(lock: Data, sendLock: @escaping (Data) -> Void, onBack: @escaping () -> Void, @ViewBuilder content: @escaping () -> Content) {
        self.lock = lock
        self.sendLock = sendLock
        self.onBack = onBack
        self.content = content
    }

    var body: some View {
        let state = Centraid_Screen_V1_LockerLockState.of(lock)
        if state.covers {
            PushedPage(title: "", parentTitle: LockerWords.appName, onBack: onBack) {
                EmptyView()
            } content: {
                LockerWall(lock: state, sendLock: sendLock)
            }
        } else {
            content()
        }
    }
}

/// THE CAPTURE SHIELD FOR AN OPEN LOCKER (#1047, D-10): `LockerLockState.secure`,
/// set by the gate exactly while UNLOCKED, drawn with the words screens' own
/// `WordsShield` — the content in a secure canvas screenshots and recordings
/// leave out, and covered while the screen is captured or the scene is not
/// active, so the app-switcher snapshot holds no item. The view decides
/// nothing of when; the relock clears `secure` and the wall replaces the page.
///
/// It wraps a page's CONTENT or a sheet's room, never navigation chrome or a
/// presentation: the canvas hosts its content in a controller of its own,
/// which a toolbar or a sheet's detents cannot reach through. So a shielded
/// sheet states its `SheetPresentation` again outside the shield, the kit's
/// trash takes `secure` and shields its own list, and an item page leaves its
/// name out of the navigation bar while `secure` (its header draws it inside).
/// What stays outside is the app's own words — the bar's title and back
/// label — and the root switcher mask (`CentraidApp`) covers those.
struct LockerShield<Content: View>: View {
    let lock: Data
    @ViewBuilder let content: () -> Content

    var body: some View {
        WordsShield(secure: Centraid_Screen_V1_LockerLockState.of(lock).secure, content: content)
    }
}

/// The app's name, from its copy table — the covered page's back word, where
/// the wiped screen under the wall has no title left to name.
enum LockerWords {
    static var appName: String {
        #if canImport(CentraidShared)
        LockerCopy.shared.APP_NAME
        #else
        ""
        #endif
    }
}

/// THE ITEM ROW (the handoff's): the two-letter type chip on the rose wash,
/// the title, the secret-free meta, a star, the chips. Never a secret.
struct LockerRowView: View {
    let row: Centraid_Screen_V1_LockerRow
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
                ForEach(Array(row.chips.enumerated()), id: \.offset) { _, chip in StatusChipView(chip) }
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

/// A ROW OF PILLS: a choice, lit when selected, its detail (a count) beside
/// the label. Tapping sends the choice's key.
struct LockerChoicePills: View {
    let choices: [Centraid_Screen_V1_LockerChoice]
    var identifier: String = "locker-choice"
    let onPick: (String) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(choices, id: \.key) { choice in
                    Button { onPick(choice.key) } label: {
                        HStack(spacing: 4) {
                            Text(choice.label)
                                .centraidType("smallStrong")
                            if !choice.detail.isEmpty {
                                Text(choice.detail)
                                    .centraidType("annotLabel")
                                    .monospacedDigit()
                            }
                        }
                        .foregroundStyle(Theme.color(choice.selected ? "textInv" : "text", scheme))
                        .padding(.horizontal, 12)
                        .frame(minHeight: CentraidGeometry.targetMinFine)
                        .background(Capsule().fill(choice.selected ? Theme.color("text", scheme) : Color.clear))
                        .overlay(Capsule().strokeBorder(Theme.color(choice.selected ? "text" : "lineStrong", scheme), lineWidth: CentraidGeometry.hairline))
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(choice.selected ? .isSelected : [])
                    .accessibilityIdentifier("\(identifier)-\(choice.key)")
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
        }
    }
}

/// THE CLIPBOARD, PERFORMED (`LockerClipboard`): a sensitive value goes on
/// LOCAL-ONLY and EXPIRING — never to Universal Clipboard, gone by itself —
/// then the screen hears `ClipboardDone`. A plain value is plain metadata.
enum LockerClipboardSeam {
    /// The pasteboard's `changeCount` just after Locker's last copy, or nil:
    /// a different count means somebody copied since, and that is theirs.
    @MainActor private static var ours: Int?

    @MainActor static func perform(_ clip: Centraid_Screen_V1_LockerClipboard) {
        defer { ours = UIPasteboard.general.changeCount }
        guard clip.sensitive else {
            UIPasteboard.general.string = clip.value
            return
        }
        var options: [UIPasteboard.OptionsKey: Any] = [.localOnly: true]
        if clip.expiresInMs > 0 {
            options[.expirationDate] = Date().addingTimeInterval(TimeInterval(clip.expiresInMs) / 1000)
        }
        UIPasteboard.general.setItems([[UTType.plainText.identifier: clip.value]], options: options)
    }

    /// THE WALL'S `clipboardClear` (the member locked): Locker's last copy
    /// comes off the pasteboard, only if it is still the one there.
    @MainActor static func clearOwn() {
        guard let count = ours else { return }
        ours = nil
        if UIPasteboard.general.changeCount == count {
            UIPasteboard.general.setItems([], options: [:])
        }
    }
}

/// Runs a screen's clipboard once per token, then says so.
struct LockerClipboardRunner: ViewModifier {
    let clip: Centraid_Screen_V1_LockerClipboard?
    let done: (UInt64) -> Void

    @State private var performed: UInt64 = 0

    func body(content: Content) -> some View {
        content
            .onAppear(perform: run)
            .onChange(of: clip?.token ?? 0) { _, _ in run() }
    }

    private func run() {
        guard let clip, clip.token != 0, clip.token != performed else { return }
        performed = clip.token
        LockerClipboardSeam.perform(clip)
        done(clip.token)
    }
}
