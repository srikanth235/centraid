import SwiftUI

// HOME, DRAWN FROM RUST (#1135, lane H1). The springboard is a Rust screen
// (`crates/screens/src/shell`): it reads one tile per app, grades the grid,
// words every tile and the lockup, and carries the route each tile opens.
// This file only draws `Centraid_Core_V1_HomeState` and sends `HomeEvent`s; it
// writes no copy, counts nothing and names no destination.

/// The words a skeleton tile speaks, handed down from `HomeState.loadingLabel`.
struct HomeLoadingLabelKey: EnvironmentKey {
    static let defaultValue = ""
}

extension EnvironmentValues {
    var homeLoadingLabel: String {
        get { self[HomeLoadingLabelKey.self] }
        set { self[HomeLoadingLabelKey.self] = newValue }
    }
}

extension Centraid_Core_V1_ViewState {
    /// Home's state when this is Home's view.
    var homeState: Centraid_Core_V1_HomeState? {
        if case let .home(state)? = kind { return state }
        return nil
    }
}

/// The place the band is showing, as Rust selects it: Home's springboard, or the
/// chat's or the backup's tab root drawn in its place.
struct HomeView: View {
    @ObservedObject var shell: ShellModel
    /// The Chat composer has the keyboard (`ChatView` reports it).
    @State private var chatTyping = false

    var body: some View {
        if let store = shell.screens {
            HomeRoot(shell: shell, store: store, chatTyping: $chatTyping)
        } else {
            BarePaper()
        }
    }
}

/// Home over the screen store, so a Rust push redraws it.
private struct HomeRoot: View {
    @Environment(\.isLargestText) private var largestText
    @ObservedObject var shell: ShellModel
    @ObservedObject var store: ScreenStore
    @Binding var chatTyping: Bool
    @Environment(\.colorScheme) private var scheme

    private var home: Centraid_Core_V1_HomeState? {
        store.homeInstance.flatMap { store.views[$0] }?.homeState
    }

    /// THE BAND'S PLACES, Rust's (`Navigation.band`): the words, the marks and which is lit.
    private var places: [BandPlace] {
        (store.navigation?.band.tabs ?? []).map { tab in
            BandPlace(
                id: tab.tab,
                label: tab.label,
                spoken: tab.spoken,
                iconKey: tab.iconKey,
                selected: tab.selected
            )
        }
    }

    /// The root of the backup tab, once Rust has opened it.
    private var backupRoot: UInt64? {
        store.entries(of: RustScreens.backupTab).first?.instance
    }

