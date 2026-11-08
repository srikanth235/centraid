import SwiftUI
import UIKit

// THE CALENDAR'S GRIDS (#1173): the week strip, the hour grid of Day and Week, the Month in
// its two styles, the Year, the floating Today key and the view menu.
//
// **THE VIEW DECIDES NOTHING.** Rust lays every grid out (`AgendaWeekStrip`, `AgendaTimeGrid`,
// `AgendaMonthGrid`, `AgendaYearGrid`) and writes every word; this file maps minutes to points
// and fingers to events. A drop reports the minute under the block's new top and Rust snaps it;
// the dragged block shows where it will land, snapped to `snap_minutes`, while the finger is down.
// Colours, radii and type are the kit's tokens; the sizes below are the board's
// (`design/mockups/Calendar.dc.html`), named once here.

/// The sizes the Calendar board draws, in points.
enum AgendaGridMetrics {
    /// One hour of the grid: the board's 70.
    static let hourHeight: CGFloat = 70
    /// The hour labels' column, and the all-day label's.
    static let gutter: CGFloat = 44
    /// A block's leading bar.
    static let barWidth: CGFloat = 3
    /// A calendar's dot under a day.
    static let dot: CGFloat = 5
    /// The strip's and a month cell's day circle.
    static let dayCircle: CGFloat = 36
    static let nowDot: CGFloat = 6
    /// Minutes either side of the now line inside which an hour label is not drawn.
    static let nowClash = 16
    /// A task's check circle on a chip or a block.
    static let checkSize: CGFloat = 14
    /// The foot of a movable block that a drag resizes.
    static let handleHeight: CGFloat = 16
    static let minutesPerDay = 1440
    /// How far, and how level, a swipe must be to step.
    static let swipeDistance: CGFloat = 48
    /// Hold on an empty slot before it asks for an event there.
    static let slotHold: TimeInterval = 0.45
    /// Hold on a block before a drag moves it, so a scroll still scrolls.
    static let dragHold: Double = 0.3
    /// A block this tall shows its time, and one this tall its meta line.
    static let timeFrom: CGFloat = 40
    /// A lane this wide (a Day column, a lone event in a Week) has room for the second line.
    static let detailFromWidth: CGFloat = 96
    static let metaFrom: CGFloat = 56
    /// Month rows: the grid style's hold three chips, the list style's a day number and dots.
    static let monthRowGrid: CGFloat = 84
    static let monthRowList: CGFloat = 52
    static let monthChipHeight: CGFloat = 16
    static let yearDay: CGFloat = 16
}

/// The hue key's colour: the party role Rust names for a calendar (`cTeal`, `cSlate`...), the
/// same the rows' dots use; an unknown key is the neutral slate, never clear.
func agendaHue(_ key: String, _ scheme: ColorScheme) -> Color {
    // A calendar the member coloured from the list palette arrives as its token (`listBlue`).
    if key.hasPrefix("list") { return AgendaPalette.token(key) }
    return Theme.color(KitHue.role(key) ?? "cSlate", scheme)
}

/// A hue's pale ground: the icon chip's own strength, light or dark.
private func agendaWash(_ key: String, _ scheme: ColorScheme) -> Color {
    agendaHue(key, scheme).opacity(scheme == .dark ? CentraidGeometry.iconChipTintDark : CentraidGeometry.iconChipTintLight)
}

/// The events the grids send.
private enum AgendaCalendarEvents {
    typealias Event = Centraid_Core_V1_AgendaHomeEvent

    static func dayPicked(_ day: String, _ opens: Centraid_Core_V1_AgendaDestination) -> Event {
        AgendaEvents.make { $0.dayPicked = .with { $0.day = day; $0.destination = opens } }
    }

    static func dayStepped(_ days: Int) -> Event {
        AgendaEvents.make { $0.dayStepped = .with { $0.days = Int32(days) } }
    }

    static func weekPaged(_ weeks: Int) -> Event {
        AgendaEvents.make { $0.weekPaged = .with { $0.weeks = Int32(weeks) } }
    }

    static func periodStepped(_ by: Int) -> Event {
        AgendaEvents.make { $0.periodStepped = .with { $0.by = Int32(by) } }
    }

    static func taskChecked(_ id: String) -> Event {
        AgendaEvents.make { $0.taskChecked = .with { $0.taskID = id } }
    }
}

// MARK: - Swipe

/// A level swipe across a surface: left is the next, right the previous. The drag runs beside
/// the surface's own (a scroll, a tap) and only a long, level one counts.
private struct AgendaSwipe: ViewModifier {
    let previousLabel: String
    let nextLabel: String
    var busy: Bool = false
    let onPrevious: () -> Void
    let onNext: () -> Void

    func body(content: Content) -> some View {
        content
            .simultaneousGesture(
                DragGesture(minimumDistance: AgendaGridMetrics.swipeDistance / 2).onEnded { drag in
                    let across = drag.translation.width
                    let down = drag.translation.height
                    guard !busy, abs(across) > AgendaGridMetrics.swipeDistance, abs(across) > abs(down) * 2 else { return }
                    if across < 0 { onNext() } else { onPrevious() }
                }
            )
            .accessibilityAction(named: previousLabel, onPrevious)
            .accessibilityAction(named: nextLabel, onNext)
    }
}

// MARK: - The view menu

