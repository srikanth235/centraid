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
    /// A task's check circle on a chip or a block.
    static let checkSize: CGFloat = 14
    /// The foot of a movable block that a drag resizes.
    static let handleHeight: CGFloat = 16
    static let handleWidth: CGFloat = 24
    static let handleThickness: CGFloat = 3
    static let minutesPerDay = 1440
    /// How far, and how level, a swipe must be to step.
    static let swipeDistance: CGFloat = 48
    /// Hold on an empty slot before it asks for an event there.
    static let slotHold: TimeInterval = 0.45
    /// Hold on a block before a drag moves it, so a scroll still scrolls.
    static let dragHold: Double = 0.3
    /// A block this tall shows its time, and one this tall its meta line.
    static let timeFrom: CGFloat = 40
    static let metaFrom: CGFloat = 56
    /// Month rows: the grid style's hold three chips, the list style's a day number and dots.
    static let monthRowGrid: CGFloat = 84
    static let monthRowList: CGFloat = 52
    static let monthChipHeight: CGFloat = 16
    static let yearDay: CGFloat = 16
}

/// The hue key's colour: the list palette Rust names (`blue`, `raspberry`...).
private func agendaHue(_ key: String, _ scheme: ColorScheme) -> Color {
    AgendaPalette.list(key) ?? Theme.color("textFaint", scheme)
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
/// a week (`step_days`).
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
                onPrevious: { send(AgendaCalendarEvents.dayStepped(-Int(strip.stepDays))) },
                onNext: { send(AgendaCalendarEvents.dayStepped(Int(strip.stepDays))) }
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
            VStack(spacing: 3) {
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
                HStack(spacing: 3) {
                    ForEach(Array(day.dotHueKeys.prefix(3).enumerated()), id: \.offset) { _, key in
                        Circle()
                            .fill(agendaHue(key, scheme))
                            .frame(width: AgendaGridMetrics.dot, height: AgendaGridMetrics.dot)
                    }
                }
                .frame(height: AgendaGridMetrics.dot)
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

/// DAY AND WEEK: the strip (Day only, when Rust sends it), the all-day row, and the hour grid in
/// a scroll view. A level swipe over the grid steps the day.
struct AgendaTimeGridView: View {
    let home: Centraid_Core_V1_AgendaHomeData
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
                    .frame(width: AgendaGridMetrics.gutter, alignment: .leading)
                    .padding(.leading, 4)
                ForEach(grid.days, id: \.day) { day in
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(day.allDay, id: \.key) { chip in
                            AgendaChipView(chip: chip, send: send, open: open)
                        }
                    }
                    .frame(width: columnWidth, alignment: .topLeading)
                    .padding(.horizontal, 2)
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
                    Color.clear
                        .frame(width: 1, height: 1)
                        .id("agenda-grid-open")
                        .padding(.top, CGFloat(grid.scrollToMinute) * perMinute)
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
                    onPrevious: { send(AgendaCalendarEvents.dayStepped(-1)) },
                    onNext: { send(AgendaCalendarEvents.dayStepped(1)) }
                )
            )
            .onAppear { proxy.scrollTo("agenda-grid-open", anchor: .top) }
            .onChange(of: grid.scrollToMinute) { _, _ in proxy.scrollTo("agenda-grid-open", anchor: .top) }
        }
    }

    private func hourLines(_ grid: Centraid_Core_V1_AgendaTimeGrid, width: CGFloat, perMinute: CGFloat) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach(grid.hours, id: \.minute) { mark in
                let y = CGFloat(mark.minute) * perMinute
                Text(mark.label)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                    .frame(width: AgendaGridMetrics.gutter, alignment: .trailing)
                    .padding(.trailing, 6)
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

    /// THE NOW LINE, on its day's column: the clock in the gutter, a dot and a rule.
    private func nowLine(
        _ now: Centraid_Core_V1_AgendaGridNow,
        days: [String],
        columnWidth: CGFloat,
        perMinute: CGFloat
    ) -> some View {
        let index = days.firstIndex(of: now.day) ?? 0
        return ZStack(alignment: .topLeading) {
            Text(now.label)
                .centraidType("annotLabelOn")
                .foregroundStyle(Theme.color("net", scheme))
                .frame(width: AgendaGridMetrics.gutter, alignment: .trailing)
                .padding(.trailing, 6)
                .offset(y: -8)
            Circle()
                .fill(Theme.color("net", scheme))
                .frame(width: AgendaGridMetrics.nowDot, height: AgendaGridMetrics.nowDot)
                .offset(x: AgendaGridMetrics.gutter + CGFloat(index) * columnWidth - AgendaGridMetrics.nowDot / 2, y: -AgendaGridMetrics.nowDot / 2)
            Rectangle()
                .fill(Theme.color("net", scheme))
                .frame(width: columnWidth, height: CentraidGeometry.hairline)
                .offset(x: AgendaGridMetrics.gutter + CGFloat(index) * columnWidth)
        }
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
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 4) {
            if chip.isTask {
                AgendaCheckCircle(
                    hueKey: chip.hueKey,
                    label: chip.accessibilityLabel,
                    identifier: "agenda-grid-chip-check-\(chip.taskId)"
                ) { send(AgendaCalendarEvents.taskChecked(chip.taskId)) }
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
        .padding(.horizontal, 6)
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
        let x = CGFloat(placed.index) * columnWidth + laneWidth * CGFloat(block.column)
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
                        identifier: "agenda-grid-block-check-\(block.taskId)"
                    ) { send(AgendaCalendarEvents.taskChecked(block.taskId)) }
                    .padding(.leading, 6)
                    .padding(.top, 4)
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

    /// The block's face: the ground, its bar or dashes, and its words.
    private func face(width: CGFloat, height: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: Theme.radius("sm", scheme), style: .continuous)
        let hue = agendaHue(block.hueKey, scheme)
        let ink = Theme.color(block.isPast ? "textSoft" : "text", scheme)
        return VStack(alignment: .leading, spacing: 0) {
            Text(block.title)
                .centraidType("smallStrong")
                .foregroundStyle(ink)
                .lineLimit(1)
            if height >= AgendaGridMetrics.timeFrom {
                Text(block.timeLabel)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .lineLimit(1)
            }
            if height >= AgendaGridMetrics.metaFrom, !block.meta.isEmpty {
                Text(block.meta)
                    .centraidType("annotLabel")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .lineLimit(1)
            }
        }
        .padding(.leading, block.isTask ? 28 : AgendaGridMetrics.barWidth + 5)
        .padding(.trailing, 4)
        .padding(.top, 2)
        .frame(width: width, height: height, alignment: .topLeading)
        .background {
            if block.isTask {
                shape.strokeBorder(hue, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
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
        Capsule()
            .fill(agendaHue(block.hueKey, scheme))
            .frame(width: AgendaGridMetrics.handleWidth, height: AgendaGridMetrics.handleThickness)
            .frame(maxWidth: .infinity, minHeight: AgendaGridMetrics.handleHeight)
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