    var body: some View {
        let home = home ?? Centraid_Core_V1_HomeState()
        VStack(alignment: .leading, spacing: 0) {
            // THE CHAT TAB DRAWS IN PLACE OF THE SPRINGBOARD, with a header of
            // its own; while the composer has the keyboard the band steps aside.
            if shell.tab == .chat {
                ChatView(
                    chat: shell.chat,
                    typing: $chatTyping,
                    onOpenRoute: { shell.open($0) },
                    onSetScope: { shell.setChatScope($0) }
                )
            } else if shell.tab == .backup {
                // THE BACKUP TAB DRAWS IN PLACE OF THE SPRINGBOARD, as Chat
                // does, under its own title and with no vault lockup (the board has none
                // on Backup); the band stays where it is.
                if let backupRoot {
                    RustScreenView(shell: shell, store: store, instance: backupRoot, entry: nil)
                        .id(backupRoot)
                } else {
                    BarePaper()
                }
            } else {
                homeContent(home)
            }

            // A SIBLING OF THE PAGE, NEVER INSIDE IT: the banner is never scrolled away.
            ShellBanner(shell: shell, store: store)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // THE LOCKUP FLOATS TOO, on Home only (Chat and Backup draw their own
        // headers): the page scrolls under it, and on iOS 26 the system's scroll
        // edge effect keeps it legible over whatever passes beneath.
        .floatingTopBar(shown: shell.tab == .home && !largestText) {
            VaultHeader(bar: home.bar, shell: shell, store: store)
        }
        // THE BAND FLOATS OVER THE PAGE, as every app's band does: the page scrolls under its
        // glass, and the inset keeps the last tile clear of it. Never scrolled away.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !(shell.tab == .chat && chatTyping) {
                // A PLACE IS SELECTED BY RUST; pressed again while Chat shows, it shuts the drawer.
                HomeBand(places: places) { target in shell.select(place: target) }
            }
        }
        // EDGE TO EDGE: the page ground reaches the notch and the home indicator.
        .background((shell.tab == .home ? Surface.page : Theme.color("bg", scheme)).ignoresSafeArea())
        // THE CHAT BELONGS TO THE VAULT IN FRONT: when it changes the thread,
        // its session and its cards are the old vault's and are dropped.
        .onChange(of: home.bar.vault.vaultID, initial: true) { _, id in
            shell.vaultChanged(to: id)
        }
        // A COVER WAS POPPED BACK TO HOME: the Locker's open state and any tile
        // may have moved without a table changing.
        .onAppear { store.sendHome(.shown(.init())) }
        .environment(\.homeLoadingLabel, home.loadingLabel)
        // THE TRANSFER RULES (#1025 S4), reached from the "originals waiting" line: Rust's
        // sheet (`HomeState.transfer_sheet`); dismissing it tells Rust.
        .sheet(
            isPresented: Binding(
                get: { home.hasTransferSheet },
                set: { open in
                    if !open { store.sendHome(.transferRulesClosed(.init())) }
                }
            )
        ) {
            TransferRulesSheet(
                sheet: home.transferSheet,
                onPick: { stored in store.sendHome(.transferRuleChosen(.with { $0.stored = stored })) },
                onClose: { store.sendHome(.transferRulesClosed(.init())) }
            )
        }
        // A REAL BINDING: dismissing shuts the sheet in Rust, which owns it.
        .sheet(
            isPresented: Binding(
                get: { home.hasSheet },
                set: { open in
                    if !open { store.sendHome(.sheetClosed(.init())) }
                }
            )
        ) {
            VaultSheet(sheet: home.sheet, store: store)
        }
        // THE PHONE'S SCHEME MOVED while the app is in front: Home is told it.
        .onChange(of: scheme) { _, _ in shell.tellPhoneScheme() }
    }

    /// HOME'S OWN PLACE: the lockup, the ribbon and the three branches.
    @ViewBuilder
    private func homeContent(_ home: Centraid_Core_V1_HomeState) -> some View {
        // THE LOCKUP (`VaultHeader`) FLOATS OVER THE PAGE from `body`, so the
        // springboard scrolls under it; a Home that failed to read still says
        // which vault failed.
        // AT THE LARGEST TEXT THE LOCKUP IS TALL ENOUGH TO COVER THE TILES it would float over, so it
        // scrolls with the page (the first thing in it) instead of staying pinned.
        let scrolling: AnyView? = largestText && shell.tab == .home
            ? AnyView(VaultHeader(bar: home.bar, shell: shell, store: store))
            : nil
        if home.hasStatus {
            StatusRibbon(status: home.status, store: store)
        }
        // THE READ IS THE KIT'S PAGE STATE (#1185). A Home that could not load (no vault) renders its
        // sentence and no grid, with no Retry (the first-launch gate is the way on); it does NOT render
        // an empty springboard.
        VStack(alignment: .leading, spacing: 0) {
            // A HOME THAT FAILED STILL NAMES ITS VAULT, scrolled or pinned.
            if case .failed? = home.page.state { scrolling }
            PageReadStateView(
                page: home.page,
                onRetry: nil,
                skeleton: { Springboard(data: Centraid_Core_V1_HomeData(), shell: shell, header: scrolling) }
            ) {
                if case let .data(data)? = home.content {
                    if data.springboard == .firstRun {
                        DayOne(data: data, shell: shell, header: scrolling)
                    } else {
                        Springboard(data: data, shell: shell, header: scrolling)
                    }
                }
            }
        }
    }
}

/// `R.margin.m` — the phone's page margin, emitted beside the tokens.
private let pageMargin = CentraidGeometry.pageMargin

