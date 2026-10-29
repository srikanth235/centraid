import SwiftUI

// THE BACKUP SCREEN (`backup.home`; #1080, #1135). Home's half of the backup is
// the vault lockup's status line (`VaultHeader`, R-ONBOARD-11).
//
// **THESE VIEWS DECIDE NOTHING** (R-1047-K1). Every sentence — the line and its
// detail, each reason something waits, each gateway's last word, every control's
// label, the rule's three choices and which is picked, what the last act did, why
// the phone will not wake Centraid — arrives in `BackupHomeState`, and so does
// the page's one Ink button, whether "Back up now" may be pressed and whether
// the vault moved. A view that needs one the state does not carry has a gap in
// the screen (`crates/screens/src/backup`), never a computation here. What is the
// view's is pushing the routes the state carries (the pairing page,
// `words.show`). The Android twin is `BackupScreens.kt`; the two read the same
// names.

/// THE BACKUP SCREEN: where the backup stands, the three controls, the gateways
/// this phone backs up to and where the recovery key is.
struct BackupHomeView: View {
    let state: Centraid_Core_V1_BackupHomeState
    @ObservedObject var shell: ShellModel
    let send: (Centraid_Core_V1_BackupHomeEvent) -> Void
    /// Push a route the state carries: pairing another gateway
    /// (`add_destination`), and THE RECOVERY KEY from the screen that is about
    /// getting the vault back (`key_show`, `words.show` over the passcode).
    let open: (Centraid_Core_V1_Route) -> Void
    @Environment(\.colorScheme) private var scheme

    private func event(_ build: (inout Centraid_Core_V1_BackupHomeEvent) -> Void) -> Centraid_Core_V1_BackupHomeEvent {
        var event = Centraid_Core_V1_BackupHomeEvent()
        build(&event)
        return event
    }

    var body: some View {
        switch state.body {
        case .data(let data)?:
            page(data)
        case .failure(let failure)?:
            FailureView(sentence: failure.sentence, remedy: failure.remedy) {
                send(event { $0.retry = .init() })
            }
        default:
            RowSkeleton()
        }
    }