/// The Calendar tab's view menu: the current view's name and a chevron, on glass where the
/// platform has it (the band's ground, solid under Reduce Transparency). A tap lists Rust's views
/// (`calendar_views`); on Month a second group lists the month's styles.
struct AgendaViewMenu: View {
    let views: [Centraid_Core_V1_AgendaCalendarView]
    let label: String
    /// The Month's styles, while the data holds a Month.
    var month: Centraid_Core_V1_AgendaMonthGrid?
    let pick: (Centraid_Core_V1_AgendaDestination) -> Void
    let pickStyle: (Centraid_Core_V1_AgendaMonthStyle) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Menu {
            Picker(label, selection: viewSelection) {
                ForEach(views, id: \.key) { view in
                    Text(view.label)
                        .tag(view.key)
                        .accessibilityIdentifier("agenda-view-\(view.key)")
                }
            }
            .pickerStyle(.inline)
            if let month, !month.styles.isEmpty {
                Picker(month.title, selection: styleSelection(month)) {
                    ForEach(month.styles, id: \.style) { choice in
                        Text(choice.label)
                            .tag(choice.style)
                            .accessibilityIdentifier("agenda-month-style-\(styleKey(choice.style))")
                    }
                }
                .pickerStyle(.inline)
            }
        } label: {
            HStack(spacing: 4) {
                Text(views.first(where: { $0.current })?.label ?? label)
                    .centraidType("smallStrong")
                CentraidIconView(iconKey: "ChevronDown", tint: Theme.color("textSoft", scheme), size: 14)
            }
            .foregroundStyle(Theme.color("text", scheme))
            .padding(.horizontal, 12)
            .frame(minHeight: CentraidGeometry.targetMinCoarse)
            .bandGround(Capsule(), solid: "bg", interactive: true)
        }
        .accessibilityLabel(label)
        .accessibilityIdentifier("agenda-view-menu")
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var viewSelection: Binding<String> {
        Binding(
            get: { views.first(where: { $0.current })?.key ?? "" },
            set: { key in
                if let view = views.first(where: { $0.key == key }) { pick(view.destination) }
            }
        )
    }

    private func styleSelection(_ month: Centraid_Core_V1_AgendaMonthGrid) -> Binding<Centraid_Core_V1_AgendaMonthStyle> {
        Binding(
            get: { month.styles.first(where: { $0.current })?.style ?? month.style },
            set: { style in pickStyle(style) }
        )
    }

    private func styleKey(_ style: Centraid_Core_V1_AgendaMonthStyle) -> String {
        style == .list ? "list" : "grid"
    }
}

// MARK: - The header

/// THE BACK-TO-MONTH CHIP of Day and Week's header (`design/mockups/Calendar.dc.html`): a chevron
/// and the anchor's month, leading in the system bar. A tap sends `MonthChipTapped`; Rust opens
/// the Month. Nothing is drawn until Rust has named the month.
struct AgendaMonthChip: View {
    let header: Centraid_Core_V1_AgendaCalendarHeader
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void

    var body: some View {
        if !header.monthLabel.isEmpty {
            Button {
                send(AgendaEvents.make { $0.monthChip = .init() })
            } label: {
                HStack(spacing: 4) {
                    CentraidIconView(iconKey: header.monthIconKey, tint: Surface.ink, size: 18)
                    Text(header.monthLabel)
                        .centraidType("smallStrong")
                        .foregroundStyle(Surface.ink)
                        .lineLimit(1)
                }
                .fixedSize()
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(header.monthAccessibility)
            .accessibilityIdentifier("agenda-month-chip")
        }
    }
}

/// THE LAYOUT KEY: the glyph in the bar's glass, a tap lists Rust's layouts (Day, Week, then
/// Month, List and Year) and a pick sends `LayoutToggled`, which keeps the day.
struct AgendaLayoutKey: View {
    let header: Centraid_Core_V1_AgendaCalendarHeader
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void

    var body: some View {
        Menu {
            Picker(header.layoutLabel, selection: selection) {
                ForEach(header.layouts, id: \.key) { layout in
                    Text(layout.label)
                        .tag(layout.key)
                        .accessibilityIdentifier("agenda-view-\(layout.key)")
                }
            }
            .pickerStyle(.inline)
        } label: {
            CentraidIconView(iconKey: header.layoutIconKey, tint: Surface.ink, size: 18)
                .frame(minWidth: 30, minHeight: CentraidGeometry.targetMinCoarse)
                .contentShape(Rectangle())
        }
        .accessibilityLabel(header.layoutLabel)
        .accessibilityIdentifier("agenda-layout-key")
    }

    private var selection: Binding<String> {
        Binding(
            get: { header.layouts.first(where: { $0.destination == header.layout })?.key ?? "" },
            set: { key in
                if let layout = header.layouts.first(where: { $0.key == key }) {
                    send(AgendaEvents.make { $0.layoutToggled = .with { $0.layout = layout.destination } })
                }
            }
        )
    }
}

/// DAY'S ALL-DAY LANE, one row under the strip: Rust's label and its chips side by side, the
/// chips scrolling across when they run out of room. Not drawn on a day with none.
private struct AgendaAllDayLane: View {
    let header: Centraid_Core_V1_AgendaCalendarHeader
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if !header.allDay.isEmpty {
            HStack(spacing: 8) {
                Text(header.allDayLabel)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .frame(width: AgendaGridMetrics.gutter, alignment: .leading)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(header.allDay, id: \.key) { chip in
                            AgendaChipView(chip: chip, send: send, open: open)
                                .fixedSize(horizontal: true, vertical: false)
                        }
                    }
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Surface.line).frame(height: CentraidGeometry.hairline)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("agenda-all-day-lane")
        }
    }
}

