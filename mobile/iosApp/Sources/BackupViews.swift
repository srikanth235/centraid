import SwiftUI

// THE BACKUP PAGE (`backup.home`; #1080, #1135, #1173), drawn as a Settings page: a status card, then
// grouped cards (In this backup, Backup devices, What travels when, Recovery). Home's half of the
// backup is the vault lockup's status line (`VaultHeader`).
//
// **THESE VIEWS DECIDE NOTHING** (R-1047-K1). Every sentence, the condition the status card draws
// (up to date, running, not reached, unpaired, moved), each row's words, the rule's short word and
// its three sentences, and what the last act did arrive in `BackupHomeState`. A view that needs one
// the state does not carry has a gap in the screen (`crates/screens/src/backup`), never a
// computation here. What is the view's is pushing the routes the state carries and the one local
// choice of whether the rule's sentences are open. The Android twin is `BackupScreens.kt`.

/// THE BACKUP PAGE.
struct BackupHomeView: View {
    let state: Centraid_Core_V1_BackupHomeState
    @ObservedObject var shell: ShellModel
    let send: (Centraid_Core_V1_BackupHomeEvent) -> Void
    /// Push a route the state carries: pairing another backup device (`add_destination`) and the
    /// recovery key (`key_show`).
    let open: (Centraid_Core_V1_Route) -> Void
    @State private var ruleOpen = false

    private func event(_ build: (inout Centraid_Core_V1_BackupHomeEvent) -> Void) -> Centraid_Core_V1_BackupHomeEvent {
        var event = Centraid_Core_V1_BackupHomeEvent()
        build(&event)
        return event
    }

    var body: some View {
        // THE READ IS THE KIT'S PAGE STATE (#1185): loading, failure with Retry, and the page under the
        // one sentence a refresh that failed leaves.
        PageReadStateView(
            page: state.page,
            onRetry: { send(event { $0.retry = .init() }) }
        ) {
            if case let .data(data)? = state.body {
                page(data)
            }
        }
    }

