import SwiftUI

/// Home, the graded springboard, in SwiftUI (#1020, wave A).
///
/// **THIS VIEW DECIDES NOTHING.** `earns_grid`, `springboard`, `things`,
/// `every_tile_unreadable` and `grid_rows` all arrive decided by `HomeMachine`;
/// the switch below reads them. That is what makes it possible for this file and
/// `HomeScreen.kt` to draw the same Home — not discipline, but the absence of
/// anywhere for the two to disagree.
///
/// **EVERY VALUE HERE IS A TOKEN OR A STATED GEOMETRY**, from `Theme.swift` over
/// the emitted table and from the constants below, which carry v0's own names
/// and reasons. SwiftUI's semantic ramp (`.primary`, `.secondary`,
/// `.quaternary`) and SF Symbols are absent on purpose: they are Apple's system,
/// not this one, and the first build of this screen used them — which is exactly
/// why it did not look like the product.
struct HomeView: View {
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme

    private var state: Centraid_Screen_V1_HomeState {
        (try? Centraid_Screen_V1_HomeState(serializedBytes: shell.homeState)) ?? .init()
    }

    var body: some View {
        let home = state
        VStack(alignment: .leading, spacing: 0) {
            // THE LOCKUP FIRST, ALWAYS. It is chrome for every route, and it is
            // drawn above the three-branch switch on purpose: a Home that
            // failed to read still has to say which vault failed.
            VaultHeader(vault: home.vault, shell: shell)
            HomeTitleRow { shell.gatewaySheetOpen = true }
            StatusRibbon(status: home.data.status, shell: shell)

            // THREE BRANCHES, NEVER TWO. A Home that could not load renders its
            // sentence; it does NOT render an empty springboard, which would be
            // eight empty apps invented out of one failure.
            switch home.content {
            case .loading, .none:
                Springboard(data: home.data, shell: shell)
            case let .failure(failure):
                FailureBody(failure: failure)
            case let .data(data):
                if data.springboard == .firstRun {
                    DayOne(data: data, shell: shell)
                } else {
                    Springboard(data: data, shell: shell)
                }
            }
            // A SIBLING OF THE PAGE, NEVER INSIDE IT: the band is never
            // scrolled away, so it cannot live in the scroll view, and nothing
            // subtracts its height from the page because it is a flex peer.
            HomeBand(active: "home") { target in
                // Every band press but Home's lands in a place this wave has
                // not built. `more` opens the one thing that does exist.
                if target == "more" {
                    shell.send(screen: "home", event: HomeEvents.allApps(open: true))
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // EDGE TO EDGE. Painted inside the safe area only, the page ground stops
        // at the notch and the home indicator and the window's own black shows
        // through — which reads as the app sitting in a letterbox.
        .background(Theme.color("bg", scheme).ignoresSafeArea())
        .sheet(isPresented: $shell.gatewaySheetOpen) {
            GatewaySheet(shell: shell)
        }
        // THE TRANSFER RULES (#1025 S4). Reached from the header's own
        // "N originals waiting for Wi-Fi" line, because the control a member
        // wants next is the one that decided the line they just read.
        .sheet(isPresented: $shell.transferRulesOpen) {
            TransferRulesSheet(shell: shell)
        }
        .sheet(isPresented: .constant(home.allAppsSheetOpen)) {
            AllAppsSheet(tiles: home.data.tiles, shell: shell)
        }
        // A REAL BINDING, unlike the one above: this sheet is dismissible by
        // swipe, and a constant binding would leave the state saying it is open
        // over a sheet that is gone — the next press of the lockup would then
        // set a flag that is already set and nothing would appear. Dismissing
        // sends a pick with no id, which the machine reads as exactly what it
        // is: shut the sheet, change no vault.
        .sheet(
            isPresented: Binding(
                get: { home.vaultSheetOpen },
                set: { open in
                    if !open { shell.send(screen: "home", event: HomeEvents.vaultPicked("")) }
                }
            )
        ) {
            VaultSheet(vaults: home.vaults, active: home.vault, shell: shell)
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

/// STATED, never derived: a percentage-width cell can resolve to zero height.
private let mosaicCellHeight: CGFloat = 88

private let hairline = CentraidGeometry.hairline

/// The vault at a glance, and whether the gateway holding it is answering.
///
/// The ONLY feedback channel on this screen — no spinner, no toast, no badge, no
/// red dot. `quiet` is deliberately ignorable and earns no rule; the other two
/// get one rule and one action, never a filled warning plate.
private struct StatusRibbon: View {
    let status: Centraid_Screen_V1_HomeStatus
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme

    private var loud: Bool { status.tone != .quiet }

    var body: some View {
        HStack(spacing: 8) {
            // A ribbon with nothing to say does not reserve a row: on first load
            // the status is quiet and empty, and an empty 32pt band above the
            // grid reads as something that failed to render.
            if loud {
                // ONE RULE in the tone's colour, and nothing else. A filled
                // plate behind a sentence is a second chrome.
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
                Text(status.action)
                    .centraidType("control")
                    .foregroundStyle(Theme.color("link", scheme))
                    .underline()
            }
            // The all-apps listing is a SHEET, opened here and never routed to.
            Button {
                shell.send(screen: "home", event: HomeEvents.allApps(open: true))
            } label: {
                Text("All apps")
                    .centraidType("control")
                    .foregroundStyle(Theme.color("link", scheme))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("home-all-apps")
        }
        .padding(.horizontal, pageMargin)
        .frame(minHeight: loud ? 40 : 32)
        .accessibilityIdentifier("home-status")
        // A quiet signal with nowhere to go is still a true sentence, so it is
        // read as text rather than offered as a button that does nothing.
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            [status.copy, status.action].filter { !$0.isEmpty }.joined(separator: ". ")
        )
    }
}

/// A Home that could not load at all.
///
/// Distinct from every tile being unreadable: that Home loaded and could not
/// read its apps, and still shows them. This one has no grid, because inventing
/// eight empty apps out of one failure is the defect the read law forbids.
private struct FailureBody: View {
    let failure: Centraid_Screen_V1_ReadFailure
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
    let data: Centraid_Screen_V1_HomeData
    @ObservedObject var shell: ShellModel

    /// WHICH tiles are drawn and in WHICH rows both arrive decided.
    ///
    /// `grid_rows` is `HomeMachine`'s packing over the tiles that earned the
    /// grid, so this view looks each id up and draws it. The first build of this
    /// screen packed rows here and let Compose's span logic pack them on
    /// Android, which is two packers for one grid — `.gridCellColumns` being
    /// silently ignored outside a `Grid` is what made that visible, but the
    /// duplication was the defect and one packer in the machine is the fix.
    private var byID: [String: Centraid_Screen_V1_HomeTile] {
        Dictionary(data.tiles.map { ($0.appID, $0) }, uniquingKeysWith: { first, _ in first })
    }

    var body: some View {
        let tiles = byID
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
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
                .accessibilityIdentifier("home-grid")

                if !data.firstMoves.isEmpty {
                    Spacer().frame(height: 16)
                    FirstMovesBand(moves: data.firstMoves, shell: shell)
                }
                ThingsFoot(things: data.things)
            }
            .padding(.horizontal, pageMargin)
            .padding(.top, 4)
            .padding(.bottom, 24)
        }
    }
}

/// One tile: THE HEADER IS INVARIANT — icon chip, name, count, in that order.
///
/// It is what makes eight unlike bodies read as one grid. Home itself takes no
/// identity hue; the hue belongs to the app a tile previews, and it appears on
/// the chip alone.
private struct TileCard: View {
    let tile: Centraid_Screen_V1_HomeTile
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme

    private var name: String {
        CentraidCatalog.byID[tile.appID]?.name ?? tile.appID.capitalized
    }

    /// A count a read ACTUALLY RETURNED, or the withheld glyph.
    ///
    /// The em dash is the honest half: Locker withholds its count by design, and
    /// a `0` there would be a lie about how many secrets a member holds. A
    /// capped count says `N+` rather than printing its ceiling as a fact.
    private var count: String {
        guard tile.hasCount else { return "—" }
        return tile.count.capped ? "\(tile.count.value)+" : "\(tile.count.value)"
    }

    private var spoken: String {
        tile.hasCount ? "\(count) \(tile.countLabel)" : tile.countLabel
    }

    var body: some View {
        Button {
            // TWO THINGS, AND THEY ARE DIFFERENT THINGS (#1025 S5).
            //
            // The machine is told a move was picked — that is Home's own state,
            // and the springboard grades itself on it. The NAVIGATION is the
            // shell's: a `ScreenEffect` carrying a route would put SwiftUI's
            // navigation stack inside a reducer that has no idea one exists,
            // and Compose's is a different stack again.
            //
            // Nothing pushed a route before this. Every screen in the shell was
            // reachable only by being constructed by hand in a preview: the
            // band drew its tabs, the tiles drew their bodies, and a tap moved
            // nothing. It was invisible because Home is the root and Home is
            // what every screenshot showed.
            shell.send(screen: "home", event: HomeEvents.movePicked(tile.appID))
            if let route = TileCard.route(for: tile) { shell.path.append(route) }
        } label: {
            VStack(alignment: .leading, spacing: 16) {
                // Invariant header — see this type's comment.
                HStack(spacing: 8) {
                    AppMark(appID: tile.appID, size: 22)
                    Text(name)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Text(count)
                        .centraidType("mono")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                }
                TileBodyView(tile: tile)
                Spacer(minLength: 0)
            }
            // PADDING FIRST, THEN THE FLOOR. The floor is the CARD's height and
            // v0 states it on the box that carries the padding, so measuring it
            // on the content instead makes every tile a full pad taller than
            // the one Compose draws.
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
        .accessibilityLabel("Open \(name), \(spoken)".trimmingCharacters(in: .whitespaces))
    }

    /// Where this tile leads, or nowhere.
    ///
    /// Three apps have a screen in this shell. The other five have a tile and
    /// no destination yet, and `nil` is the honest answer for them — pushing a
    /// blank cover would be worse than a tap that stays put.
    ///
    /// Notes leads to ITS OWN NOTE, because the tile body names one
    /// (`TileBody.Notes.note_id`) and the editor's read is parameterised by a
    /// note id: a cover opened without one reads nothing.
    static func route(for tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? {
        switch tile.appID {
        case "tally": return .tally
        case "photos": return .photos
        case "notes":
            guard case let .notes(note) = tile.body.kind, !note.noteID.isEmpty else { return nil }
            return .note(note.noteID)
        default: return nil
        }
    }
}

private struct TileBodyView: View {
    let tile: Centraid_Screen_V1_HomeTile
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
    let body_: Centraid_Screen_V1_TileBody
    @Environment(\.colorScheme) private var scheme

    init(body: Centraid_Screen_V1_TileBody) { self.body_ = body }

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

        case let .notes(note):
            // PROSE — a title over an opening line. Notes and Docs shared one
            // body shape in an early draft and the two were indistinguishable.
            VStack(alignment: .leading, spacing: 4) {
                Text(note.title)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(1)
                if !note.excerpt.isEmpty {
                    Text(note.excerpt)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(3)
                }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)

        case let .agenda(agenda):
            VStack(alignment: .leading, spacing: 4) {
                Text(agenda.at)
                    .centraidType("mono")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                Text(agenda.title)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(2)
                // Pinned to the foot: the sparse tiles leave their slack above.
                Spacer(minLength: 0)
                Text(agenda.after)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)

        case let .tasks(tasks):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(tasks.rows, id: \.taskID) { row in
                    HStack(spacing: 8) {
                        // INK, never the app's hue — a hue-filled box is a
                        // second identity. Done is a filled box with NO glyph.
                        RoundedRectangle(cornerRadius: subRadius)
                            .fill(row.done ? Theme.color("accent", scheme) : Color.clear)
                            .overlay(
                                RoundedRectangle(cornerRadius: subRadius)
                                    .strokeBorder(
                                        Theme.color(row.done ? "accent" : "lineStrong", scheme),
                                        lineWidth: hairline
                                    )
                            )
                            .frame(width: 13, height: 13)
                        Text(row.title)
                            .centraidType("small")
                            .foregroundStyle(Theme.color(row.done ? "textFaint" : "text", scheme))
                            .strikethrough(row.done)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)

        case let .people(people):
            VStack(alignment: .leading, spacing: 4) {
                // SATURATED discs, overlapping by a LOGICAL inset so the stack
                // mirrors under RTL rather than stacking the wrong way.
                HStack(spacing: -7) {
                    ForEach(people.faces, id: \.partyID) { face in
                        Text(face.initials)
                            .centraidType("smallStrong")
                            .foregroundStyle(Theme.color("text", scheme))
                            .frame(width: 30, height: 30)
                            .background(Theme.color("bgSunken", scheme))
                            .clipShape(Circle())
                            .overlay(
                                Circle()
                                    .strokeBorder(Theme.color("bgElev", scheme), lineWidth: 1.5)
                            )
                    }
                }
                Spacer(minLength: 0)
                // `more` comes off the header total — never a fabricated 0; an
                // exhausted directory says so plainly.
                Text(
                    people.more > 0
                        ? "+\(people.more) more in your directory"
                        : "That's everyone in your directory"
                )
                .centraidType("small")
                .foregroundStyle(Theme.color("text", scheme))
                .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)

        case let .tally(tally):
            VStack(alignment: .leading, spacing: 4) {
                Text(Money.render(tally.figure))
                    .centraidType("display")
                    .monospacedDigit()
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(1)
                Text(tally.caption)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                // Rendered only when the caller has something true to say.
                if !tally.after.isEmpty {
                    Spacer(minLength: 0)
                    Text(tally.after)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)

        case let .locker(locker):
            VStack(alignment: .leading, spacing: 4) {
                // No lock glyph beside "Locked" — that says it twice. A STATE
                // label, not a control, so the chip is an outline and not a fill.
                Text(locker.locked ? "Locked" : "Unlocked")
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
                // Instructional — never claim a shelf count this tile cannot read.
                Text(locker.locked ? "Opens with your passphrase" : "Open on this device")
                    .centraidType("small")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)

        case .none:
            EmptyView()
        }
    }
}

/// The mosaic bleeds to the card's edge: the CELLS are the mosaic, so there is
/// no ground and no min height, and the negative inset cancels `tilePad`
/// exactly. A cell with no addressable bytes is STILL A CELL — dropping it
/// reflows ten photographs as one blank under a "10".
private struct PhotoMosaic: View {
    let photos: Centraid_Screen_V1_TileBody.Photos
    @Environment(\.colorScheme) private var scheme

    private var waiting: Bool {
        !photos.cells.isEmpty && photos.cells.allSatisfy { !$0.hasThumbnailPath }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
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
                        .frame(height: mosaicCellHeight)
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
            .padding(.top, 8)
            // Grey squares with no explanation read as a failed render.
            if waiting {
                // IT DOES NOT NAME THE GATEWAY any more, and did before: with
                // the byte door built, a vault placed on the device holds its
                // own photographs, and "these fill in when it is back" was a
                // sentence about a connection that is not the reason. What is
                // true in every case is that the bytes are not here yet.
                Text("These photographs are not on this device yet.")
                    .centraidType("mono")
                    .foregroundStyle(Theme.color("textFaint", scheme))
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
}

/// STATIC BARS, NEVER A SPINNER.
///
/// A read in flight holds its slot at full geometry, and the bars stand where
/// the lines will: a spinner over a tile that is about to hold three lines of
/// prose is motion that tells a member nothing and then relayouts under them.
private struct Skeleton: View {
    let body_: Centraid_Screen_V1_TileBody
    @Environment(\.colorScheme) private var scheme

    init(body: Centraid_Screen_V1_TileBody) { self.body_ = body }

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
        .accessibilityLabel("Loading")
    }
}

/// Minor units and an exponent FROM THE VAULT, never the host's locale.
///
/// v0 divided by 100 unconditionally and formatted with the device's locale, so
/// one vault rendered differently on two phones. JPY has no minor unit and BHD
/// has three; the exponent travels with the amount for exactly this.
enum Money {
    static func render(_ money: Centraid_Screen_V1_Money) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = money.currency
        formatter.locale = Locale(identifier: money.locale)
        formatter.minimumFractionDigits = Int(money.exponent)
        formatter.maximumFractionDigits = Int(money.exponent)
        let divisor = pow(10.0, Double(money.exponent))
        let value = Double(money.minor) / divisor
        return formatter.string(from: NSNumber(value: value)) ?? "\(money.minor)"
    }
}

/// Day one: the vault holds nothing anywhere.
///
/// Reached ONLY when every readable tile has settled and is empty. A
/// still-loading vault, or an unreachable replica, gets the ordinary grid —
/// this page is a claim about the vault, and an unanswered read has not
/// earned it.
private struct DayOne: View {
    let data: Centraid_Screen_V1_HomeData
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Nothing in here yet")
                    .centraidType("title")
                    .foregroundStyle(Theme.color("text", scheme))
                Text(
                    "Bring your photographs and documents in and this becomes the front of "
                        + "your own archive."
                )
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
                ForEach(data.firstMoves, id: \.id) { move in
                    MoveRow(move: move, shell: shell)
                }
                ThingsFoot(things: data.things)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .padding(pageMargin)
        }
        .accessibilityIdentifier("home-day-one")
    }
}

/// Deliberately absent: dashed placeholder cards. They scale to identical
/// apologies and they open empty apps. Every move here lands somewhere that can
/// TAKE content.
private struct FirstMovesBand: View {
    let moves: [Centraid_Screen_V1_FirstMove]
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Fill this out")
                .centraidType("eyebrow")
                .foregroundStyle(Theme.color("textFaint", scheme))
            ForEach(moves, id: \.id) { MoveRow(move: $0, shell: shell) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("home-first-moves")
    }
}

private struct MoveRow: View {
    let move: Centraid_Screen_V1_FirstMove
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button {
            shell.send(screen: "home", event: HomeEvents.movePicked(move.id))
        } label: {
            HStack(spacing: 8) {
                // A move carries its OWN icon key: `connectors` is a move and
                // not an app, so there is no mark to look up for it.
                CentraidIconView(
                    iconKey: move.iconKey,
                    tint: Theme.color("textSoft", scheme),
                    size: 16
                )
                VStack(alignment: .leading, spacing: 1) {
                    Text(move.label)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                    Text(move.hint)
                        .centraidType("mono")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                }
                Spacer(minLength: 0)
            }
            // The coarse target minimum, from the table — a nudge you cannot hit
            // is not a nudge.
            .frame(
                maxWidth: .infinity,
                minHeight: CentraidGeometry.targetMinCoarse,
                alignment: .leading
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(move.label). \(move.hint)")
    }
}

/// The one number describing the whole vault, assembled from numbers each true.
///
/// It says "at least" when anything is capped, and says nothing at all until
/// every tile has settled — a moving total rendered as final is a number a
/// member would quote back.
private struct ThingsFoot: View {
    let things: Centraid_Screen_V1_ThingCount
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if things.settled {
            Text(things.capped ? "at least \(things.total) things" : "\(things.total) things")
                .centraidType("mono")
                .foregroundStyle(Theme.color("textFaint", scheme))
                .padding(.top, 16)
        }
    }
}

/// The all-apps listing is a SHEET and never a destination.
private struct AllAppsSheet: View {
    let tiles: [Centraid_Screen_V1_HomeTile]
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        List(tiles, id: \.appID) { tile in
            HStack(spacing: 8) {
                AppMark(appID: tile.appID, size: 22)
                Text(CentraidCatalog.byID[tile.appID]?.name ?? tile.appID.capitalized)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color("text", scheme))
            }
        }
        .accessibilityIdentifier("home-all-apps-sheet")
    }
}

/// THE VAULT SWITCHER, and the only control that changes what the whole app is
/// reading (#1020, wave A).
///
/// It lists EVERY vault the device holds, the open one included and ticked. A
/// switcher that listed only the others would never show a member where they
/// already are, which is the fact most of them opened it to check.
///
/// A row with no id cannot be switched to and is not drawn: a vault whose file
/// would not open is a door that does not open, and offering it is worse than
/// omitting it. The roster the shell hands in has already dropped those.
private struct VaultSheet: View {
    let vaults: [Centraid_Screen_V1_VaultLockup]
    let active: Centraid_Screen_V1_VaultLockup
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme
    /// THE VAULT A CONFIRMATION IS ABOUT, and not a bare `Bool`: an alert that
    /// only knew it was open could not name what it was about to delete, and
    /// "Forget this vault?" over a list of four is the dialogue a member taps
    /// through and then regrets.
    @State private var forgetting: Centraid_Screen_V1_VaultLockup?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Vaults")
                .centraidType("title")
                .foregroundStyle(Theme.color("text", scheme))
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.top, 20)
                .padding(.bottom, 12)

            // ONE VAULT IS NOT A CHOICE, and the sheet says so rather than
            // drawing a list of one and letting a member tap it to no effect.
            // It stays true now the rows carry Forget: the sentence is about
            // switching, which is what the sheet is for, and forgetting the
            // only vault a device holds is a thing a member may still do.
            if vaults.count <= 1 {
                Text("This device holds one vault.")
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .padding(.horizontal, CentraidGeometry.pageMargin)
            }

            List(vaults, id: \.vaultID) { vault in
                Button {
                    shell.send(
                        screen: "home",
                        event: HomeEvents.vaultPicked(vault.vaultID)
                    )
                } label: {
                    HStack(spacing: 12) {
                        Text(String(vault.vaultName.prefix(1)).uppercased())
                            .centraidType("smallStrong")
                            .foregroundStyle(Theme.color("text", scheme))
                            .frame(width: 30, height: 30)
                            .background(
                                Theme.color("bgSunken", scheme),
                                in: RoundedRectangle(cornerRadius: 7)
                            )
                        VStack(alignment: .leading, spacing: 0) {
                            Text(vault.vaultName.isEmpty ? "Unnamed vault" : vault.vaultName)
                                .centraidType("smallStrong")
                                .foregroundStyle(Theme.color("text", scheme))
                            // THE SAME SECOND LINE THE HEADER DRAWS, from the
                            // same `stateLine` and the same `RosterChanged`
                            // stream (#1025 S7-9). A switcher that showed only
                            // names made a member switch INTO a vault to find
                            // out whether it had synced.
                            if !vault.stateLine.isEmpty {
                                Text(vault.stateLine)
                                    .centraidType("mono")
                                    .foregroundStyle(Theme.color("textFaint", scheme))
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: 0)
                        // THE TICK IS THE WHOLE POINT of listing the open one.
                        if vault.vaultID == active.vaultID {
                            CentraidIconView(
                                iconKey: "Check",
                                tint: Theme.color("link", scheme),
                                size: 18
                            )
                            .accessibilityLabel("Currently open")
                        }
                    }
                    .frame(minHeight: 44)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("vault-row-\(vault.vaultID)")
                // FORGET IS A SWIPE AND NOT A ROW CONTROL (#1025 S7-9). The
                // row's whole width is the switch — the one thing a member
                // opens this sheet to do — so a second tappable target inside
                // it would sit in the way of the first. A destructive trailing
                // swipe is where iOS puts a delete, and `allowsFullSwipe` is
                // off because this deletes the device's copy and a full swipe
                // is a gesture a thumb makes by accident.
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button(role: .destructive) {
                        forgetting = vault
                    } label: {
                        Label("Forget", systemImage: "trash")
                    }
                    .accessibilityIdentifier("vault-forget-\(vault.vaultID)")
                }
            }
            .listStyle(.plain)
        }
        .background(Theme.color("bg", scheme).ignoresSafeArea())
        .accessibilityIdentifier("home-vault-sheet")
        // THE ALERT NAMES THE VAULT, because "Forget" deletes this device's
        // copy — the replica, its bytes, the pairing record and the endpoint
        // key — and the only way back is to pair again with a fresh ticket.
        // The gateway keeps this device enrolled: forgetting is local, which
        // is why the sentence says what it removes and not that the vault is
        // gone.
        .alert(
            "Forget \(forgetting?.vaultName.isEmpty == false ? forgetting!.vaultName : "this vault")?",
            isPresented: Binding(
                get: { forgetting != nil },
                set: { if !$0 { forgetting = nil } }
            ),
            presenting: forgetting
        ) { vault in
            Button("Forget", role: .destructive) {
                shell.forget(vaultID: vault.vaultID)
                forgetting = nil
            }
            Button("Cancel", role: .cancel) { forgetting = nil }
        } message: { _ in
            Text("This device deletes its copy. Nothing on your gateway changes, and you can pair again with a new ticket.")
        }
    }
}