// MARK: - Today

/// THE FLOATING TODAY KEY, bottom-leading above the band: glass on iOS 26, the card's solid
/// ground before it and under Reduce Transparency. It sends the one `TodayRequested`.
struct AgendaTodayButton: View {
    let label: String
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button {
            send(AgendaEvents.make { $0.today = .init() })
        } label: {
            Text(label)
                .centraidType("smallStrong")
                .foregroundStyle(Theme.color("text", scheme))
                .padding(.horizontal, 16)
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                .bandGround(Capsule(), solid: "bg", interactive: true)
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .padding(.leading, CentraidGeometry.pageMargin)
        .padding(.bottom, 12)
        .accessibilityIdentifier("agenda-today-button")
    }
}

// MARK: - Check circle

/// A task's round box on a chip or a block; a tap sends `TaskChecked`.
private struct AgendaCheckCircle: View {
    let hueKey: String
    let label: String
    let identifier: String
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: action) {
            Circle()
                .strokeBorder(agendaHue(hueKey, scheme), lineWidth: 1.5)
                .frame(width: AgendaGridMetrics.checkSize, height: AgendaGridMetrics.checkSize)
                .padding(10)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .padding(-10)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
}

// MARK: - The week strip

/// THE WEEK STRIP: seven days from the region's first weekday. A tap picks the day, a swipe steps
/// a week (`WeekPaged`).
struct AgendaWeekStripView: View {
    let strip: Centraid_Core_V1_AgendaWeekStrip
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 0) {
            ForEach(strip.days, id: \.day) { day in
                AgendaStripDayView(day: day, send: send)
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin / 2)
        .padding(.bottom, 8)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Surface.line).frame(height: CentraidGeometry.hairline)
        }
        .modifier(
            AgendaSwipe(
                previousLabel: strip.previousLabel,
                nextLabel: strip.nextLabel,
                onPrevious: { send(AgendaCalendarEvents.weekPaged(-1)) },
                onNext: { send(AgendaCalendarEvents.weekPaged(1)) }
            )
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("agenda-week-strip")
    }
}

private struct AgendaStripDayView: View {
    let day: Centraid_Core_V1_AgendaStripDay
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.appAccent) private var accent

    var body: some View {
        Button {
            send(AgendaCalendarEvents.dayPicked(day.day, day.opens))
        } label: {
            VStack(spacing: 0) {
                Text(day.weekdayInitial)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color(day.isWeekend ? "textFaint" : "textSoft", scheme))
                Text(day.dayNumber)
                    .centraidType(day.isSelected || day.isToday ? "smallStrong" : "small")
                    .foregroundStyle(numberInk)
                    .frame(width: AgendaGridMetrics.dayCircle, height: AgendaGridMetrics.dayCircle)
                    .background {
                        if day.isSelected {
                            Circle().fill(accent.fill)
                        }
                    }
                    .padding(.top, 3)
                // THE DOTS' OWN SLOT: the same height and the same distance under the number on
                // every day, so the selected day's filled circle never reaches them.
                HStack(spacing: 3) {
                    ForEach(Array(day.dotHueKeys.prefix(3).enumerated()), id: \.offset) { _, key in
                        Circle()
                            .fill(agendaHue(key, scheme))
                            .frame(width: AgendaGridMetrics.dot, height: AgendaGridMetrics.dot)
                    }
                }
                .frame(height: AgendaGridMetrics.dot)
                .padding(.top, 4)
            }
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(day.accessibilityLabel)
        .accessibilityAddTraits(day.isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("agenda-strip-day-\(day.day)")
    }

    private var numberInk: Color {
        if day.isSelected { return Theme.color("onAccent", scheme) }
        if day.isToday { return accent.text }
        return Theme.color(day.isWeekend ? "textFaint" : "text", scheme)
    }
}

// MARK: - Day and Week

/// DAY AND WEEK: the strip, Day's all-day lane, the Week's all-day columns and the hour grid in
/// a scroll view. A level swipe over the grid steps the day, or pages the week.
struct AgendaTimeGridView: View {
    let home: Centraid_Core_V1_AgendaHomeData
    /// Day's all-day lane lives on the header (Rust took it out of the Day column).
    let header: Centraid_Core_V1_AgendaCalendarHeader
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    /// A block is being dragged: the grid's own swipe stands aside.
    @State private var busy = false
    @Environment(\.colorScheme) private var scheme
    @Environment(\.appAccent) private var accent

    var body: some View {
        let grid = home.timeGrid
        VStack(spacing: 0) {
            if home.hasWeekStrip {
                AgendaWeekStripView(strip: home.weekStrip, send: send)
            }
            AgendaAllDayLane(header: header, send: send, open: open)
            GeometryReader { geo in
                let count = max(grid.days.count, 1)
                let columnWidth = max((geo.size.width - AgendaGridMetrics.gutter) / CGFloat(count), 1)
                VStack(spacing: 0) {
                    header(grid, columnWidth: columnWidth)
                    allDay(grid, columnWidth: columnWidth)
                    hourGrid(grid, width: geo.size.width, columnWidth: columnWidth)
                }
                .frame(width: geo.size.width, height: geo.size.height, alignment: .top)
            }
        }
    }