    private func page(_ model: Centraid_Core_V1_BackupHomeData) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    KitHeader(title: model.title)
                        .padding(.horizontal, -CentraidGeometry.pageMargin)
                    statusCard(model)
                    if !model.apps.isEmpty {
                        group(model.appsHeading) { appRows(model.apps) }
                    }
                    if !model.appsWaiting.isEmpty {
                        group(model.waitingHeading) { appRows(model.appsWaiting) }
                    }
                    if !model.destinations.isEmpty {
                        group(model.devicesHeading) { devices(model) }
                    } else if !model.addDestinationLabel.isEmpty {
                        group("") { addDevice(model) }
                    }
                    if !model.ruleChoices.isEmpty {
                        group(model.travelHeading) { travel(model) }
                    }
                    recovery(model)
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.top, 4)
                .padding(.bottom, 32)
                .frame(maxWidth: .infinity, alignment: .leading)
                .id(Self.top)
            }
            // THE PAGE OPENS AT ITS TOP AND STAYS THERE as the read fills it in.
            .defaultScrollAnchor(.top)
            .onAppear { proxy.scrollTo(Self.top, anchor: .top) }
            .onChange(of: shell.backupScrollTop) { _, _ in
                kitWithAnimation { proxy.scrollTo(Self.top, anchor: .top) }
            }
        }
        .background(Surface.page.ignoresSafeArea())
        .accessibilityIdentifier("backup-screen")
        // A DEVICE FORGOTTEN OR ADDED CHANGES THE PINS: the mover must never trust a certificate this
        // phone no longer pairs with.
        .onChange(of: model.destinations.map(\.gatewayID)) { _, _ in shell.refreshUploadPins() }
    }

    private static let top = "backup-top"

    // MARK: the status card

    private func markKey(_ model: Centraid_Core_V1_BackupHomeData) -> String {
        switch model.condition {
        case .upToDate: return "Check"
        case .running: return "Refresh"
        default: return model.line.tone == .urgent || model.condition == .notReached ? "AlertCircle" : "Refresh"
        }
    }

    private func tint(_ model: Centraid_Core_V1_BackupHomeData) -> Color {
        switch model.condition {
        case .upToDate: return StateColor.green.text
        case .running: return Surface.meta
        case .notReached: return StateColor.amber.text
        default: return model.line.tone == .urgent ? StateColor.red.text : StateColor.amber.text
        }
    }

    /// WHERE THE BACKUP STANDS, and the one act that moves it: "Back up now", or with nothing paired
    /// "Add backup device".
    private func statusCard(_ model: Centraid_Core_V1_BackupHomeData) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                // THE STATE'S MARK (Backup, BackupRunning, BackupFailed): a round badge in the state's
                // pale ground, its glyph in the state's colour.
                CentraidIconView(iconKey: markKey(model), tint: tint(model), size: 20)
                    .frame(width: 40, height: 40)
                    .background(tint(model).opacity(0.14), in: Circle())
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.line.sentence)
                        .kitType(.section)
                        .foregroundStyle(Surface.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    if !model.line.detail.isEmpty { sentence(model.line.detail) }
                    if !model.lastGood.isEmpty { sentence(model.lastGood, id: "backup-last-good") }
                }
            }
            // WHY THE DEVICE IS NOT ANSWERING is an amber callout of its own, not a quiet line.
            if !model.reason.isEmpty {
                WordsCallout(text: model.reason, state: .amber, identifier: "backup-reason")
            }
            if !model.progress.isEmpty {
                if model.progressKnown {
                    // THE RUN'S BAR (BackupRunning): what a gateway has acknowledged of the whole,
                    // and the bytes still to go under it.
                    VStack(alignment: .leading, spacing: 8) {
                        KitProgressBar(fraction: Double(model.progressFraction), height: 6, fill: AppAccent.shell.text)
                        Text(model.progress)
                            .kitType(.meta)
                            .fontWeight(.semibold)
                            .foregroundStyle(AppAccent.shell.text)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 6)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("backup-progress")
                } else {
                    KitSpinner(label: model.progress).accessibilityIdentifier("backup-progress")
                }
            }
            ForEach(model.line.waiting.map(\.sentence).filter { !$0.isEmpty }, id: \.self) { reason in
                sentence(reason)
            }
            if !model.backgroundNotice.isEmpty {
                sentence(model.backgroundNotice, id: "backup-background-notice")
            }
            if !model.notice.isEmpty { sentence(model.notice, id: "backup-notice") }
            if !model.backUpNowLabel.isEmpty {
                if model.ink == .backUpNow {
                    KitInkButton(label: model.backUpNowLabel) { send(event { $0.backUpNow = .init() }) }
                        .disabled(!model.backUpNowEnabled)
                        .accessibilityIdentifier("backup-now")
                } else {
                    KitOutlineButton(label: model.backUpNowLabel) { send(event { $0.backUpNow = .init() }) }
                        .disabled(!model.backUpNowEnabled)
                        .accessibilityIdentifier("backup-now")
                }
            } else if model.destinations.isEmpty, !model.addDestinationLabel.isEmpty {
                KitInkButton(label: model.addDestinationLabel) { open(model.addDestination) }
                    .accessibilityIdentifier("backup-add-destination")
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .kitCard()
        .padding(.top, 4)
    }

    // MARK: groups

    /// ONE GROUP: its name in the small caps rung over one card of rows.
    @ViewBuilder
    private func group<Content: View>(_ heading: String, @ViewBuilder content: () -> Content) -> some View {
        if !heading.isEmpty {
            Text(heading)
                .kitType(.group)
                .foregroundStyle(Surface.meta)
                .padding(.leading, 4)
                .padding(.top, 20)
                .padding(.bottom, 6)
                .accessibilityAddTraits(.isHeader)
        } else {
            Spacer().frame(height: 20)
        }
        VStack(spacing: 0) { content() }
            .frame(maxWidth: .infinity, alignment: .leading)
            .kitCard()
            .clipShape(RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
    }

    private func hairline() -> some View {
        Rectangle().fill(Surface.line).frame(height: CentraidGeometry.hairline).padding(.leading, 56)
    }

    /// One of the screen's sentences, drawn quietly.
    @ViewBuilder
    private func sentence(_ text: String, id: String? = nil) -> some View {
        let drawn = Text(text)
            .kitType(.meta)
            .foregroundStyle(Surface.meta)
            .fixedSize(horizontal: false, vertical: true)
        if let id { drawn.accessibilityIdentifier(id) } else { drawn }
    }

    /// "IN THIS BACKUP" and "Not backed up yet": one row per app, its mark, what it holds and its
    /// size, and whether it is backed up. A row that waits draws its status in the amber state word.
    @ViewBuilder
    private func appRows(_ rows: [Centraid_Core_V1_BackupAppRow]) -> some View {
        ForEach(Array(rows.enumerated()), id: \.element.appID) { index, row in
            HStack(spacing: 12) {
                AppTile(appID: row.appID, size: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.name).kitType(.row).foregroundStyle(Surface.ink)
                    if !row.detail.isEmpty { sentence(row.detail) }
                    if !row.note.isEmpty { sentence(row.note) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if !row.status.isEmpty {
                    Text(row.status)
                        .kitType(.meta)
                        .foregroundStyle(row.waiting ? StateColor.amber.text : Surface.meta)
                        .multilineTextAlignment(.trailing)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(row.accessibilityLabel.isEmpty ? row.name : row.accessibilityLabel)
            .accessibilityIdentifier("backup-app-\(row.appID)")
            if index < rows.count - 1 { hairline() }
        }
    }

    // MARK: devices

    @ViewBuilder
    private func devices(_ model: Centraid_Core_V1_BackupHomeData) -> some View {
        ForEach(model.destinations, id: \.gatewayID) { row in
            HStack(alignment: .center, spacing: 12) {
                KitTile(iconKey: "Monitor", size: 32)
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.label).kitType(.row).foregroundStyle(Surface.ink)
                    if !row.held.isEmpty { sentence(row.held) }
                    if !row.detail.isEmpty { sentence(row.detail) }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(row.accessibilityLabel.isEmpty ? row.label : row.accessibilityLabel)
                .frame(maxWidth: .infinity, alignment: .leading)
                // FORGET IS PLAIN AND VISIBLE, and needs no confirmation: it forgets this phone's
                // pairing and nothing the backup device holds, and pairing again undoes it.
                if !model.forgetLabel.isEmpty {
                    KitLink(label: model.forgetLabel, dense: true, identifier: "backup-forget-\(row.gatewayID)") {
                        send(event { $0.forgetDestination = .with { $0.gatewayID = row.gatewayID } })
                    }
                    .accessibilityLabel("\(model.forgetLabel) \(row.label)")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            hairline()
        }
        if !model.addDestinationLabel.isEmpty { addDevice(model) }
    }

    private func addDevice(_ model: Centraid_Core_V1_BackupHomeData) -> some View {
        Button { open(model.addDestination) } label: {
            HStack(spacing: 12) {
                CentraidIconView(iconKey: "Plus", tint: AppAccent("").text, size: 18).frame(width: 32)
                Text(model.addDestinationLabel).kitType(.row).foregroundStyle(AppAccent("").text)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("backup-add-destination")
    }

    // MARK: what travels when

    @ViewBuilder
    private func travel(_ model: Centraid_Core_V1_BackupHomeData) -> some View {
        // "Back up over": the picked rule's short word, opening the three sentences it can be.
        Button { kitWithAnimation { ruleOpen.toggle() } } label: {
            HStack(spacing: 8) {
                Text(model.overLabel).kitType(.row).foregroundStyle(Surface.ink)
                Spacer(minLength: 8)
                Text(model.overValue).kitType(.row).foregroundStyle(Surface.meta)
                CentraidIconView(iconKey: ruleOpen ? "ChevronDown" : "ChevronRight", tint: Surface.meta, size: 16)
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(model.overLabel), \(model.overValue)")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("backup-over")
        if ruleOpen {
            ForEach(model.ruleChoices, id: \.stored) { choice in
                Button {
                    // THE PASS SERVICE HEARS THE WRITE: the windows follow the rule.
                    send(event { $0.ruleChosen = .with { $0.stored = choice.stored } })
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        RuleMark(picked: choice.picked)
                            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
                        Text(choice.sentence)
                            .kitType(.meta)
                            .foregroundStyle(choice.picked ? Surface.ink : Surface.meta)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(KitRowPress())
                .accessibilityAddTraits(choice.picked ? [.isSelected] : [])
                .accessibilityIdentifier("backup-rule-\(choice.stored)")
            }
        }
        if !model.includeVideosLabel.isEmpty {
            Rectangle().fill(Surface.line).frame(height: CentraidGeometry.hairline).padding(.leading, 16)
            Toggle(isOn: Binding(
                get: { model.includeVideos },
                set: { value in send(event { $0.setIncludeVideos = .with { $0.include = value } }) }
            )) {
                Text(model.includeVideosLabel).kitType(.row).foregroundStyle(Surface.ink)
            }
            .kitToggle()
            .padding(.horizontal, 16)
            .frame(minHeight: 52)
            .accessibilityIdentifier("backup-include-videos")
        }
    }

    // MARK: recovery

    /// WHERE THE RECOVERY KEY IS, and what can be done about it. A warning carries the amber word;
    /// the key row opens the words behind the passcode. Restore is Home's door.
    @ViewBuilder
    private func recovery(_ model: Centraid_Core_V1_BackupHomeData) -> some View {
        if !model.keyHeading.isEmpty || !model.restoreLabel.isEmpty {
            group(model.keyHeading) {
                if !model.keyHeading.isEmpty {
                    let row = HStack(spacing: 12) {
                        KitTile(iconKey: "Key", size: 32)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(model.keyHeading).kitType(.row).foregroundStyle(Surface.ink)
                            Text(model.keySummary)
                                .kitType(.meta)
                                .foregroundStyle(model.keyWarning ? StateColor.amber.text : Surface.meta)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if !model.keyShowLabel.isEmpty {
                            CentraidIconView(iconKey: "ChevronRight", tint: Surface.meta, size: 16)
                        }
                    }
                    .padding(.horizontal, 12)
                    .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                    .contentShape(Rectangle())
                    if !model.keyShowLabel.isEmpty {
                        Button { open(model.keyShow) } label: { row }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(model.keyShowLabel). \(model.keySummary)")
                            .accessibilityIdentifier("backup-show-key")
                    } else {
                        row
                    }
                    hairline()
                    sentence(model.keyLine, id: "backup-key-line")
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if !model.keySyncLabel.isEmpty {
                        hairline()
                        KitLink(label: model.keySyncLabel, identifier: "backup-key-sync") {
                            send(event { $0.setKeySync = .with { $0.on = !model.keySynced } })
                        }
                        .padding(.horizontal, 16)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }
                }
                if !model.restoreLabel.isEmpty {
                    if !model.keyHeading.isEmpty { hairline() }
                    Button { send(event { $0.restorePressed = .init() }) } label: {
                        HStack(spacing: 12) {
                            KitTile(iconKey: "History", size: 32)
                            Text(model.restoreLabel).kitType(.row).foregroundStyle(Surface.ink)
                            Spacer(minLength: 0)
                            CentraidIconView(iconKey: "ChevronRight", tint: Surface.meta, size: 16)
                        }
                        .padding(.horizontal, 12)
                        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("backup-restore")
                }
            }
        }
    }
}

/// THE RULE'S CHOICE MARK: a hairline ring, and a filled centre for the one picked.
private struct RuleMark: View {
    let picked: Bool

    var body: some View {
        ZStack {
            Circle()
                .strokeBorder(picked ? Surface.ink : Surface.border, lineWidth: 1.5)
            if picked {
                Circle().fill(Surface.ink).padding(5)
            }
        }
        .frame(width: 20, height: 20)
        .accessibilityHidden(true)
    }
}
