import SwiftUI

// THE BACKUP SCREEN AND THE HOME LINE (#1080, the shells; seam contract A11).
//
// **THESE VIEWS DECIDE NOTHING** (R-1047-K1). Every sentence — the line and
// its detail, each reason something waits, each gateway's last word, every
// control's label, what the last act did, why the phone will not wake
// Centraid — arrives in the state, and so do the line's tone and whether
// "Back up now" may be pressed. A view that needs one the state does not
// carry has a gap in the machine, never a computation here. What is the
// view's is what only a platform can do: hand pairing a new gateway to
// `pair.laptop`'s scanner. The screen stays awake for a run through the
// core's own `backlog` hook (`IosBackgroundTasks`), so leaving this screen
// mid-run does not let the phone lock on it.
//
// **EVERY PROTO NAME THIS FILE READS IS IN [BackupScreenModel.init],
// [BackupLineView] AND [BackupEvents]** — and `HomeView` reads one more, the
// `backup_line` it hands the line — so a change to `screen.proto`'s
// `// --- Backup ---` block is an edit to those places. The Android twin is
// `BackupScreens.kt`; the two read the same names.
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
        /// "Laptop. 192.168.1.20:7443 · Reached 2 minutes ago".
        let accessibilityLabel: String
    }

    var title = ""
    /// The line Home draws too, and its second clause.
    var line = ""
    var lineDetail = ""
    /// One sentence per reason something waits (Wi-Fi, charger, gateway…).
    var waiting: [String] = []
    /// Why the phone will not wake Centraid in the background, or empty.
    var backgroundNotice = ""
    /// What the last act did, or why it could not: one clause, never a toast.
    var notice = ""
    var destinations: [Destination] = []
    var addLabel = ""
    var forgetLabel = ""
    var ruleLabel = ""
    var videosLabel = ""
    var includeVideos = true
    var backUpNowLabel = ""
    /// The machine's verdict: a gateway to back up to, a vault that has not
    /// moved, and no run already going.
    var backUpNowEnabled = false
    /// Non-empty only while a run is in progress.
    var progress = ""

    init() {}

    init(decoding data: Data) {
        let state = (try? Centraid_Screen_V1_BackupScreenState(serializedBytes: data)) ?? .init()
        title = state.title
        line = state.line.sentence
        lineDetail = state.line.detail
        waiting = state.line.waiting.map(\.sentence).filter { !$0.isEmpty }
        backgroundNotice = state.backgroundNotice
        notice = state.notice
        destinations = state.destinations.map {
            Destination(
                id: $0.gatewayID,
                label: $0.label,
                detail: $0.detail,
                accessibilityLabel: $0.accessibilityLabel
            )
        }
        addLabel = state.addDestinationLabel
        forgetLabel = state.forgetLabel
        ruleLabel = state.ruleLabel
        videosLabel = state.includeVideosLabel
        includeVideos = state.includeVideos
        backUpNowLabel = state.backUpNowLabel
        backUpNowEnabled = state.backUpNowEnabled
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

/// THE HOME LINE: one sentence under the vault, its second clause, and the
/// door to the screen. Empty draws nothing.
///
/// The tone is drawn the way Home's status ribbon draws its own: a quiet line
/// is ignorable and earns no rule; one that wants the member gets one rule in
/// the tone's colour, never a filled plate.
struct BackupLineView: View {
    let line: Centraid_Screen_V1_BackupLine
    let onOpen: () -> Void
    @Environment(\.colorScheme) private var scheme

    private var loud: Bool { line.tone == .attention || line.tone == .urgent }

    var body: some View {
        if !line.sentence.isEmpty {
            Button(action: onOpen) {
                HStack(spacing: 8) {
                    if loud {
                        Rectangle()
                            .fill(Theme.color(line.tone == .urgent ? "danger" : "attention", scheme))
                            .frame(width: 2, height: 24)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(line.sentence)
                            .centraidType(loud ? "small" : "mono")
                            .foregroundStyle(Theme.color(loud ? "text" : "textFaint", scheme))
                            .lineLimit(2)
                        if !line.detail.isEmpty {
                            Text(line.detail)
                                .centraidType("mono")
                                .foregroundStyle(Theme.color("textFaint", scheme))
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, CentraidGeometry.pageMargin)
            // THE LINE READ ALOUD is the machine's: sentence, detail, then
            // what waits.
            .accessibilityLabel(line.accessibilityLabel.isEmpty ? line.sentence : line.accessibilityLabel)
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

                if !model.lineDetail.isEmpty {
                    sentence(model.lineDetail)
                }
                ForEach(model.waiting, id: \.self) { reason in
                    sentence(reason)
                }
                // WHY THE PHONE WILL NOT WAKE CENTRAID, when it will not: a
                // reason the backup waits for the app to be opened.
                if !model.backgroundNotice.isEmpty {
                    sentence(model.backgroundNotice, id: "backup-background-notice")
                }

                // BACK UP NOW, pressable when the machine says so — the
                // shared primary control's dimmed form otherwise. While a run
                // goes, its progress sentence stands beside it.
                if !model.backUpNowLabel.isEmpty {
                    KitInkButton(label: model.backUpNowLabel) { send(BackupEvents.backUpNow()) }
                        .disabled(!model.backUpNowEnabled)
                        .opacity(model.backUpNowEnabled ? 1 : 0.4)
                        .accessibilityIdentifier("backup-now")
                }
                if !model.progress.isEmpty {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text(model.progress)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("backup-progress")
                }
                // WHAT THE LAST ACT DID, in place: one clause, never a toast.
                if !model.notice.isEmpty {
                    sentence(model.notice, id: "backup-notice")
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
    }

    /// One of the machine's sentences, drawn quietly.
    @ViewBuilder
    private func sentence(_ text: String, id: String? = nil) -> some View {
        let drawn = Text(text)
            .centraidType("small")
            .foregroundStyle(Theme.color("textSoft", scheme))
            .fixedSize(horizontal: false, vertical: true)
        if let id {
            drawn.accessibilityIdentifier(id)
        } else {
            drawn
        }
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
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(row.accessibilityLabel.isEmpty ? row.label : row.accessibilityLabel)
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
}