/// The vault at a glance, and how it stands on this device.
///
/// The ONLY feedback channel on this screen — no spinner, no toast, no badge, no
/// red dot. `quiet` is deliberately ignorable and earns no rule; the other two

/// The vault at a glance, and how it stands on this device.
///
/// The ONLY feedback channel on this screen — no spinner, no toast, no badge, no
/// red dot. `quiet` is deliberately ignorable and earns no rule; the other two
/// get one rule and one action, never a filled warning plate.
private struct StatusRibbon: View {
    let status: Centraid_Core_V1_HomeStatus
    @ObservedObject var store: ScreenStore
    @Environment(\.colorScheme) private var scheme

    // ONLY THE TWO TONES THAT EARN A RULE.
    private var loud: Bool { status.tone == .attention || status.tone == .urgent }

    var body: some View {
        // A RIBBON WITH NOTHING TO SAY IS NOT DRAWN AT ALL.
        if !status.copy.isEmpty || !status.action.isEmpty {
            ribbon
        }
    }

    /// THE ACTION'S DOOR is Rust's: the press is an event and Rust chooses the
    /// tab or the settings page. No door (`DESTINATION_NONE`) is plain text.
    private var hasDoor: Bool {
        switch status.destination {
        case .backup, .phone, .notifications: return true
        case .none, .unspecified, .UNRECOGNIZED: return false
        }
    }

    private var ribbon: some View {
        HStack(spacing: 8) {
            if loud {
                // ONE RULE in the tone's colour, and nothing else.
                Rectangle()
                    .fill(Theme.color(status.tone == .urgent ? "danger" : "attention", scheme))
                    .frame(width: 2, height: 24)
            }
            if !status.copy.isEmpty {
                Text(status.copy)
                    .centraidType(loud ? "small" : "mono")
                    .foregroundStyle(Theme.color(loud ? "text" : "textFaint", scheme))
                    // THE SENTENCE WRAPS, whole, as the board's does; it is never cut to "...".
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            if !status.action.isEmpty {
                if hasDoor {
                    KitLink(label: status.action) { store.sendHome(.status(.init())) }
                } else {
                    Text(status.action)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("link", scheme))
                }
            }
        }
        .padding(.horizontal, pageMargin)
        .frame(minHeight: loud ? 40 : 32)
        .accessibilityIdentifier("home-status")
        .accessibilityElement(children: hasDoor ? .contain : .combine)
        .accessibilityLabel(
            hasDoor ? status.copy : status.accessibilityLabel
        )
    }
}

private struct Springboard: View {
    let data: Centraid_Core_V1_HomeData
    @ObservedObject var shell: ShellModel
    /// The lockup, when it scrolls with the page (the largest text sizes).
    var header: AnyView?

    var body: some View {
        ScrollView {
            header
            WidgetGrid(data: data, shell: shell)
                .padding(.horizontal, pageMargin)
                .padding(.top, 10)
                .padding(.bottom, 24)
        }
    }
}

