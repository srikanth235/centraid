import SwiftUI
import UIKit

// THE BACKUP SCREEN AND THE HOME LINE (#1080, the shells; seam contract §3).
//
// **THESE VIEWS DECIDE NOTHING** (R-1047-K1). Every sentence — the line, each
// reason something waits, each gateway's last word, every control's label —
// arrives in the state; a view that needs one the state does not carry has a
// gap in the machine, never a computation here. What is the view's is what
// only a platform can do: keep the screen awake while "Back up now" runs with
// the screen up, and hand pairing a new gateway to `pair.laptop`'s scanner.
//
// **EVERY PROTO NAME THIS FILE READS IS IN [BackupScreenModel.init],
// [BackupLineView] AND [BackupEvents]** — and `HomeView` reads one more, the
// `backup_line` it hands the line — so reconciling with `screen.proto`'s
// `// --- Backup ---` block (lane D's, A9) is an edit to those places. The
// names are seam contract §3's (`destinations`, `line`, `include_videos`,
// `backing_up_now`, `BackUpNow`, `SetIncludeVideos`, `ForgetDestination`) plus
// the words a view needs and §3 does not name — this lane's assumption, listed
// in the lane E report as E-A5.
//
// The rule control is the member's existing transfer rule, read and written
// through `HomeBridge`'s doors (`ShellModel.transferRule`), so the Home
// header's sheet and this screen are one setting with one store.

/// What the Backup screen draws, copied out of `BackupScreenState`.
struct BackupScreenModel: Equatable {
    struct Destination: Equatable, Identifiable {
        let id: String
        let label: String
        let detail: String
    }

    var title = ""
    /// The line Home draws too: records as of when, how much is confirmed.
    var line = ""
    /// One sentence per reason something waits (Wi-Fi, charger, gateway…).
    var waiting: [String] = []
    var frozen = false
    var destinations: [Destination] = []
    var addLabel = ""
    var forgetLabel = ""
    var ruleLabel = ""
    var videosLabel = ""
    var includeVideos = true
    var backUpNowLabel = ""
    var backingUpNow = false
    var progress = ""

    init() {}

    init(decoding data: Data) {
        let state = (try? Centraid_Screen_V1_BackupScreenState(serializedBytes: data)) ?? .init()
        title = state.title
        line = state.line.sentence
        waiting = state.line.waiting.map(\.sentence).filter { !$0.isEmpty }
        frozen = state.line.frozen
        destinations = state.destinations.map {
            Destination(id: $0.gatewayID, label: $0.label, detail: $0.detail)
        }
        addLabel = state.addDestinationLabel
        forgetLabel = state.forgetLabel
        ruleLabel = state.ruleLabel
        videosLabel = state.includeVideosLabel
        includeVideos = state.includeVideos
        backUpNowLabel = state.backUpNowLabel
        backingUpNow = state.backingUpNow
        progress = state.progress
    }
}

/// Encoded `BackupScreenEvent`s, so a view forwards bytes and never a decision.
enum BackupEvents {
    static func backUpNow() -> Data {
        event { $0.backUpNow = .init() }
    }

    /// A3: the member's words are "include videos"; the core's wire field is
    /// `exclude_videos`, and the negation is the machine's, not the view's.
    static func setIncludeVideos(_ include: Bool) -> Data {
        event { $0.setIncludeVideos = .with { $0.include = include } }
    }

    /// A5: forgetting a gateway drops its row and its confirmations on this
    /// phone; what it already holds stays where it is.
    static func forget(_ gateway: String) -> Data {
        event { $0.forgetDestination = .with { $0.gatewayID = gateway } }
    }

    static func dismissed() -> Data {
        event { $0.dismissed = .init() }
    }

    private static func event(_ build: (inout Centraid_Screen_V1_BackupScreenEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_BackupScreenEvent()
        build(&event)
        return (try? event.serializedBytes()) ?? Data()
    }
}

/// THE HOME LINE: one sentence under the vault, the door to the screen.
///
/// Empty draws nothing: a vault with no gateway paired has no backup to state,
/// and the machine words that case if it wants one said.
struct BackupLineView: View {
    let line: Centraid_Screen_V1_BackupLine
    let onOpen: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if !line.sentence.isEmpty {
            Button(action: onOpen) {
                Text(line.sentence)
                    .centraidType("mono")
                    .foregroundStyle(Theme.color(line.frozen ? "net" : "textFaint", scheme))
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .accessibilityIdentifier("home-backup-line")
        }
    }
}

/// THE BACKUP SCREEN: where the backup stands, the three controls, and the
/// gateways this phone backs up to.
struct BackupView: View {
    let data: Data
    @ObservedObject var shell: ShellModel
    let send: (Data) -> Void
    /// Pairing another gateway is `pair.laptop`'s scan or paste.
    let onAddDestination: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let model = BackupScreenModel(decoding: data)
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                WordsHead(title: model.title, lead: model.line)

