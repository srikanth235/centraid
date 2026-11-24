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
                    // ONE LAYOUT AT EVERY STAGE (2026-11-17): day zero is the same grid with the welcome
                    // card above it, which Rust words and sends only until the first add or import.
                    Springboard(data: data, shell: shell, header: scrolling)
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
            VStack(alignment: .leading, spacing: 12) {
                // THE WELCOME CARD: day zero only, one sentence, gone after the first add or import.
                if !data.welcome.isEmpty {
                    WelcomeCard(welcome: data.welcome)
                }
                WidgetGrid(data: data, shell: shell)
            }
            .padding(.horizontal, pageMargin)
            .padding(.top, 10)
            .padding(.bottom, 24)
        }
        // THE CLOCK STAYS READABLE (#1202): the lockup scrolls with the page at the largest text, so
        // the tiles passed under the status bar with the time drawn over their words. A strip of the
        // page's ground the height of the status bar covers them (only when the lockup scrolls).
        .overlay(alignment: .top) {
            if header != nil {
                GeometryReader { proxy in
                    Surface.page
                        .frame(height: proxy.safeAreaInsets.top)
                        .offset(y: -proxy.safeAreaInsets.top)
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
    }
}

/// THE WELCOME CARD (`FirstHome`): one sentence above the grid, no button.
private struct WelcomeCard: View {
    let welcome: String
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Text(welcome)
            .centraidType("small")
            .foregroundStyle(Theme.color("textSoft", scheme))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Surface.card, in: RoundedRectangle(cornerRadius: Theme.radius("lg", scheme)))
            .accessibilityIdentifier("home-welcome")
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