/// Day one: the vault holds nothing anywhere.
///
/// Reached ONLY when every readable tile has settled and is empty. A
/// still-loading vault, or an unreachable replica, gets the ordinary grid —
/// this page is a claim about the vault, and an unanswered read has not
/// earned it.
private struct DayOne: View {
    let data: Centraid_Core_V1_HomeData
    @ObservedObject var shell: ShellModel
    var header: AnyView?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ScrollView {
            header
            VStack(alignment: .leading, spacing: 12) {
                Text(data.dayOneTitle)
                    .centraidType("title")
                    .foregroundStyle(Theme.color("text", scheme))
                Text(data.dayOneBody)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
                WidgetGrid(data: data, shell: shell)
                    .padding(.top, 12)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .padding(pageMargin)
        }
        .accessibilityIdentifier("home-day-one")
    }
}
/// THE VAULT SWITCHER, and the only control that changes what the whole app is
/// reading. Every word, the roster's order and the questions it asks are Rust's
/// (`HomeVaultSheet`); the press is an event, and the shelf's act is the shell's.
///
/// It lists EVERY vault the device holds, the open one included and ticked.
private struct VaultSheet: View {
    let sheet: Centraid_Core_V1_HomeVaultSheet
    @ObservedObject var store: ScreenStore
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        // A SHEETROOM: the room owns the grabber, the title and the gutter,
        // and the roster scrolls inside it.
        SheetRoom(title: sheet.title, titleIdentifier: "home-vault-sheet") {
            roster
        }
        .sheet(item: Binding(get: { forgetAsk }, set: { if $0 == nil { store.sendHome(.askDismissed(.init())) } })) { ask in
            forgetConfirm(ask)
        }
        .sheet(item: Binding(get: { renameAsk }, set: { if $0 == nil { store.sendHome(.askDismissed(.init())) } })) { ask in
            renameSheet(ask)
        }
    }

    private var forgetAsk: AskItem<Centraid_Core_V1_HomeVaultAsk.Forget>? {
        if sheet.hasAsk, case let .forget(forget)? = sheet.ask.kind { return AskItem(value: forget, id: forget.vaultID) }
        return nil
    }

    private var renameAsk: AskItem<Centraid_Core_V1_HomeVaultAsk.Rename>? {
        if sheet.hasAsk, case let .rename(rename)? = sheet.ask.kind { return AskItem(value: rename, id: rename.vaultID) }
        return nil
    }

    /// A question a sheet is about, as `.sheet(item:)` needs it.
    private struct AskItem<Value>: Identifiable {
        let value: Value
        let id: String
    }

    private var roster: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !sheet.oneLine.isEmpty {
                Text(sheet.oneLine)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .padding(.bottom, 8)
            }

            // THE ROSTER IS DRAWN AS THE SHELF LISTS IT: this view sorts nothing.
            List {
            ForEach(sheet.vaults, id: \.vaultID) { vault in
                Button {
                    store.sendHome(.vaultPicked(.with { $0.vaultID = vault.vaultID }))
                } label: {
                    HStack(spacing: 12) {
                        Text(vault.initial)
                            .centraidType("smallStrong")
                            .foregroundStyle(Theme.color("text", scheme))
                            .frame(width: 30, height: 30)
                            .background(
                                Theme.color("bgSunken", scheme),
                                in: RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                            )
                        VStack(alignment: .leading, spacing: 0) {
                            HStack(spacing: 8) {
                                Text(vault.name)
                                    .centraidType("smallStrong")
                                    .foregroundStyle(Theme.color("text", scheme))
                            }
                            // THE SAME SECOND LINE THE HEADER DRAWS.
                            if !vault.stateLine.isEmpty {
                                Text(vault.stateLine)
                                    .centraidType("mono")
                                    .foregroundStyle(Theme.color("textFaint", scheme))
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: 0)
                        // THE TICK IS THE WHOLE POINT of listing the open one.
                        if vault.vaultID == sheet.activeVaultID {
                            CentraidIconView(
                                iconKey: "Check",
                                tint: Theme.color("link", scheme),
                                size: 18
                            )
                            .accessibilityLabel(sheet.currentLabel)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("vault-row-\(vault.vaultID)")
                // FORGET IS A SWIPE AND NOT A ROW CONTROL: the row's whole width
                // is the switch. `allowsFullSwipe` is off because this deletes
                // the device's copy and a full swipe is a gesture a thumb makes
                // by accident. RENAME SITS BESIDE IT and in the long-press menu;
                // a vault that moved is read-only and offers no rename.
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button(role: .destructive) {
                        store.sendHome(.forgetAsked(.with { $0.vaultID = vault.vaultID }))
                    } label: {
                        Label(sheet.forgetLabel, systemImage: "trash")
                    }
                    .accessibilityIdentifier("vault-forget-\(vault.vaultID)")
                    if vault.state != .frozen {
                        Button {
                            store.sendHome(.renameAsked(.with { $0.vaultID = vault.vaultID }))
                        } label: {
                            Label(sheet.renameLabel, systemImage: "pencil")
                        }
                        .tint(Theme.color("link", scheme))
                        .accessibilityIdentifier("vault-rename-\(vault.vaultID)")
                    }
                }
                .contextMenu {
                    if vault.state != .frozen {
                        Button {
                            store.sendHome(.renameAsked(.with { $0.vaultID = vault.vaultID }))
                        } label: {
                            Label(sheet.renameLabel, systemImage: "pencil")
                        }
                    }
                    Button(role: .destructive) {
                        store.sendHome(.forgetAsked(.with { $0.vaultID = vault.vaultID }))
                    } label: {
                        Label(sheet.forgetLabel, systemImage: "trash")
                    }
                }
            }

            // MAKING AND RESTORING A VAULT LIVE HERE (R-ONBOARD-11), in the same
            // list, so a long roster scrolls them with it.
            Section {
                switcherAction(sheet.makeLabel, spoken: sheet.makeSpoken, icon: "Plus", id: "vault-found-button") {
                    store.sendHome(.make(.init()))
                }
                switcherAction(sheet.restoreLabel, icon: "Refresh", id: "vault-restore-button") {
                    store.sendHome(.restore(.init()))
                }
                .listRowSeparator(.hidden)
                // THE LAST OUTCOME, IN A MEMBER'S WORDS (what a make or a restore came to).
                if !sheet.statusLine.isEmpty {
                    Text(sheet.statusLine)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                        .listRowSeparator(.hidden)
                        .accessibilityIdentifier("vault-status")
                }
            }
            .listSectionSeparator(.hidden, edges: .bottom)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
        }
    }

    private func forgetConfirm(_ ask: AskItem<Centraid_Core_V1_HomeVaultAsk.Forget>) -> some View {
        ConfirmSheet(
            .with {
                $0.title = ask.value.title
                $0.body = ask.value.body
                $0.confirmLabel = ask.value.confirmLabel
                $0.destructive = true
            },
            cancelLabel: ask.value.cancelLabel,
            onConfirm: { store.sendHome(.askConfirmed(.init())) },
            onDismiss: { store.sendHome(.askDismissed(.init())) }
        )
    }

    /// A RENAME IS A SHEET HOLDING THE FIELD, with Save as its one ink button.
    /// The name typed lives in Rust (`RenameTyped`); a refusal is its `failure`.
    private func renameSheet(_ ask: AskItem<Centraid_Core_V1_HomeVaultAsk.Rename>) -> some View {
        SheetRoom(
            title: ask.value.title,
            status: ask.value.failure,
            primary: SheetPrimary(
                label: ask.value.saveLabel,
                enabled: ask.value.canSave,
                identifier: "vault-rename-save"
            ) {
                store.sendHome(.askConfirmed(.init()))
            }
        ) {
            TextField(
                ask.value.fieldLabel,
                text: Binding(
                    get: { ask.value.name },
                    set: { name in store.sendHome(.renameTyped(.with { $0.name = name })) }
                )
            )
                .textInputAutocapitalization(.words)
                .centraidType("body")
                .foregroundStyle(Theme.color("text", scheme))
                .padding(.horizontal, 12)
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                        .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
                )
                .accessibilityIdentifier("vault-rename-field")
        }
    }

    /// One of the switcher's two acts: a mark and a label, a full-width row.
    private func switcherAction(_ label: String, spoken: String = "", icon: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                CentraidIconView(iconKey: icon, tint: Theme.color("text", scheme), size: 18)
                    .frame(width: 30, height: 30)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                            .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
                    )
                Text(label)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color("text", scheme))
                Spacer(minLength: 0)
            }
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(spoken.isEmpty ? label : spoken)
        .accessibilityIdentifier(id)
    }
}

private extension View {
    /// A bar pinned to the top that the page scrolls under: `safeAreaBar` on iOS 26, which brings
    /// the system's scroll edge effect behind it, and a plain inset before.
    @ViewBuilder
    func floatingTopBar<Bar: View>(shown: Bool, @ViewBuilder bar: () -> Bar) -> some View {
        if #available(iOS 26, *) {
            safeAreaBar(edge: .top, spacing: 0) { if shown { bar() } }
        } else {
            safeAreaInset(edge: .top, spacing: 0) { if shown { bar() } }
        }
    }
}