    /// The Week's column heads ("Wed 4"); on Day the strip has them, so only the day's spoken name.
    private func header(_ grid: Centraid_Core_V1_AgendaTimeGrid, columnWidth: CGFloat) -> some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: AgendaGridMetrics.gutter, height: 0)
            ForEach(grid.days, id: \.day) { day in
                Text(day.heading)
                    .centraidType(day.isToday ? "smallStrong" : "small")
                    .foregroundStyle(day.isToday ? accent.text : Theme.color("textSoft", scheme))
                    .frame(width: columnWidth, alignment: .center)
                    .padding(.vertical, day.heading.isEmpty ? 0 : 6)
                    .accessibilityLabel(day.accessibilityLabel)
            }
        }
    }

    /// THE ALL-DAY ROW: the label in the gutter, a column of chips under each day.
    @ViewBuilder
    private func allDay(_ grid: Centraid_Core_V1_AgendaTimeGrid, columnWidth: CGFloat) -> some View {
        if grid.days.contains(where: { !$0.allDay.isEmpty }) {
            HStack(alignment: .top, spacing: 0) {
                Text(grid.allDayLabel)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .padding(.leading, 4)
                    .frame(width: AgendaGridMetrics.gutter, alignment: .leading)
                ForEach(grid.days, id: \.day) { day in
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(day.allDay, id: \.key) { chip in
                            AgendaChipView(chip: chip, narrow: columnWidth < AgendaGridMetrics.detailFromWidth, send: send, open: open)
                        }
                    }
                    .padding(.horizontal, 2)
                    .frame(width: columnWidth, alignment: .topLeading)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("agenda-grid-allday-\(day.day)")
                }
            }
            .padding(.vertical, 8)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Surface.line).frame(height: CentraidGeometry.hairline)
            }
        }
    }

    private func hourGrid(_ grid: Centraid_Core_V1_AgendaTimeGrid, width: CGFloat, columnWidth: CGFloat) -> some View {
        let perMinute = AgendaGridMetrics.hourHeight / 60
        let total = CGFloat(AgendaGridMetrics.minutesPerDay) * perMinute
        let count = max(grid.days.count, 1)
        let days = grid.days.map(\.day)
        return ScrollViewReader { proxy in
            ScrollView {
                ZStack(alignment: .topLeading) {
                    // THE OPENING SPOT: an unseen 1pt mark where `scroll_to_minute` falls.
                    VStack(spacing: 0) {
                        Color.clear.frame(width: 1, height: CGFloat(grid.scrollToMinute) * perMinute)
                        Color.clear.frame(width: 1, height: 1).id("agenda-grid-open")
                        Spacer(minLength: 0)
                    }
                    .frame(width: 1, height: total, alignment: .top)
                    .allowsHitTesting(false)
                    hourLines(grid, width: width, perMinute: perMinute)
                    // AN EMPTY SLOT'S LONG PRESS: the minute under the finger, which Rust snaps.
                    AgendaSlotPress(holdSeconds: AgendaGridMetrics.slotHold) { point in
                        let index = min(max(Int(point.x / columnWidth), 0), count - 1)
                        let minute = min(max(Int(point.y / perMinute), 0), AgendaGridMetrics.minutesPerDay)
                        guard index < days.count else { return }
                        send(AgendaEvents.make { $0.slotPressed = .with { $0.day = days[index]; $0.minute = Int32(minute) } })
                    }
                    .frame(width: columnWidth * CGFloat(count), height: total)
                    .offset(x: AgendaGridMetrics.gutter)
                    columnRules(count: count, columnWidth: columnWidth, total: total)
                    ForEach(Array(grid.days.enumerated()), id: \.offset) { index, day in
                        ForEach(day.blocks, id: \.key) { block in
                            AgendaBlockView(
                                block: block,
                                dayIndex: index,
                                days: days,
                                columnWidth: columnWidth,
                                snap: Int(grid.snapMinutes),
                                moveLabel: grid.moveLabel,
                                resizeLabel: grid.resizeLabel,
                                busy: $busy,
                                send: send,
                                open: open
                            )
                        }
                    }
                    if grid.hasNow {
                        nowLine(grid.now, days: days, columnWidth: columnWidth, perMinute: perMinute)
                    }
                }
                .frame(width: width, height: total, alignment: .topLeading)
            }
            .accessibilityHint(grid.slotHint)
            .accessibilityIdentifier("agenda-time-grid")
            .modifier(
                AgendaSwipe(
                    previousLabel: home.weekStrip.previousLabel,
                    nextLabel: home.weekStrip.nextLabel,
                    busy: busy,
                    // DAY STEPS A DAY; THE WEEK PAGES ITS WEEK.
                    onPrevious: { send(grid.days.count > 1 ? AgendaCalendarEvents.weekPaged(-1) : AgendaCalendarEvents.dayStepped(-1)) },
                    onNext: { send(grid.days.count > 1 ? AgendaCalendarEvents.weekPaged(1) : AgendaCalendarEvents.dayStepped(1)) }
                )
            )
            // ON THE NEXT TURN: the first pass has laid out no grid yet, and a scroll asked for
            // before the layout lands on the top of the day (the page opened at midnight).
            .task(id: grid.scrollToMinute) {
                // Twice: once as soon as the first pass has landed, once after the content's own
                // size is settled (a scroll asked for earlier is dropped on the floor).
                try? await Task.sleep(nanoseconds: 50_000_000)
                proxy.scrollTo("agenda-grid-open", anchor: .top)
                try? await Task.sleep(nanoseconds: 300_000_000)
                proxy.scrollTo("agenda-grid-open", anchor: .top)
            }
        }
    }

    private func hourLines(_ grid: Centraid_Core_V1_AgendaTimeGrid, width: CGFloat, perMinute: CGFloat) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach(grid.hours, id: \.minute) { mark in
                let y = CGFloat(mark.minute) * perMinute
                // THE NOW PILL HIDES THE HOUR IT SITS ON: two clocks in one gutter read as a smear.
                let clashes = grid.hasNow && abs(Int(grid.now.minute) - Int(mark.minute)) < AgendaGridMetrics.nowClash
                Text(mark.label)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                    .frame(width: AgendaGridMetrics.gutter, alignment: .trailing)
                    .padding(.trailing, 6)
                    .opacity(clashes ? 0 : 1)
                    .offset(y: y - 8)
                Rectangle()
                    .fill(Surface.line)
                    .frame(width: max(width - AgendaGridMetrics.gutter, 0), height: CentraidGeometry.hairline)
                    .offset(x: AgendaGridMetrics.gutter, y: y)
            }
        }
        .allowsHitTesting(false)
    }

    /// Week's hairlines between the days.
    @ViewBuilder
    private func columnRules(count: Int, columnWidth: CGFloat, total: CGFloat) -> some View {
        if count > 1 {
            ZStack(alignment: .topLeading) {
                ForEach(0 ..< count, id: \.self) { index in
                    Rectangle()
                        .fill(Surface.line)
                        .frame(width: CentraidGeometry.hairline, height: total)
                        .offset(x: AgendaGridMetrics.gutter + CGFloat(index) * columnWidth)
                }
            }
            .allowsHitTesting(false)
        }
    }

    /// THE NOW LINE, on its day's column: the accent's rule and dot, and the clock as a filled
    /// pill in the gutter (the hour label it would clash with is not drawn, see `hourLines`).
    private func nowLine(
        _ now: Centraid_Core_V1_AgendaGridNow,
        days: [String],
        columnWidth: CGFloat,
        perMinute: CGFloat
    ) -> some View {
        let index = days.firstIndex(of: now.day) ?? 0
        // ONE CENTRE LINE: the pill, the dot and the rule are centred on a zero-height row, so
        // they share the minute's y whatever the pill's text is tall.
        return ZStack(alignment: .leading) {
            Text(now.label)
                .centraidType("annotLabelOn")
                .foregroundStyle(Color.white)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(accent.fill, in: Capsule())
                .frame(width: AgendaGridMetrics.gutter, alignment: .trailing)
                .padding(.trailing, 2)
            Circle()
                .fill(accent.fill)
                .frame(width: AgendaGridMetrics.nowDot, height: AgendaGridMetrics.nowDot)
                .offset(x: AgendaGridMetrics.gutter + CGFloat(index) * columnWidth - AgendaGridMetrics.nowDot / 2)
            Rectangle()
                .fill(accent.fill)
                .frame(width: max(columnWidth, 0), height: 2)
                .offset(x: AgendaGridMetrics.gutter + CGFloat(index) * columnWidth)
        }
        .frame(height: 0)
        .offset(y: CGFloat(now.minute) * perMinute)
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(now.accessibilityLabel)
        .accessibilityIdentifier("agenda-now-line")
    }
}

