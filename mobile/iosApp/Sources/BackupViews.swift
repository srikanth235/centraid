import SwiftUI

// THE BACKUP SCREEN (#1080, the shells; seam contract A11). Home's half of the
// backup is the vault lockup's status line (`VaultHeader`, R-ONBOARD-11).
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
// **EVERY PROTO NAME THIS FILE READS IS IN [BackupScreenModel.init] AND
// [BackupEvents]** — and `VaultHeader` reads `BackupLine.status` and `tone`
// from Home's `backup_line` — so a change to `screen.proto`'s
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
    /// THE RECOVERY KEY (R-ONBOARD-10): empty heading draws no section.
    var keyHeading = ""
    var keyLine = ""
    /// The key is on this phone alone and no copy was saved: drawn as a warning.
    var keyWarning = false
    var keyShowLabel = ""
    var keySyncLabel = ""
    var keySynced = false

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
        keyHeading = state.keyHeading
        keyLine = state.keyLine
        keyWarning = state.keyWarning
        keyShowLabel = state.keyShowLabel
        keySyncLabel = state.keySyncLabel
        keySynced = state.keySynced
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

    /// Move the recovery key into the keychain, or out of it.
    static func setKeySync(_ on: Bool) -> Data {
        event { $0.setKeySync = .with { $0.on = on } }
    }

    private static func event(_ build: (inout Centraid_Screen_V1_BackupScreenEvent) -> Void) -> Data {
        var event = Centraid_Screen_V1_BackupScreenEvent()
        build(&event)
        return (try? event.serializedBytes()) ?? Data()
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
    /// THE RECOVERY KEY, from the screen that is about getting the vault
    /// back: `words.show`, over the passcode.
    let onShowWords: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let model = BackupScreenModel(decoding: data)
        let paired = !model.destinations.isEmpty
        // ONE INK BUTTON AT A TIME: the recovery key's warning is the page's
        // first concern, then adding a backup device; a verb that would be a
        // second ink is drawn as the outline.
        let keyInk = model.keyWarning && !model.keyHeading.isEmpty && !model.keyShowLabel.isEmpty
        let addShown = !paired && !model.addLabel.isEmpty
        ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // WHERE THE BACKUP STANDS, and the one act that moves it: with
                // nothing paired that act is adding a backup device, drawn as
                // the page's primary; once one is paired it is "Back up now".
                VStack(alignment: .leading, spacing: 12) {
                    WordsHead(title: model.title, lead: model.line)
                    if !model.lineDetail.isEmpty {
                        sentence(model.lineDetail)
                    }
                    ForEach(model.waiting, id: \.self) { reason in
                        sentence(reason)
                    }
                    // WHY THE PHONE WILL NOT WAKE CENTRAID, when it will not.
                    if !model.backgroundNotice.isEmpty {
                        sentence(model.backgroundNotice, id: "backup-background-notice")
                    }
                    if addShown {
                        if keyInk {
                            KitOutlineButton(label: model.addLabel, action: onAddDestination)
                                .padding(.top, 8)
                                .accessibilityIdentifier("backup-add-destination")
                        } else {
                            KitInkButton(label: model.addLabel, action: onAddDestination)
                                .padding(.top, 8)
                                .accessibilityIdentifier("backup-add-destination")
                        }
                    }
                    // BACK UP NOW, only once there is somewhere to back up to
                    // (the machine draws no label before). Pressable when the
                    // machine says so; while a run goes, its progress stands
                    // beside it.
                    if !model.backUpNowLabel.isEmpty {
                        if keyInk || addShown {
                            KitOutlineButton(label: model.backUpNowLabel) { send(BackupEvents.backUpNow()) }
                                .disabled(!model.backUpNowEnabled)
                                .padding(.top, 8)
                                .accessibilityIdentifier("backup-now")
                        } else {
                            KitInkButton(label: model.backUpNowLabel) { send(BackupEvents.backUpNow()) }
                                .disabled(!model.backUpNowEnabled)
                                .padding(.top, 8)
                                .accessibilityIdentifier("backup-now")
                        }
                    }
                    if !model.progress.isEmpty {
                        KitSpinner(label: model.progress)
                            .accessibilityIdentifier("backup-progress")
                    }
                    // WHAT THE LAST ACT DID, in place: one clause, never a toast.
                    if !model.notice.isEmpty {
                        sentence(model.notice, id: "backup-notice")
                    }
                }
                .padding(.bottom, 24)

                // A KEY ON THIS PHONE ALONE IS THE PAGE'S FIRST CONCERN: a lost
                // phone takes every vault with it, whatever is backed up.
                if model.keyWarning {
                    recoveryKey(model)
                }

                if paired {
                    section(ShellWords.backupDevices) { destinations(model) }
                }

                if !shell.transferRuleChoices.isEmpty {
                    section(model.ruleLabel) { rule(model) }
                }

                if !model.videosLabel.isEmpty {
                    divider
                    Toggle(isOn: Binding(
                        get: { model.includeVideos },
                        set: { send(BackupEvents.setIncludeVideos($0)) }
                    )) {
                        Text(model.videosLabel)
                            .centraidType("body")
                            .foregroundStyle(Theme.color("text", scheme))
                    }
                    .kitToggle()
                    .frame(minHeight: CentraidGeometry.targetMinCoarse)
                    .padding(.vertical, 8)
                    .accessibilityIdentifier("backup-include-videos")
                }

                // THE RECOVERY KEY BELONGS HERE: it is the other half of
                // getting a vault back, beside the backup device that holds
                // the copy.
                if !model.keyWarning {
                    recoveryKey(model)
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.top, 16)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
            .id(Self.top)
        }
        // THE PAGE OPENS AT ITS TOP AND STAYS ANCHORED THERE as the read fills
        // it in: a section that arrives late (the recovery key, the backup
        // devices) grows the page downwards and never pushes the title up
        // under the vault's lockup.
        .defaultScrollAnchor(.top)
        .onAppear { proxy.scrollTo(Self.top, anchor: .top) }
        .onChange(of: shell.backupScrollTop) { _, _ in
            withAnimation { proxy.scrollTo(Self.top, anchor: .top) }
        }
        }
        .background(Theme.color("bg", scheme).ignoresSafeArea())
        .accessibilityIdentifier("backup-screen")
    }

    private static let top = "backup-top"

    /// WHERE THE RECOVERY KEY IS, and what can be done about it. A warning
    /// carries the attention mark Home's line uses and makes "Show recovery
    /// key" the primary; otherwise it is one quiet sentence and an outline
    /// button. Moving the key into or out of the keychain is a plain link: it
    /// is a choice made once, not a thing to do.
    @ViewBuilder
    private func recoveryKey(_ model: BackupScreenModel) -> some View {
        if !model.keyHeading.isEmpty {
            section(model.keyHeading) {
                VStack(alignment: .leading, spacing: 12) {
                    if model.keyWarning {
                        HStack(alignment: .top, spacing: 10) {
                            Rectangle()
                                .fill(Theme.color("attention", scheme))
                                .frame(width: 2)
                            Text(model.keyLine)
                                .centraidType("body")
                                .foregroundStyle(Theme.color("text", scheme))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("backup-key-line")
                        if !model.keyShowLabel.isEmpty {
                            KitInkButton(label: model.keyShowLabel, action: onShowWords)
                                .accessibilityIdentifier("backup-show-key")
                        }
                    } else {
                        sentence(model.keyLine, id: "backup-key-line")
                        if !model.keyShowLabel.isEmpty {
                            KitOutlineButton(label: model.keyShowLabel, action: onShowWords)
                                .accessibilityIdentifier("backup-show-key")
                        }
                    }
                    if !model.keySyncLabel.isEmpty {
                        KitLink(label: model.keySyncLabel, identifier: "backup-key-sync") {
                            send(BackupEvents.setKeySync(!model.keySynced))
                        }
                    }
                }
            }
        }
    }

    /// A HAIRLINE between groups: the page is already inset, so the plain
    /// rule and not `KitHairline`, which insets again.
    private var divider: some View {
        Rectangle()
            .fill(Theme.color("line", scheme))
            .frame(height: CentraidGeometry.hairline)
    }

    /// ONE GROUP: a rule above, its name in the page's strong small type
    /// (sentence case, never an eyebrow), then its rows.
    @ViewBuilder
    private func section<Content: View>(_ heading: String, @ViewBuilder content: () -> Content) -> some View {
        divider
        VStack(alignment: .leading, spacing: 8) {
            if !heading.isEmpty {
                Text(heading)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color("text", scheme))
                    .accessibilityAddTraits(.isHeader)
            }
            content()
        }
        .padding(.vertical, 20)
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
                        KitLink(label: model.forgetLabel, dense: true, identifier: "backup-forget-\(row.id)") {
                            send(BackupEvents.forget(row.id))
                        }
                        .accessibilityLabel("\(model.forgetLabel) \(row.label)")
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
            // ANOTHER BACKUP DEVICE, once one is paired: the secondary form.
            if !model.addLabel.isEmpty {
                KitOutlineButton(label: model.addLabel, action: onAddDestination)
                    .padding(.top, 12)
                    .accessibilityIdentifier("backup-add-destination")
            }
        }
    }

    /// THE MEMBER'S RULE, the same three sentences the Home header's sheet
    /// draws, from the same store. Its heading is the section's.
    @ViewBuilder
    private func rule(_ model: BackupScreenModel) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(shell.transferRuleChoices, id: \.stored) { choice in
                let picked = shell.transferRule == choice.stored
                Button {
                    shell.setTransferRule(choice.stored)
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        RuleMark(picked: picked)
                            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
                        Text(choice.sentence)
                            .centraidType("small")
                            .foregroundStyle(Theme.color(picked ? "text" : "textSoft", scheme))
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 8)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(KitRowPress())
                .accessibilityAddTraits(picked ? [.isSelected] : [])
                .accessibilityIdentifier("backup-rule-\(choice.stored)")
            }
        }
    }
}

/// THE RULE'S CHOICE MARK, in the theme's ink rather than the system's glyph:
/// a hairline ring, and a filled centre for the one picked.
private struct RuleMark: View {
    let picked: Bool
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            Circle()
                .strokeBorder(Theme.color(picked ? "text" : "lineStrong", scheme), lineWidth: 1.5)
            if picked {
                Circle()
                    .fill(Theme.color("text", scheme))
                    .padding(5)
            }
        }
        .frame(width: 20, height: 20)
        .accessibilityHidden(true)
    }
}
