import SwiftUI

import CentraidShared

// HOME, DRAWN FROM RUST (#1135, lane H1). The springboard is a Rust screen
// (`crates/screens/src/shell`): it reads one tile per app, grades the grid,
// words every tile and the lockup, and carries the route each tile opens.
// This file only draws `Centraid_Core_V1_HomeState` and sends `HomeEvent`s; it
// writes no copy, counts nothing and names no destination.

/// The words a skeleton tile speaks, handed down from `HomeState.loadingLabel`.
private struct HomeLoadingLabelKey: EnvironmentKey {
    static let defaultValue = ""
}

extension EnvironmentValues {
    fileprivate var homeLoadingLabel: String {
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

/// The place the band is showing: Home's springboard, or Chat/Backup drawn in
/// its place (those two are still hosted by `ShellModel.tab`).
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
    @ObservedObject var shell: ShellModel
    @ObservedObject var store: ScreenStore
    @Binding var chatTyping: Bool
    @Environment(\.colorScheme) private var scheme

    private var home: Centraid_Core_V1_HomeState? {
        store.homeInstance.flatMap { store.views[$0] }?.homeState
    }

    /// THE BAND'S PLACES: Rust's (`Navigation.band`, which carries the Chat place now that the
    /// `chat` tab is registered), plus TRANSITIONALLY the Backup place this shell still hosts
    /// itself. Lane H2 registers it as a Rust tab, after which the insert below is deleted.
    private var places: [BandPlace] {
        let active = shell.tab == .chat ? BandPolicy.shared.PLACE_CHAT : shell.tab == .backup ? BandPolicy.shared.PLACE_BACKUP : BandPolicy.shared.PLACE_HOME
        var places = (store.navigation?.band.tabs ?? []).map { tab in
            BandPlace(
                id: tab.tab,
                label: tab.label,
                spoken: tab.tab == active ? tab.spoken : tab.label,
                iconKey: tab.iconKey,
                selected: tab.tab == active
            )
        }
        if !places.contains(where: { $0.id == BandPolicy.shared.PLACE_BACKUP }) {
            places.append(
                BandPlace(
                    id: BandPolicy.shared.PLACE_BACKUP,
                    label: HomeWords.shared.BAND_BACKUP,
                    spoken: HomeWords.shared.BAND_BACKUP_SPOKEN + (active == BandPolicy.shared.PLACE_BACKUP ? ", " + SharedCopy.shared.BAND_CURRENT_SPOKEN : ""),
                    iconKey: "Backup",
                    selected: active == BandPolicy.shared.PLACE_BACKUP
                )
            )
        }
        return places
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
                // does, under the vault's lockup: the backup it describes is
                // that vault's, and the band stays where it is.
                VaultHeader(bar: home.bar, shell: shell, store: store)
                RustScreenHost(shell: shell, entry: shell.backupEntry)
                    .id(shell.backupEntry.token)
            } else {
                homeContent(home)
            }

            // A SIBLING OF THE PAGE, NEVER INSIDE IT: the band is never scrolled away.
            ShellBanner(shell: shell)
            if !(shell.tab == .chat && chatTyping) {
                HomeBand(places: places) { target in
                    // A place whose tab Rust holds is selected by Rust.
                    if target != BandPolicy.shared.PLACE_HOME, !store.entries(of: target).isEmpty { store.selectTab(target) }
                    switch target {
                    case BandPolicy.shared.PLACE_HOME: shell.openHomeTab()
                    // PRESSED WHILE CHAT IS SHOWING it only shuts the drawer.
                    case BandPolicy.shared.PLACE_CHAT:
                        if shell.tab == .chat {
                            shell.chat.toggleDrawer(false)
                        } else {
                            shell.openChatTab()
                        }
                    case BandPolicy.shared.PLACE_BACKUP: shell.openBackup()
                    default: break
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // EDGE TO EDGE: the page ground reaches the notch and the home indicator.
        .background(Theme.color("bg", scheme).ignoresSafeArea())
        // THE CHAT BELONGS TO THE VAULT IN FRONT: when it changes the thread,
        // its session and its cards are the old vault's and are dropped.
        .onChange(of: home.bar.vault.vaultID, initial: true) { _, id in
            shell.vaultChanged(to: id)
        }
        // A COVER WAS POPPED BACK TO HOME: the Locker's open state and any tile
        // may have moved without a table changing.
        .onAppear { store.sendHome(.shown(.init())) }
        .environment(\.homeLoadingLabel, home.loadingLabel)
        // THE TRANSFER RULES (#1025 S4), reached from the "originals waiting" line.
        .sheet(isPresented: $shell.transferRulesOpen) {
            TransferRulesSheet(shell: shell)
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
        // THE LOCKUP FIRST, ALWAYS: a Home that failed to read still has to say
        // which vault failed.
        VaultHeader(bar: home.bar, shell: shell, store: store)
        if home.hasStatus {
            StatusRibbon(status: home.status, store: store)
        }
        // THREE BRANCHES, NEVER TWO. A Home that could not load renders its
        // sentence; it does NOT render an empty springboard.
        switch home.content {
        case .loading, .none:
            Springboard(data: Centraid_Core_V1_HomeData(), shell: shell)
        case let .failure(failure):
            FailureBody(failure: failure)
        case let .data(data):
            VStack(alignment: .leading, spacing: 0) {
                if data.springboard == .firstRun {
                    DayOne(data: data, shell: shell)
                } else {
                    Springboard(data: data, shell: shell)
                }
            }
        }
    }
}

// MARK: - the grid's stated geometry, with v0's names and v0's reasons

/// `R.margin.m` — the phone's page margin, emitted beside the tokens.
private let pageMargin = CentraidGeometry.pageMargin

/// A FLOOR, never a height: a fixed height slices bodies at 150% text.
private let tileMinHeight: CGFloat = 152

/// `R.gap.m`. The mosaic's bleed cancels exactly this, which is why it is one name.
private let tilePad: CGFloat = 12

/// The gutter between slots — v0's two 4pt half-gutters, added up.
private let tileGap: CGFloat = 8

/// The container rung.
private let tileRadius: CGFloat = 12

/// The one sub-control rung, for a detail nested inside a control.
private let subRadius: CGFloat = 4

/// The control rung.
private let controlRadius: CGFloat = 7

/// One row, fixed count — only the cell CONTENTS change, never the count.
private let mosaicSlots = 4

/// A FLOOR AND NOT A HEIGHT. `mosaicCss` is `flex:1;min-height:0` over
/// `grid-auto-rows:1fr`, so the strip STRETCHES into whatever the card has
/// left and this is only the rung below which it will not go. It is STATED
/// rather than derived for the reason it always was: a percentage-width cell
/// has no intrinsic height of its own and can resolve to zero.
private let mosaicCellHeight: CGFloat = 88

private let hairline = CentraidGeometry.hairline

/// THE HUE KEY'S SPELLING IN THE EMITTED TABLE, and nothing more.
///
/// Rust's identity wheel decides WHICH of the eight a face gets and puts
/// the answer on the wire; this is the eight-row spelling that turns that key
/// into a `Theme` role, and `HomeScreen.kt` carries the same eight. It is a
/// dictionary and not `"c" + key.capitalized` because the string form would
/// hand any key at all to `Theme.color`, which trips a `preconditionFailure`
/// correctly for a role that does not exist — the wrong failure for a launcher
/// tile drawing whatever a producer sent. `PartyHueWheelSpec` asserted every key
/// has a role in the emitted table and that both view trees name all eight.
private let partyHueRoles: [String: String] = [
    "rose": "cRose",
    "amber": "cAmber",
    "ochre": "cOchre",
    "forest": "cForest",
    "teal": "cTeal",
    "slate": "cSlate",
    "indigo": "cIndigo",
    "violet": "cViolet",
]

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
                    .lineLimit(1)
                    .truncationMode(.tail)
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

/// A Home that could not load at all (no vault, or the read failed).
///
/// This Home has no grid, because inventing eight empty apps out of one failure
/// is the defect the read law forbids.
private struct FailureBody: View {
    let failure: Centraid_Core_V1_Failure
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(failure.sentence)
                .centraidType("small")
                .foregroundStyle(Theme.color("text", scheme))
            // Present only when there is something a member can do.
            if !failure.remedy.isEmpty {
                Text(failure.remedy)
                    .centraidType("mono")
                    .foregroundStyle(Theme.color("textFaint", scheme))
            }
        }
        .padding(pageMargin)
        .accessibilityIdentifier("home-failure")
    }
}

private struct Springboard: View {
    let data: Centraid_Core_V1_HomeData
    @ObservedObject var shell: ShellModel

    var body: some View {
        ScrollView {
            TileGrid(data: data, shell: shell)
                .padding(.horizontal, pageMargin)
                .padding(.top, 10)
                .padding(.bottom, 24)
        }
    }
}

/// EVERY APP IS A TILE (R-ONBOARD-11), in the rows the machine packed: an app
/// with nothing in it draws what to do, so Docs, Agenda and People are
/// always here to open. Shared by the springboard and day one.
private struct TileGrid: View {
    let data: Centraid_Core_V1_HomeData
    @ObservedObject var shell: ShellModel

    /// `grid_rows` is Rust's packing, so this view looks each id up
    /// and draws it. The first build packed rows here and let Compose's span
    /// logic pack them on Android — two packers for one grid, and
    /// `.gridCellColumns` is silently ignored outside a `Grid`. One packer, in
    /// the machine, is the fix.
    private var byID: [String: Centraid_Core_V1_HomeTile] {
        Dictionary(data.tiles.map { ($0.appID, $0) }, uniquingKeysWith: { first, _ in first })
    }

    var body: some View {
        let tiles = byID
        VStack(spacing: tileGap) {
            ForEach(Array(data.gridRows.enumerated()), id: \.offset) { _, row in
                let drawn = row.appIds.compactMap { tiles[$0] }
                HStack(spacing: tileGap) {
                    ForEach(drawn, id: \.appID) { tile in
                        TileCard(tile: tile, shell: shell)
                    }
                    // A lone small keeps its column rather than
                    // stretching over both: a tile that changed width
                    // with its neighbours' arrival would be layout
                    // overruling the body rule that chose its size.
                    if drawn.count == 1 && !drawn[0].wide { Color.clear }
                }
                .frame(maxWidth: .infinity)
                // THE ROW HUGS ITS TALLEST TILE. Without this each card's
                // foot-pinning `Spacer` is flexible all the way up
                // through the scroll view, which proposes its own
                // height — so three rows split a screen between them and
                // every tile came out three times its floor.
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        // A CONTAINER, OR THE ID LEAKS: on a plain stack SwiftUI hands its
        // identifier down to every child, so each tile read `home-grid` and no
        // `home-tile-<appId>` could be selected.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home-grid")
    }
}
/// One tile: THE HEADER IS INVARIANT — icon chip, name, count, in that order.
///
/// It is what makes eight unlike bodies read as one grid. Home itself takes no
/// identity hue; the hue belongs to the app a tile previews, and it appears on
/// the chip alone. A tap pushes the route the tile carries.
private struct TileCard: View {
    let tile: Centraid_Core_V1_HomeTile
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme

    /// A count a read ACTUALLY RETURNED, or the withheld glyph: a count the read
    /// did not return is not a `0`. A capped count says `N+`.
    private var count: String {
        guard tile.hasCount else { return "—" }
        return tile.count.capped ? "\(tile.count.value)+" : "\(tile.count.value)"
    }

    /// PHOTOS TAKES THE CARD'S SLACK ITSELF, so it is the one body that gets no
    /// trailing `Spacer` under it (one flexible child per card).
    private var bodyTakesTheSlack: Bool {
        if case .photos = tile.body.kind { return true }
        return false
    }

    var body: some View {
        Button {
            // A tile with no route is not tappable (loading, or unreadable).
            if tile.hasRoute { shell.open(tile.route) }
        } label: {
            VStack(alignment: .leading, spacing: 16) {
                // Invariant header — see this type's comment.
                HStack(spacing: 8) {
                    AppMark(appID: tile.appID, size: 22)
                    Text(tile.name)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Text(count)
                        .centraidType("mono")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                }
                TileBodyView(tile: tile)
                if !bodyTakesTheSlack { Spacer(minLength: 0) }
            }
            // PADDING FIRST, THEN THE FLOOR: the floor is the CARD's height.
            .padding(tilePad)
            .frame(maxWidth: .infinity, minHeight: tileMinHeight, alignment: .topLeading)
            .background(Theme.color("bgElev", scheme))
            .clipShape(RoundedRectangle(cornerRadius: tileRadius))
            .overlay(
                RoundedRectangle(cornerRadius: tileRadius)
                    .strokeBorder(Theme.color("line", scheme), lineWidth: hairline)
            )
        }
        .buttonStyle(.plain)
        // Keyed on the app id. The label carries the live count, so it changes
        // with the vault; the id does not.
        .accessibilityIdentifier("home-tile-\(tile.appID)")
        .accessibilityLabel(tile.accessibilityLabel)
    }
}

private struct TileBodyView: View {
    let tile: Centraid_Core_V1_HomeTile
    @Environment(\.colorScheme) private var scheme

    /// Locker's body is a STATE and not a query result, and Photos draws its own
    /// waiting state cell by cell — neither falls through to the generic
    /// skeleton or to the invitation, because for both of them the generic
    /// answer is wrong rather than merely plain.
    private var drawsInEveryStatus: Bool {
        switch tile.body.kind {
        case .locker, .photos: return true
        default: return false
        }
    }

    var body: some View {
        if drawsInEveryStatus {
            ContentBody(body: tile.body)
        } else if tile.status == .loading {
            Skeleton(body: tile.body)
        } else if tile.status != .content {
            // What to DO, never what is missing. A quiet tile is an invitation.
            Text(tile.emptyCopy)
                .centraidType("control")
                .foregroundStyle(Theme.color("textFaint", scheme))
                .frame(maxWidth: .infinity, alignment: .topLeading)
        } else {
            ContentBody(body: tile.body)
        }
    }
}
private struct ContentBody: View {
    let body_: Centraid_Core_V1_HomeTileBody
    @Environment(\.colorScheme) private var scheme

    init(body: Centraid_Core_V1_HomeTileBody) { self.body_ = body }

    var body: some View {
        switch body_.kind {
        case let .photos(photos):
            PhotoMosaic(photos: photos)

        case let .docs(docs):
            // RULED ROWS — Docs is a file list, and the rule is what says so.
            VStack(spacing: 0) {
                ForEach(Array(docs.rows.enumerated()), id: \.offset) { index, row in
                    if index > 0 {
                        Rectangle()
                            .fill(Theme.color("line", scheme))
                            .frame(height: hairline)
                    }
                    HStack(spacing: 8) {
                        Text(row.name)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("text", scheme))
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        // No recorded size renders NOTHING, never a zero.
                        if !row.size.isEmpty {
                            Text(row.size)
                                .centraidType("mono")
                                .foregroundStyle(Theme.color("textFaint", scheme))
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)

        case let .notes(notes):
            NotesShelf(notes: notes)

        case let .agenda(agenda):
            VStack(alignment: .leading, spacing: 4) {
                if !agenda.at.isEmpty {
                    Text(agenda.at)
                        .centraidType("mono")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }
                Text(agenda.title)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(2)
                // Pinned to the foot: the sparse tiles leave their slack above.
                Spacer(minLength: 0)
                // TODAY'S DUE TASKS (#1128): the machine's words, drawn after a
                // round mark. INK, never the app's hue — a hue-filled circle is a
                // second identity.
                if agenda.dueCount > 0 {
                    HStack(spacing: 6) {
                        Circle()
                            .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: hairline)
                            .frame(width: 13, height: 13)
                        Text(agenda.dueLabel)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("text", scheme))
                            .lineLimit(1)
                            .layoutPriority(1)
                        Text(agenda.dueTitle)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textFaint", scheme))
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                }
                if !agenda.after.isEmpty {
                    Text(agenda.after)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)

        case let .people(people):
            VStack(alignment: .leading, spacing: 4) {
                // SATURATED discs, overlapping by a LOGICAL inset so the stack
                // mirrors under RTL rather than stacking the wrong way.
                HStack(spacing: -7) {
                    ForEach(people.faces, id: \.partyID) { face in
                        // THE PARTY'S OWN HUE, not a grey disc. `face.color` is
                        // the key Rust already resolved with the one
                        // port of the identity wheel; all this does is spell
                        // the emitted role. An unrecognised key draws the
                        // neutral disc rather than reaching `Theme.color`,
                        // which trips a `preconditionFailure` by design — a
                        // tile is not the place to take the shell down over a
                        // hue.
                        let hue = face.hasColor ? partyHueRoles[face.color] : nil
                        Circle()
                            .fill(Theme.color(hue ?? "bgSunken", scheme))
                            .overlay(
                                // THE INITIALS STAY INSIDE THEIR OWN DISC. A
                                // bare `Text` framed at the disc's width drew
                                // at its natural width, so two letters ran
                                // under the next disc and read as one word
                                // ("GRMACO"). Inset by the 7pt the next disc
                                // covers ON BOTH SIDES, so centred letters end
                                // before the overlap; one line, shrunk to fit.
                                Text(face.initials)
                                    .centraidType("smallStrong")
                                    // `textInv` is the SOLVED foreground for a
                                    // filled identity disc (`DESIGN.md`'s rule
                                    // 7 — `onAccent` in the hand-off's role
                                    // map). Ink on a saturated fill is the
                                    // contrast failure this tile had.
                                    .foregroundStyle(Theme.color(hue != nil ? "textInv" : "text", scheme))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.5)
                                    .padding(.horizontal, 7)
                            )
                            .overlay(
                                Circle()
                                    .strokeBorder(Theme.color("bgElev", scheme), lineWidth: 1.5)
                            )
                            .frame(width: 30, height: 30)
                            .clipShape(Circle())
                    }
                }
                Spacer(minLength: 0)
                // The machine's words for `more` (off the header total).
                Text(people.moreLabel)
                .centraidType("small")
                .foregroundStyle(Theme.color("text", scheme))
                .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)

        case let .locker(locker):
            VStack(alignment: .leading, spacing: 4) {
                // No lock glyph beside "Locked" — that says it twice. A STATE
                // label, not a control, so the chip is an outline and not a fill.
                // THE MACHINE'S WORD FOR THE STATE (R-1047-L7): "Locked" or
                // "Open", from Rust — never spelt here.
                Text(locker.stateLabel)
                    .centraidType("eyebrow")
                    .foregroundStyle(
                        scheme.centraidMarks["locker"]?.hue ?? Theme.color("text", scheme)
                    )
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .overlay(
                        RoundedRectangle(cornerRadius: controlRadius)
                            .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: hairline)
                    )
                Spacer(minLength: 0)
                // The machine's line — never a shelf count it cannot read.
                Text(locker.line)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)

        case let .money(spent):
            // THIS MONTH'S SPENDING, one figure per currency and never a sum
            // across them. The amounts are the core's (rendered by the kit's one
            // formatter) and the caption is the machine's.
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(spent.amounts.enumerated()), id: \.offset) { _, amount in
                    Text(amount)
                        .centraidType("mono")
                        .monospacedDigit()
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Text(spent.caption)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)

        case let .health(health):
            // TODAY'S STEPS AND LAST NIGHT'S SLEEP (#1129), every word the
            // machine's: an empty figure is a day with no steps yet, drawn as
            // the caption alone and never as a 0, and an empty line is no sleep.
            VStack(alignment: .leading, spacing: 2) {
                if !health.figure.isEmpty {
                    Text(health.figure)
                        .centraidType("mono")
                        .monospacedDigit()
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                }
                Text(health.caption)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if !health.line.isEmpty {
                    Text(health.line)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)

        case .none:
            EmptyView()
        }
    }
}
/// NOTES' SHELF (`HomeNotesTile`): the notebooks holding notes in soft ink,
/// each with its count, and the newest note's title alone at the foot. A vault
/// with nothing filed draws its newest notes instead, and no foot — the first
/// of them IS the newest.
///
/// QUIET ON PURPOSE. A first build drew a spine per notebook, a rule over the
/// foot and an edited line under it: five marks in a half-width body, and it
/// read as congested. What is left is two inks and air — the shelf soft, the
/// note full — and every line is one line, truncated rather than wrapped.
private struct NotesShelf: View {
    let notes: Centraid_Core_V1_HomeTileBody.Notes
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if notes.notebooks.isEmpty {
                ForEach(notes.recent, id: \.noteID) { note in
                    Text(note.title)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                }
            } else {
                ForEach(notes.notebooks, id: \.notebookID) { notebook in
                    HStack(spacing: 8) {
                        Text(notebook.name)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        Text("\(notebook.noteCount)")
                            .centraidType("mono")
                            .foregroundStyle(Theme.color("textFaint", scheme))
                    }
                }
                // Pinned to the foot: the shelf leaves its slack above.
                Spacer(minLength: 0)
                Text(notes.title)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
}
/// The mosaic bleeds to the card's edge: the CELLS are the mosaic, so there is
/// no ground and no min height, and the negative inset cancels `tilePad`
/// exactly. Which assets fill the cells is Rust's: it
/// steps over an asset with no thumbnail, and keeps the newest four as grey
/// cells only when none of the window can be drawn.
private struct PhotoMosaic: View {
    let photos: Centraid_Core_V1_HomeTileBody.Photos
    @Environment(\.colorScheme) private var scheme

    private var waiting: Bool {
        !photos.cells.isEmpty && photos.cells.allSatisfy { !$0.hasThumbnailPath }
    }

    var body: some View {
        // 8 AND NOT 4 BETWEEN THE STRIP AND ITS SENTENCE: `mosaicNoteCss` is
        // `padding-top: R.gap.s`, and the note is the mosaic's SIBLING in the
        // template rather than a second line inside a body wrapper, so it does
        // not take that wrapper's `gap: R.gap.xs`.
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 2) {
                ForEach(0 ..< mosaicSlots, id: \.self) { index in
                    let cell = index < photos.cells.count ? photos.cells[index] : nil
                    Rectangle()
                        // THE GROUND UNDER THE PHOTOGRAPH, and the whole cell
                        // when there is none. A cell with no addressable bytes
                        // keeps its slot rather than collapsing, so the mosaic
                        // does not reflow as thumbnails land.
                        .fill(Theme.color(cell == nil ? "skel" : "bgSunken", scheme))
                        .frame(maxWidth: .infinity)
                        // A FLOOR, so the strip can take the slack the card's
                        // own floor leaves and finish flush with its edge.
                        .frame(minHeight: mosaicCellHeight, maxHeight: .infinity)
                        .overlay {
                            if let path = cell?.thumbnailPath, !path.isEmpty {
                                ContentImage(path: path)
                            }
                        }
                        // CLIPPED AT THE CELL. `scaledToFill` deliberately
                        // overflows its frame, and an unclipped overflow paints
                        // over the neighbouring cell.
                        .clipped()
                }
            }
            .padding(.horizontal, -tilePad)
            // NO TOP OF ITS OWN, BECAUSE THE 8 IN `mosaicCss` IS NOT AN EXTRA
            // 8 — IT IS THE HALF THIS TILE DOES NOT OTHERWISE GET.
            //
            // The reference's template is the whole argument, and it took three
            // readings on 2026-09-22 to get right. Every other tile's body is
            // wrapped in `bodyWrapCss`, which carries `padding-top: R.gap.s`;
            // the mosaic is a DIRECT CHILD of the tile wrap and is not wrapped
            // in it at all. So a list reads `headCss` padding-bottom 8 + the
            // wrapper's 8 = 16, and the mosaic reads `headCss` 8 + its own
            // `margin-top: R.gap.s` = 16. THE SAME 16. Photos is not special.
            //
            // Our `VStack(spacing: 16)` already stands in for both halves at
            // once, so an 8 here was a third helping and put the strip 24 down
            // — the dead band under the header that was reported, correctly, as
            // too much gap. Removed, then restored on a misreading of
            // `mosaicCss` in isolation, then removed again once the TEMPLATE
            // was read: `<sc-if isMosaic>` sits outside every `bodyWrapCss`.
            // AND IT BLEEDS TO THE FLOOR, which is the THIRD margin in the same
            // rule and the one this file had been missing: `margin: R.gap.s
            // -R.gap.m -R.gap.m` cancels the card's bottom padding exactly as
            // it cancels its sides, so the photographs finish ON the card's
            // edge rather than on a band of card ground above it.
            //
            // The reference drops it in the waiting state and so does this
            // (`margin: … ' + (grey ? '0' : '-' + R.gap.m)`): the sentence under
            // the strip needs the 12 back, and a line of type bled past the
            // card's edge is clipped rather than merely tight.
            .padding(.bottom, waiting && !photos.absentLine.isEmpty ? 0 : -tilePad)
            // Grey squares with no explanation read as a failed render.
            if waiting, !photos.absentLine.isEmpty {
                // IT DOES NOT NAME THE GATEWAY any more, and did before: with
                // the byte door built, a vault placed on the device holds its
                // own photographs, and "these fill in when it is back" was a
                // sentence about a connection that is not the reason. What is
                // true in every case is that the bytes are not here yet.
                Text(photos.absentLine)
                    .centraidType("mono")
                    .foregroundStyle(Theme.color("textFaint", scheme))
            }
        }
        // THE MOSAIC IS THE CARD'S SLACK-TAKER, and `maxHeight: .infinity` is
        // how it says so — `mosaicCss` is `flex:1;min-height:0`. It only holds
        // while nothing else in the card competes for the same slack; see
        // `TileCard.bodyTakesTheSlack`.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
/// STATIC BARS, NEVER A SPINNER.
///
/// A read in flight holds its slot at full geometry, and the bars stand where
/// the lines will: a spinner over a tile that is about to hold three lines of
/// prose is motion that tells a member nothing and then relayouts under them.
private struct Skeleton: View {
    let body_: Centraid_Core_V1_HomeTileBody
    @Environment(\.colorScheme) private var scheme
    @Environment(\.homeLoadingLabel) private var loadingLabel

    init(body: Centraid_Core_V1_HomeTileBody) { self.body_ = body }

    private var widths: [CGFloat] {
        // Key by POSITION, not width — People's skeleton is two bars of the
        // SAME width.
        if case .people = body_.kind { return [0.46, 0.46] }
        return [0.88, 0.70, 0.54]
    }

    var body: some View {
        GeometryReader { proxy in
            VStack(alignment: .leading, spacing: 9) {
                ForEach(Array(widths.enumerated()), id: \.offset) { _, fraction in
                    RoundedRectangle(cornerRadius: subRadius)
                        .fill(Theme.color("bgSunken", scheme))
                        .frame(width: proxy.size.width * fraction, height: 10)
                }
            }
            .padding(.top, 4)
        }
        // Three 10pt bars, two 9pt gaps and the 4pt lead-in: stated, because a
        // `GeometryReader` has no intrinsic height and would otherwise eat the
        // whole card.
        .frame(height: 56)
        .accessibilityLabel(loadingLabel)
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
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(data.dayOneTitle)
                    .centraidType("title")
                    .foregroundStyle(Theme.color("text", scheme))
                Text(data.dayOneBody)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
                TileGrid(data: data, shell: shell)
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
                    .frame(minHeight: 44)
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