/// An all-day chip: a birthday, an all-day event, or a task due that day with no time. A task's
/// round box checks it off; a chip with a route pushes it.
private struct AgendaChipView: View {
    let chip: Centraid_Core_V1_AgendaGridChip
    /// A Week column: less air round the words, so a name keeps more than two letters.
    var narrow = false
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: narrow ? 2 : 4) {
            if chip.isTask {
                AgendaCheckCircle(
                    hueKey: chip.hueKey,
                    label: chip.accessibilityLabel,
                    identifier: "agenda-grid-chip-check-\(chip.taskID)"
                ) { send(AgendaCalendarEvents.taskChecked(chip.taskID)) }
            }
            if chip.hasRoute {
                Button {
                    open(chip.route)
                } label: {
                    title
                }
                .buttonStyle(.plain)
                .accessibilityLabel(chip.accessibilityLabel)
                .accessibilityIdentifier("agenda-grid-chip-\(chip.key)")
            } else {
                title
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(chip.accessibilityLabel)
                    .accessibilityIdentifier("agenda-grid-chip-\(chip.key)")
            }
        }
        .padding(.horizontal, narrow ? 3 : 6)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(agendaWash(chip.hueKey, scheme))
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius("sm", scheme), style: .continuous))
    }

    private var title: some View {
        Text(chip.title)
            .centraidType("annotLabel")
            .foregroundStyle(Theme.color("text", scheme))
            .lineLimit(1)
            .minimumScaleFactor(narrow ? 0.7 : 1)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A TIMED BLOCK, placed by minutes. An event is a pale ground with a 3pt bar; a task is dashed
/// with a check circle. A `movable` block moves on a drag after a short hold and resizes on a drag
/// of its foot; while the finger is down it shows where it will land, snapped to `snap_minutes`.
private struct AgendaBlockView: View {
    let block: Centraid_Core_V1_AgendaGridBlock
    let dayIndex: Int
    let days: [String]
    let columnWidth: CGFloat
    let snap: Int
    let moveLabel: String
    let resizeLabel: String
    @Binding var busy: Bool
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void

    @Environment(\.colorScheme) private var scheme
    @GestureState private var move: CGSize = .zero
    @GestureState private var stretch: CGFloat = 0

    private var perMinute: CGFloat { AgendaGridMetrics.hourHeight / 60 }
    private var start: Int { Int(block.startMinute) }
    private var end: Int { Int(block.endMinute) }
    private var step: Int { max(snap, 1) }

    var body: some View {
        let lanes = CGFloat(max(Int(block.columns), 1))
        let laneWidth = columnWidth / lanes
        let placed = placement(move)
        let newEnd = resizedEnd(stretch)
        let height = max(CGFloat(newEnd - placed.start), 15) * perMinute
        // THE HOUR LABELS' GUTTER comes first: the columns start after it.
        let x = AgendaGridMetrics.gutter + CGFloat(placed.index) * columnWidth + laneWidth * CGFloat(block.column)
        let dragging = move != .zero || stretch != 0
        ZStack(alignment: .bottom) {
            ZStack(alignment: .topLeading) {
                Button {
                    if block.hasRoute { open(block.route) }
                } label: {
                    face(width: laneWidth, height: height)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(block.accessibilityLabel)
                .accessibilityHint(block.movable ? moveLabel : "")
                .accessibilityIdentifier("agenda-grid-block-\(block.key)")
                .simultaneousGesture(moveGesture, including: block.movable ? .all : .none)
                if block.isTask {
                    AgendaCheckCircle(
                        hueKey: block.hueKey,
                        label: block.accessibilityLabel,
                        identifier: "agenda-grid-block-check-\(block.taskID)"
                    ) { send(AgendaCalendarEvents.taskChecked(block.taskID)) }
                    // CENTRED ON THE TITLE'S LINE (the title is centred in the block too).
                    .frame(height: height)
                    .padding(.leading, laneWidth >= AgendaGridMetrics.detailFromWidth ? 6 : 3)
                    .allowsHitTesting(true)
                }
            }
            if block.movable {
                handle
            }
        }
        .frame(width: laneWidth, height: height, alignment: .topLeading)
        .offset(x: x, y: CGFloat(placed.start) * perMinute)
        .zIndex(dragging ? 1 : 0)
    }

    /// The block's face, as the board draws it: the hue's pale ground and 3pt bar; the title, then
    /// one line of time and place. A task is dashed, its circle and title on one line. A narrow lane
    /// (the Week) shows the title alone, truncated, and a short block just its title.
    private func face(width: CGFloat, height: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: Theme.radius("sm", scheme), style: .continuous)
        let hue = agendaHue(block.hueKey, scheme)
        let ink = Theme.color(block.isPast ? "textSoft" : "text", scheme)
        let roomy = width >= AgendaGridMetrics.detailFromWidth
        // A WEEK LANE IS A SLIVER: the title in the small bold face, packed to the edges.
        let titleFace = roomy ? "smallStrong" : "annotLabelOn"
        return VStack(alignment: .leading, spacing: 0) {
            if block.isTask {
                HStack(spacing: 4) {
                    Text(block.title)
                        .centraidType(titleFace)
                        .foregroundStyle(ink)
                        .lineLimit(1)
                    if roomy, !block.detail.isEmpty {
                        Text(block.detail)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .lineLimit(1)
                    }
                }
                .frame(maxHeight: .infinity, alignment: .center)
            } else {
                Text(block.title)
                    .centraidType(titleFace)
                    .foregroundStyle(ink)
                    .lineLimit(1)
                if roomy, height >= AgendaGridMetrics.timeFrom, !block.detail.isEmpty {
                    Text(block.detail)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                        .lineLimit(height >= AgendaGridMetrics.metaFrom ? 2 : 1)
                }
            }
        }
        .padding(.leading, block.isTask ? (roomy ? 28 : 21) : AgendaGridMetrics.barWidth + (roomy ? 6 : 3))
        .padding(.trailing, roomy ? 4 : 1)
        .padding(.top, block.isTask ? 0 : 4)
        .frame(width: width, height: height, alignment: .topLeading)
        .background {
            if block.isTask {
                shape.strokeBorder(hue, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            } else {
                shape.fill(agendaWash(block.hueKey, scheme))
            }
        }
        .overlay(alignment: .leading) {
            if !block.isTask {
                Rectangle().fill(hue).frame(width: AgendaGridMetrics.barWidth)
            }
        }
        .clipShape(shape)
        .contentShape(shape)
    }

    /// THE FOOT'S GRIP: a drag on it moves the end.
    private var handle: some View {
        // NO MARK ON THE BOARD: the foot is a grip by touch and by the accessibility action only.
        Color.clear
            // A FIXED FOOT: `Color.clear` is greedy, and a `minHeight` let it fill the whole block, so the
            // grip swallowed every tap meant for the block (a movable event never opened on a tap).
            .frame(maxWidth: .infinity)
            .frame(height: AgendaGridMetrics.handleHeight)
            .contentShape(Rectangle())
            .gesture(resizeGesture)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(resizeLabel)
            .accessibilityAddTraits(.isButton)
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: send(resized(to: min(end + step, AgendaGridMetrics.minutesPerDay)))
                case .decrement: send(resized(to: max(end - step, start + step)))
                @unknown default: break
                }
            }
            .accessibilityIdentifier("agenda-grid-block-resize-\(block.key)")
    }

    // MARK: Gestures

    private var moveGesture: some Gesture {
        LongPressGesture(minimumDuration: AgendaGridMetrics.dragHold)
            .sequenced(before: DragGesture())
            .updating($move) { value, state, _ in
                if case .second(true, let drag?) = value { state = drag.translation }
            }
            .onChanged { _ in busy = true }
            .onEnded { value in
                if case .second(true, let drag?) = value { drop(drag.translation) }
                release()
            }
    }

    private var resizeGesture: some Gesture {
        LongPressGesture(minimumDuration: AgendaGridMetrics.dragHold / 2)
            .sequenced(before: DragGesture())
            .updating($stretch) { value, state, _ in
                if case .second(true, let drag?) = value { state = drag.translation.height }
            }
            .onChanged { _ in busy = true }
            .onEnded { value in
                if case .second(true, let drag?) = value {
                    let target = resizedEnd(drag.translation.height)
                    if target != end { send(resized(to: target)) }
                }
                release()
            }
    }

    /// Let the grid's swipe see the drag as this block's, then free it.
    private func release() {
        DispatchQueue.main.async { busy = false }
    }

    // MARK: Geometry

    /// Points of drag as minutes, on the snap.
    private func snapped(_ points: CGFloat) -> Int {
        let minutes = Double(points / perMinute)
        return Int((minutes / Double(step)).rounded()) * step
    }

    /// Where a drag of `translation` puts the block: its column and its top minute.
    private func placement(_ translation: CGSize) -> (index: Int, start: Int) {
        guard translation != .zero else { return (dayIndex, start) }
        let length = max(end - start, 15)
        let top = min(max(start + snapped(translation.height), 0), max(AgendaGridMetrics.minutesPerDay - length, 0))
        let across = Int((translation.width / columnWidth).rounded())
        let index = min(max(dayIndex + across, 0), max(days.count - 1, 0))
        return (index, top)
    }

    private func resizedEnd(_ translation: CGFloat) -> Int {
        guard translation != 0 else { return end }
        return min(max(end + snapped(translation), start + step), AgendaGridMetrics.minutesPerDay)
    }

    private func drop(_ translation: CGSize) {
        let target = placement(translation)
        guard target.index < days.count, target.index != dayIndex || target.start != start else { return }
        send(
            AgendaEvents.make {
                $0.eventMoved = .with {
                    $0.instanceKey = block.instanceKey
                    $0.day = days[target.index]
                    $0.minute = Int32(target.start)
                }
            }
        )
    }

    private func resized(to endMinute: Int) -> Centraid_Core_V1_AgendaHomeEvent {
        AgendaEvents.make {
            $0.eventResized = .with {
                $0.instanceKey = block.instanceKey
                $0.endMinute = Int32(endMinute)
            }
        }
    }
}