    private func page(_ model: Centraid_Core_V1_BackupHomeData) -> some View {
        let paired = !model.destinations.isEmpty
        return ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // WHERE THE BACKUP STANDS, and the one act that moves it: with
                // nothing paired that act is adding a backup device, drawn as
                // the page's primary; once one is paired it is "Back up now".
                VStack(alignment: .leading, spacing: 12) {
                    WordsHead(title: model.title, lead: model.line.sentence)
                    if !model.line.detail.isEmpty {
                        sentence(model.line.detail)
                    }
                    ForEach(model.line.waiting.map(\.sentence).filter { !$0.isEmpty }, id: \.self) { reason in
                        sentence(reason)
                    }
                    // WHY THE PHONE WILL NOT WAKE CENTRAID, when it will not.
                    if !model.backgroundNotice.isEmpty {
                        sentence(model.backgroundNotice, id: "backup-background-notice")
                    }
                    // ONE INK BUTTON AT A TIME, and the screen names it (`ink`);
                    // a verb that is not the page's one thing to do is the outline.
                    if !paired && !model.addDestinationLabel.isEmpty {
                        if model.ink == .addDestination {
                            KitInkButton(label: model.addDestinationLabel) { open(model.addDestination) }
                                .padding(.top, 8)
                                .accessibilityIdentifier("backup-add-destination")
                        } else {
                            KitOutlineButton(label: model.addDestinationLabel) { open(model.addDestination) }
                                .padding(.top, 8)
                                .accessibilityIdentifier("backup-add-destination")
                        }
                    }
                    // BACK UP NOW, only once there is somewhere to back up to
                    // (the screen draws no label before). Pressable when it
                    // says so; while a run goes, its progress stands beside it.
                    if !model.backUpNowLabel.isEmpty {
                        if model.ink == .backUpNow {
                            KitInkButton(label: model.backUpNowLabel) { send(event { $0.backUpNow = .init() }) }
                                .disabled(!model.backUpNowEnabled)
                                .padding(.top, 8)
                                .accessibilityIdentifier("backup-now")
                        } else {
                            KitOutlineButton(label: model.backUpNowLabel) { send(event { $0.backUpNow = .init() }) }
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

                // WHAT EACH APP'S BACKUP HOLDS (#1144), biggest first as the
                // screen orders it.
                if !model.apps.isEmpty {
                    section(model.appsHeading) { apps(model) }
                }

                if paired {
                    section(model.devicesHeading) { destinations(model) }
                }

                if !model.ruleChoices.isEmpty {
                    section(model.ruleLabel) { rule(model) }
                }

                if !model.includeVideosLabel.isEmpty {
                    divider
                    Toggle(isOn: Binding(
                        get: { model.includeVideos },
                        set: { value in send(event { $0.setIncludeVideos = .with { $0.include = value } }) }
                    )) {
                        Text(model.includeVideosLabel)
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
        // A GATEWAY FORGOTTEN OR ADDED CHANGES THE PINS: the mover must never trust a
        // certificate this phone no longer pairs with.
        .onChange(of: model.destinations.map(\.gatewayID)) { _, _ in shell.refreshUploadPins() }
    }

    private static let top = "backup-top"

    /// WHERE THE RECOVERY KEY IS, and what can be done about it. A warning
    /// carries the attention mark Home's line uses, and the screen makes "Show
    /// recovery key" the page's Ink button (`ink`); otherwise it is one quiet
    /// sentence and an outline button. Moving the key into or out of the
    /// keychain is a plain link: it is a choice made once, not a thing to do.
    @ViewBuilder
    private func recoveryKey(_ model: Centraid_Core_V1_BackupHomeData) -> some View {
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
                    } else {
                        sentence(model.keyLine, id: "backup-key-line")
                    }
                    if !model.keyShowLabel.isEmpty {
                        if model.ink == .showKey {
                            KitInkButton(label: model.keyShowLabel) { open(model.keyShow) }
                                .accessibilityIdentifier("backup-show-key")
                        } else {
                            KitOutlineButton(label: model.keyShowLabel) { open(model.keyShow) }
                                .accessibilityIdentifier("backup-show-key")
                        }
                    }
                    if !model.keySyncLabel.isEmpty {
                        KitLink(label: model.keySyncLabel, identifier: "backup-key-sync") {
                            send(event { $0.setKeySync = .with { $0.on = !model.keySynced } })
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

    /// One of the screen's sentences, drawn quietly.
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
    private func destinations(_ model: Centraid_Core_V1_BackupHomeData) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(model.destinations, id: \.gatewayID) { row in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.label)
                            .centraidType("smallStrong")
                            .foregroundStyle(Theme.color("text", scheme))
                        // WHAT IT HOLDS, as this phone recorded its acknowledgements.
                        if !row.held.isEmpty {
                            Text(row.held)
                                .centraidType("small")
                                .foregroundStyle(Theme.color("text", scheme))
                        }
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
                        KitLink(label: model.forgetLabel, dense: true, identifier: "backup-forget-\(row.gatewayID)") {
                            send(event { $0.forgetDestination = .with { $0.gatewayID = row.gatewayID } })
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
            if !model.addDestinationLabel.isEmpty {
                KitOutlineButton(label: model.addDestinationLabel) { open(model.addDestination) }
                    .padding(.top, 12)
                    .accessibilityIdentifier("backup-add-destination")
            }
        }
    }

    /// "IN THIS BACKUP" (#1144): one row per app — its mark, its name, what it
    /// holds and its size, what was left out of it, and whether it is backed
    /// up. A row that waits draws its status in the attention tone.
    @ViewBuilder
    private func apps(_ model: Centraid_Core_V1_BackupHomeData) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(model.apps, id: \.appID) { row in
                HStack(alignment: .center, spacing: 12) {
                    AppMark(appID: row.appID, size: 32)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.name)
                            .centraidType("smallStrong")
                            .foregroundStyle(Theme.color("text", scheme))
                        if !row.detail.isEmpty {
                            Text(row.detail)
                                .centraidType("annotLabel")
                                .foregroundStyle(Theme.color("textFaint", scheme))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if !row.note.isEmpty {
                            Text(row.note)
                                .centraidType("annotLabel")
                                .foregroundStyle(Theme.color("textFaint", scheme))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Spacer(minLength: 0)
                    if !row.status.isEmpty {
                        Text(row.status)
                            .centraidType(row.waiting ? "annotLabelOn" : "annotLabel")
                            .foregroundStyle(Theme.color(row.waiting ? "attention" : "textFaint", scheme))
                            .multilineTextAlignment(.trailing)
                    }
                }
                .frame(minHeight: 56)
                .padding(.vertical, 8)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(row.accessibilityLabel.isEmpty ? row.name : row.accessibilityLabel)
                .accessibilityIdentifier("backup-app-\(row.appID)")
                // THE PAGE IS ALREADY INSET, so the rule is the plain hairline.
                Rectangle()
                    .fill(Theme.color("line", scheme))
                    .frame(height: CentraidGeometry.hairline)
            }
        }
    }

    /// THE MEMBER'S RULE, the same three sentences the Home header's sheet
    /// draws, from the same store. Its heading is the section's.
    @ViewBuilder
    private func rule(_ model: Centraid_Core_V1_BackupHomeData) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(model.ruleChoices, id: \.stored) { choice in
                Button {
                    // THE PASS SERVICE HEARS THE WRITE: the windows follow the rule.
                    send(event { $0.ruleChosen = .with { $0.stored = choice.stored } })
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        RuleMark(picked: choice.picked)
                            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
                        Text(choice.sentence)
                            .centraidType("small")
                            .foregroundStyle(Theme.color(choice.picked ? "text" : "textSoft", scheme))
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 8)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(KitRowPress())
                .accessibilityAddTraits(choice.picked ? [.isSelected] : [])
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