                ForEach(model.waiting, id: \.self) { reason in
                    Text(reason)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                        .fixedSize(horizontal: false, vertical: true)
                }

                // BACK UP NOW. Offered while nothing runs; while it runs, the
                // machine's progress sentence stands in its place.
                if !model.backUpNowLabel.isEmpty, !model.frozen, !model.backingUpNow {
                    KitInkButton(label: model.backUpNowLabel) { send(BackupEvents.backUpNow()) }
                        .accessibilityIdentifier("backup-now")
                }
                if model.backingUpNow, !model.progress.isEmpty {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text(model.progress)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("backup-progress")
                }

                destinations(model)

                rule(model)

                if !model.videosLabel.isEmpty {
                    Toggle(isOn: Binding(
                        get: { model.includeVideos },
                        set: { send(BackupEvents.setIncludeVideos($0)) }
                    )) {
                        Text(model.videosLabel)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("text", scheme))
                    }
                    .tint(Theme.color("link", scheme))
                    .accessibilityIdentifier("backup-include-videos")
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.color("bg", scheme).ignoresSafeArea())
        .accessibilityIdentifier("backup-screen")
        // THE SCREEN STAYS AWAKE WHILE "BACK UP NOW" RUNS WITH IT UP (#1080):
        // a phone that locks suspends the pass, and a member who asked for it
        // and is watching it is owed the minutes it takes.
        .onAppear { Self.keepAwake(model.backingUpNow) }
        .onChange(of: model.backingUpNow) { _, running in Self.keepAwake(running) }
        .onDisappear { Self.keepAwake(false) }
    }

    @ViewBuilder
    private func destinations(_ model: BackupScreenModel) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(model.destinations) { row in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.label)
                            .centraidType("smallStrong")
                            .foregroundStyle(Theme.color("text", scheme))
                        if !row.detail.isEmpty {
                            Text(row.detail)
                                .centraidType("mono")
                                .foregroundStyle(Theme.color("textFaint", scheme))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Spacer(minLength: 0)
                    // FORGET IS PLAIN AND VISIBLE, and needs no confirmation:
                    // it forgets this phone's pairing and nothing the gateway
                    // holds, and pairing again undoes it.
                    if !model.forgetLabel.isEmpty {
                        Button(model.forgetLabel) { send(BackupEvents.forget(row.id)) }
                            .centraidType("control")
                            .tint(Theme.color("link", scheme))
                            .buttonStyle(.borderless)
                            .accessibilityLabel("\(model.forgetLabel) \(row.label)")
                            .accessibilityIdentifier("backup-forget-\(row.id)")
                    }
                }
                .padding(.vertical, 10)
                .accessibilityElement(children: .contain)
                // THE PAGE IS ALREADY INSET, so the rule is the plain hairline
                // and not `KitHairline`, which insets again.
                Rectangle()
                    .fill(Theme.color("line", scheme))
                    .frame(height: CentraidGeometry.hairline)
            }
            if !model.addLabel.isEmpty {
                KitOutlineButton(label: model.addLabel, action: onAddDestination)
                    .padding(.top, 12)
                    .accessibilityIdentifier("backup-add-destination")
            }
        }
    }

    /// THE MEMBER'S RULE, the same three sentences the Home header's sheet
    /// draws, from the same store.
    @ViewBuilder
    private func rule(_ model: BackupScreenModel) -> some View {
        if !shell.transferRuleChoices.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                if !model.ruleLabel.isEmpty {
                    Text(model.ruleLabel)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                }
                ForEach(shell.transferRuleChoices, id: \.stored) { choice in
                    let picked = shell.transferRule == choice.stored
                    Button {
                        shell.setTransferRule(choice.stored)
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(systemName: picked ? "largecircle.fill.circle" : "circle")
                                .accessibilityHidden(true)
                            Text(choice.sentence)
                                .centraidType("small")
                                .foregroundStyle(Theme.color("text", scheme))
                                .multilineTextAlignment(.leading)
                            Spacer(minLength: 0)
                        }
                        .frame(minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(picked ? [.isSelected] : [])
                    .accessibilityIdentifier("backup-rule-\(choice.stored)")
                }
            }
        }
    }

    private static func keepAwake(_ awake: Bool) {
        UIApplication.shared.isIdleTimerDisabled = awake
    }
}