/// A long press on empty space that says WHERE: SwiftUI's own long press has no location, so the
/// recogniser is UIKit's, on a clear layer UNDER the blocks.
private struct AgendaSlotPress: UIViewRepresentable {
    let holdSeconds: TimeInterval
    let onPress: (CGPoint) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onPress: onPress) }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        view.isAccessibilityElement = false
        let press = UILongPressGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.pressed(_:)))
        press.minimumPressDuration = holdSeconds
        view.addGestureRecognizer(press)
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        context.coordinator.onPress = onPress
    }

    @MainActor
    final class Coordinator: NSObject {
        var onPress: (CGPoint) -> Void

        init(onPress: @escaping (CGPoint) -> Void) { self.onPress = onPress }

        @objc func pressed(_ recognizer: UILongPressGestureRecognizer) {
            guard recognizer.state == .began, let view = recognizer.view else { return }
            onPress(recognizer.location(in: view))
        }
    }
}

// MARK: - Month

/// THE MONTH: weekday initials over whole weeks. The grid style draws up to three chips and the
/// "+2" in each cell; the list style draws dots, and the selected day's rows under the grid in the
/// list's own day section. A tap picks the day; a level swipe steps a month.
struct AgendaMonthView: View {
    let home: Centraid_Core_V1_AgendaHomeData
    let chrome: Centraid_Core_V1_AgendaChrome
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let month = home.month
        let isList = month.style == .list
        let weeks = stride(from: 0, to: month.cells.count, by: 7).map { Array(month.cells[$0 ..< min($0 + 7, month.cells.count)]) }
        ScrollView {
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    ForEach(Array(month.weekdayLabels.enumerated()), id: \.offset) { _, label in
                        Text(label)
                            .centraidType("annotLabel")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .frame(maxWidth: .infinity)
                    }
                }
                .padding(.vertical, 6)
                .accessibilityHidden(true)
                VStack(spacing: 0) {
                    ForEach(Array(weeks.enumerated()), id: \.offset) { _, week in
                        HStack(spacing: 0) {
                            ForEach(week, id: \.day) { cell in
                                AgendaMonthCellView(cell: cell, isList: isList, send: send)
                            }
                        }
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel(month.title)
                .accessibilityIdentifier("agenda-month-grid")
                if isList {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(month.selected, id: \.day) { section in
                            AgendaSectionView(section: section, chrome: chrome, send: send, open: open)
                        }
                        if month.selected.isEmpty {
                            Text(month.selectedEmpty)
                                .centraidType("small")
                                .foregroundStyle(Theme.color("textSoft", scheme))
                                .padding(.horizontal, CentraidGeometry.pageMargin)
                                .padding(.top, 16)
                                .accessibilityIdentifier("agenda-month-selected-empty")
                        }
                    }
                    .padding(.bottom, 16)
                }
            }
        }
        .modifier(
            AgendaSwipe(
                previousLabel: month.previousLabel,
                nextLabel: month.nextLabel,
                onPrevious: { send(AgendaCalendarEvents.periodStepped(-1)) },
                onNext: { send(AgendaCalendarEvents.periodStepped(1)) }
            )
        )
    }
}