/// Encoded events, so a view forwards bytes and never a decision.
enum HomeEvents {
    static func movePicked(_ id: String) -> Data {
        var event = Centraid_Screen_V1_HomeEvent()
        event.movePicked = .with { $0.moveID = id }
        return (try? event.serializedBytes()) ?? Data()
    }

    static func opened() -> Data {
        var event = Centraid_Screen_V1_HomeEvent()
        event.opened = .init()
        return (try? event.serializedBytes()) ?? Data()
    }

    static func refreshed() -> Data {
        var event = Centraid_Screen_V1_HomeEvent()
        event.refreshed = .init()
        return (try? event.serializedBytes()) ?? Data()
    }

    static func vaultSwitch() -> Data {
        var event = Centraid_Screen_V1_HomeEvent()
        event.vaultSwitch = .init()
        return (try? event.serializedBytes()) ?? Data()
    }

    /// An empty id is a DISMISSAL: shut the sheet, change no vault.
    static func vaultPicked(_ id: String) -> Data {
        var event = Centraid_Screen_V1_HomeEvent()
        event.vaultPicked = .with { $0.vaultID = id }
        return (try? event.serializedBytes()) ?? Data()
    }

    static func allApps(open: Bool) -> Data {
        var event = Centraid_Screen_V1_HomeEvent()
        event.allApps = .with { $0.open = open }
        return (try? event.serializedBytes()) ?? Data()
    }
}