private struct AgendaMonthCellView: View {
    let cell: Centraid_Core_V1_AgendaMonthCell
    let isList: Bool
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.appAccent) private var accent

    var body: some View {
        Button {
            send(AgendaCalendarEvents.dayPicked(cell.day, cell.opens))
        } label: {
            VStack(spacing: 2) {
                Text(cell.dayNumber)
                    .centraidType(cell.isToday || cell.isSelected ? "smallStrong" : "small")
                    .foregroundStyle(numberInk)
                    .frame(width: AgendaGridMetrics.dayCircle - 8, height: AgendaGridMetrics.dayCircle - 8)
                    .background {
                        if cell.isToday {
                            Circle().fill(accent.fill)
                        }
                    }
                    .overlay {
                        if cell.isSelected {
                            Circle().strokeBorder(accent.text, lineWidth: 1.5)
                        }
                    }
                if isList {
                    HStack(spacing: 3) {
                        ForEach(Array(cell.dotHueKeys.prefix(3).enumerated()), id: \.offset) { _, key in
                            Circle()
                                .fill(agendaHue(key, scheme))
                                .frame(width: AgendaGridMetrics.dot, height: AgendaGridMetrics.dot)
                        }
                    }
                    .frame(height: AgendaGridMetrics.dot)
                } else {
                    VStack(spacing: 2) {
                        ForEach(Array(cell.chips.prefix(3).enumerated()), id: \.offset) { _, chip in
                            Text(chip.title)
                                .centraidType("annotLabel")
                                .foregroundStyle(Theme.color(cell.inMonth ? "text" : "textFaint", scheme))
                                .lineLimit(1)
                                .padding(.horizontal, 3)
                                .frame(maxWidth: .infinity, minHeight: AgendaGridMetrics.monthChipHeight, alignment: .leading)
                                .background {
                                    let shape = RoundedRectangle(cornerRadius: Theme.radius("sm", scheme), style: .continuous)
                                    if chip.isTask {
                                        shape.strokeBorder(agendaHue(chip.hueKey, scheme), style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                                    } else {
                                        shape.fill(agendaWash(chip.hueKey, scheme))
                                    }
                                }
                        }
                        if !cell.moreLabel.isEmpty {
                            Text(cell.moreLabel)
                                .centraidType("annotLabel")
                                .foregroundStyle(Theme.color("textSoft", scheme))
                        }
                    }
                    .padding(.horizontal, 2)
                }
                Spacer(minLength: 0)
            }
            .frame(
                maxWidth: .infinity,
                minHeight: isList ? AgendaGridMetrics.monthRowList : AgendaGridMetrics.monthRowGrid,
                alignment: .top
            )
            .padding(.top, 4)
            .overlay(alignment: .top) {
                Rectangle().fill(Surface.line).frame(height: CentraidGeometry.hairline)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(cell.accessibilityLabel)
        .accessibilityAddTraits(cell.isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("agenda-month-cell-\(cell.day)")
    }

    /// A day of another month is the quiet role; today is white on its circle.
    private var numberInk: Color {
        if cell.isToday { return Theme.color("onAccent", scheme) }
        return Theme.color(cell.inMonth ? "text" : "textFaint", scheme)
    }
}

// MARK: - Year

/// THE YEAR: twelve small months. A month's tap picks its first day and opens the Month; a level
/// swipe steps a year.
struct AgendaYearView: View {
    let year: Centraid_Core_V1_AgendaYearGrid
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let columns = Array(
            repeating: GridItem(.flexible(), spacing: 12, alignment: .top),
            count: typeSize.isAccessibilitySize ? 2 : 3
        )
        ScrollView {
            LazyVGrid(columns: columns, spacing: 16) {
                ForEach(year.months, id: \.month) { month in
                    AgendaYearMonthView(month: month, send: send)
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(year.title)
            .accessibilityIdentifier("agenda-year-grid")
        }
        .modifier(
            AgendaSwipe(
                previousLabel: year.previousLabel,
                nextLabel: year.nextLabel,
                onPrevious: { send(AgendaCalendarEvents.periodStepped(-1)) },
                onNext: { send(AgendaCalendarEvents.periodStepped(1)) }
            )
        )
    }
}

private struct AgendaYearMonthView: View {
    let month: Centraid_Core_V1_AgendaYearMonth
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.appAccent) private var accent

    var body: some View {
        let weeks = stride(from: 0, to: month.days.count, by: 7).map { Array(month.days[$0 ..< min($0 + 7, month.days.count)]) }
        Button {
            send(AgendaCalendarEvents.dayPicked(month.firstDay, .month))
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(month.label)
                    .centraidType("smallStrong")
                    .foregroundStyle(month.isCurrent ? accent.text : Theme.color("text", scheme))
                ForEach(Array(weeks.enumerated()), id: \.offset) { _, week in
                    HStack(spacing: 0) {
                        ForEach(Array(week.enumerated()), id: \.offset) { _, day in
                            Text(day.dayNumber)
                                .centraidType("annotLabel")
                                // ONE LINE: a two-digit day in a seventh of a third of the screen wrapped
                                // ("3" over "0") and pushed the week out of its columns.
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                                .foregroundStyle(day.isToday ? Theme.color("onAccent", scheme) : Theme.color("textSoft", scheme))
                                .frame(maxWidth: .infinity, minHeight: AgendaGridMetrics.yearDay)
                                .background {
                                    if day.isToday, !day.dayNumber.isEmpty {
                                        Circle().fill(accent.fill)
                                    }
                                }
                                .accessibilityHidden(true)
                                .accessibilityIdentifier("agenda-year-day-\(day.day)")
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(month.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("agenda-year-month-\(month.month)")
    }
}
