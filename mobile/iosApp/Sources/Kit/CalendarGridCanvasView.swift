import SwiftUI

struct CalendarTimedPlacement: Equatable, Sendable, Identifiable {
    let id: String
    let item: Centraid_Core_V1_RoomCalendarItem
    let startMinute: UInt32
    let endMinute: UInt32
    let lane: Int
    let laneCount: Int
}

struct CalendarDayLayout: Sendable, Identifiable {
    let id: String
    let day: Centraid_Core_V1_RoomCalendarDay
    let overdueItems: [Centraid_Core_V1_RoomCalendarItem]
    let allDayItems: [Centraid_Core_V1_RoomCalendarItem]
    let timedPlacements: [CalendarTimedPlacement]
}

struct CalendarMonthGroup: Sendable, Identifiable {
    let id: String
    let monthKey: String
    let days: [Centraid_Core_V1_RoomCalendarDay]
}

enum CalendarGridMath {
    static let hourHeight: CGFloat = 60
    static let totalGridHeight: CGFloat = hourHeight * 24
    static let hourGutterWidth: CGFloat = 46

    static let hourLabels: [String] = (0..<24).map { hour in
        hour < 10 ? "0\(hour):00" : "\(hour):00"
    }

    static func snapMinute(_ rawMinute: CGFloat, step: UInt32 = 15) -> UInt32 {
        let clamped = min(max(rawMinute, 0), 1439)
        let s = max(step, 1)
        let snapped = UInt32((clamped / CGFloat(s)).rounded()) * s
        return min(snapped, 1440 - s)
    }

    static func minuteOffset(_ minute: UInt32) -> CGFloat {
        CGFloat(min(minute, 1440)) * (hourHeight / 60)
    }

    static func assignLanes(_ items: [Centraid_Core_V1_RoomCalendarItem]) -> [CalendarTimedPlacement] {
        let timed = items.filter { !$0.allDay }.sorted { lhs, rhs in
            if lhs.startMinute != rhs.startMinute { return lhs.startMinute < rhs.startMinute }
            if lhs.endMinute != rhs.endMinute { return lhs.endMinute < rhs.endMinute }
            return lhs.selectorID < rhs.selectorID
        }
        guard !timed.isEmpty else { return [] }

        struct Entry {
            let item: Centraid_Core_V1_RoomCalendarItem
            let start: UInt32
            let end: UInt32
            let lane: Int
            let index: Int
        }

        var result: [CalendarTimedPlacement] = []
        var cluster: [Entry] = []
        var clusterEnd: UInt32 = 0
        var laneEnds: [UInt32] = []

        func flushCluster() {
            guard !cluster.isEmpty else { return }
            let count = max(laneEnds.count, 1)
            for entry in cluster {
                let id = entry.item.selectorID.isEmpty ? "item-\(entry.index)" : entry.item.selectorID
                result.append(
                    CalendarTimedPlacement(
                        id: id,
                        item: entry.item,
                        startMinute: entry.start,
                        endMinute: entry.end,
                        lane: entry.lane,
                        laneCount: count
                    )
                )
            }
            cluster.removeAll(keepingCapacity: true)
            laneEnds.removeAll(keepingCapacity: true)
            clusterEnd = 0
        }

        for (index, item) in timed.enumerated() {
            let start = min(item.startMinute, 1439)
            let rawEnd = min(item.endMinute, 1440)
            let end = max(rawEnd, min(start + 15, 1440))

            if !cluster.isEmpty && start >= clusterEnd {
                flushCluster()
            }

            var assignedLane: Int?
            for (laneIndex, laneEnd) in laneEnds.enumerated() {
                if laneEnd <= start {
                    assignedLane = laneIndex
                    laneEnds[laneIndex] = end
                    break
                }
            }
            let lane: Int
            if let existing = assignedLane {
                lane = existing
            } else {
                lane = laneEnds.count
                laneEnds.append(end)
            }
            clusterEnd = max(clusterEnd, end)
            cluster.append(Entry(item: item, start: start, end: end, lane: lane, index: index))
        }
        flushCluster()
        return result
    }

    static func buildDayLayouts(from days: [Centraid_Core_V1_RoomCalendarDay]) -> [CalendarDayLayout] {
        days.enumerated().map { idx, day in
            let overdue = day.today ? day.items.filter { $0.overdue && !$0.done } : []
            let nonOverdue = day.today ? day.items.filter { !($0.overdue && !$0.done) } : day.items
            let allDay = nonOverdue.filter(\.allDay)
            let timed = assignLanes(nonOverdue)
            return CalendarDayLayout(
                id: day.day.isEmpty ? "day-\(idx)" : day.day,
                day: day,
                overdueItems: overdue,
                allDayItems: allDay,
                timedPlacements: timed
            )
        }
    }

    static func groupDaysByMonth(_ days: [Centraid_Core_V1_RoomCalendarDay]) -> [CalendarMonthGroup] {
        var order: [String] = []
        var grouped: [String: [Centraid_Core_V1_RoomCalendarDay]] = [:]
        for day in days {
            let key = day.day.count >= 7 ? String(day.day.prefix(7)) : day.day
            if grouped[key] == nil {
                order.append(key)
                grouped[key] = []
            }
            grouped[key]?.append(day)
        }
        return order.map { key in
            CalendarMonthGroup(id: key, monthKey: key, days: grouped[key] ?? [])
        }
    }
}

struct CalendarGridCanvasView: View {
    let grid: Centraid_Core_V1_RoomCalendarGrid
    let onTap: (String) -> Void
    let onCanvas: (Centraid_Core_V1_RoomCanvasEvent) -> Void

    private let dayLayouts: [CalendarDayLayout]
    private let monthGroups: [CalendarMonthGroup]
    private let focusedDayLayout: CalendarDayLayout?

    @Environment(\.colorScheme) private var scheme
    @Environment(\.appAccent) private var accent
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(
        grid: Centraid_Core_V1_RoomCalendarGrid,
        onTap: @escaping (String) -> Void,
        onCanvas: @escaping (Centraid_Core_V1_RoomCanvasEvent) -> Void
    ) {
        self.grid = grid
        self.onTap = onTap
        self.onCanvas = onCanvas
        let layouts = CalendarGridMath.buildDayLayouts(from: grid.days)
        self.dayLayouts = layouts
        self.monthGroups = grid.view == .year ? CalendarGridMath.groupDaysByMonth(grid.days) : []
        self.focusedDayLayout = layouts.first(where: { $0.day.selected })
            ?? layouts.first(where: { $0.day.today })
            ?? layouts.first
    }

    private var canvasSelectorID: String {
        grid.createSelectorID.isEmpty ? "calendar-grid" : grid.createSelectorID
    }

    var body: some View {
        VStack(spacing: 0) {
            if hasNavigationControls {
                navigationStrip
            }
            switch grid.view {
            case .day:
                dayView
            case .week:
                weekView
            case .month:
                monthView
            case .list:
                listView
            case .year:
                yearView
            case .unspecified, .UNRECOGNIZED:
                monthView
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .modifier(OptionalIdentifier(identifier: grid.createSelectorID))
    }

    private var hasNavigationControls: Bool {
        !grid.prevSelectorID.isEmpty || !grid.nextSelectorID.isEmpty || !grid.todaySelectorID.isEmpty
    }

    private var navigationStrip: some View {
        HStack(spacing: 12) {
            if !grid.todaySelectorID.isEmpty {
                KitOutlineButton(label: "Today") {
                    onTap(grid.todaySelectorID)
                }
                .accessibilityIdentifier(grid.todaySelectorID)
            }
            Spacer(minLength: 0)
            if !grid.prevSelectorID.isEmpty || !grid.nextSelectorID.isEmpty {
                KitStepper(
                    previousLabel: "Previous",
                    nextLabel: "Next",
                    canPrevious: !grid.prevSelectorID.isEmpty,
                    canNext: !grid.nextSelectorID.isEmpty,
                    previousIdentifier: grid.prevSelectorID,
                    nextIdentifier: grid.nextSelectorID,
                    onPrevious: { onTap(grid.prevSelectorID) },
                    onNext: { onTap(grid.nextSelectorID) }
                )
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 6)
    }

    // MARK: - Day view

    private var dayView: some View {
        Group {
            if let dayLayout = focusedDayLayout {
                VStack(spacing: 0) {
                    if !dayLayout.overdueItems.isEmpty {
                        overdueStrip(items: dayLayout.overdueItems)
                    }
                    if !dayLayout.allDayItems.isEmpty {
                        allDayStrip(day: dayLayout.day.day, items: dayLayout.allDayItems)
                    }
                    ScrollView {
                        HStack(alignment: .top, spacing: 0) {
                            hourGutter
                            dayTimeColumn(dayLayout: dayLayout, compact: false)
                        }
                        .padding(.bottom, 24)
                    }
                }
            } else {
                Spacer(minLength: 0)
            }
        }
    }

    private func overdueStrip(items: [Centraid_Core_V1_RoomCalendarItem]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                calendarItemRow(item: item)
            }
        }
        .padding(.vertical, 6)
        .background(StateColor.red.tint.opacity(0.45))
        .overlay(alignment: .bottom) { KitHairline() }
    }

    private func allDayStrip(day: String, items: [Centraid_Core_V1_RoomCalendarItem]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    allDayChip(item: item)
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 6)
        }
        .contentShape(Rectangle())
        .onLongPressGesture(minimumDuration: 0.45) {
            emitCreate(day: day, minute: 0, allDay: true)
        }
        .overlay(alignment: .bottom) { KitHairline() }
    }

    private func allDayChip(item: Centraid_Core_V1_RoomCalendarItem) -> some View {
        let color = CanvasHue.color(for: item.hueKey, scheme: scheme, accent: accent)
        return Button { onTap(item.selectorID) } label: {
            HStack(spacing: 5) {
                itemLeadingMark(item: item, color: color, size: 14)
                Text(item.title)
                    .kitType(.meta)
                    .fontWeight(.semibold)
                    .strikethrough(item.done)
                    .foregroundStyle(item.done ? Surface.meta : Surface.ink)
                    .lineLimit(1)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(color.opacity(0.14), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(
                        item.needsReply ? StateColor.amber.text : Color.clear,
                        style: StrokeStyle(lineWidth: 1, dash: [3, 2])
                    )
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(item.a11yLabel.isEmpty ? item.title : item.a11yLabel)
        .accessibilityIdentifier(item.selectorID)
    }

    // MARK: - Week view

    private var weekView: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                Color.clear
                    .frame(width: CalendarGridMath.hourGutterWidth, height: 1)
                ForEach(dayLayouts) { dayLayout in
                    Button { emitPickDay(dayLayout.day.day) } label: {
                        VStack(spacing: 4) {
                            Text(dayLayout.day.label)
                                .kitType(.meta)
                                .kitHeld()
                                .fontWeight(dayLayout.day.today || dayLayout.day.selected ? .semibold : .regular)
                                .foregroundStyle(
                                    dayLayout.day.today
                                        ? Color.white
                                        : (dayLayout.day.inScope ? Surface.ink : Surface.meta)
                                )
                                .frame(minWidth: 28, minHeight: 28)
                                .background {
                                    if dayLayout.day.today {
                                        Circle().fill(accent.fill)
                                    } else if dayLayout.day.selected {
                                        Circle().fill(Surface.fill)
                                    }
                                }
                        }
                        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(dayLayout.day.selected ? .isSelected : [])
                }
            }
            .overlay(alignment: .bottom) { KitHairline() }

            if dayLayouts.contains(where: { !$0.allDayItems.isEmpty }) {
                HStack(alignment: .top, spacing: 0) {
                    Color.clear
                        .frame(width: CalendarGridMath.hourGutterWidth, height: 1)
                    ForEach(dayLayouts) { dayLayout in
                        VStack(spacing: 3) {
                            ForEach(Array(dayLayout.allDayItems.prefix(2).enumerated()), id: \.offset) { _, item in
                                compactEventPill(item: item)
                            }
                            if dayLayout.allDayItems.count > 2 {
                                Text("+\(dayLayout.allDayItems.count - 2)")
                                    .kitType(.badge)
                                    .kitHeld()
                                    .foregroundStyle(Surface.meta)
                            }
                        }
                        .padding(.horizontal, 2)
                        .padding(.vertical, 4)
                        .frame(maxWidth: .infinity, alignment: .top)
                        .contentShape(Rectangle())
                        .onLongPressGesture(minimumDuration: 0.45) {
                            emitCreate(day: dayLayout.day.day, minute: 0, allDay: true)
                        }
                    }
                }
                .overlay(alignment: .bottom) { KitHairline() }
            }

            ScrollView {
                HStack(alignment: .top, spacing: 0) {
                    hourGutter
                    ForEach(dayLayouts) { dayLayout in
                        dayTimeColumn(dayLayout: dayLayout, compact: true)
                            .overlay(alignment: .leading) {
                                Rectangle()
                                    .fill(Surface.line)
                                    .frame(width: CentraidGeometry.hairline)
                            }
                    }
                }
                .padding(.bottom, 24)
            }
        }
    }

    private var hourGutter: some View {
        VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { hour in
                Text(CalendarGridMath.hourLabels[hour])
                    .kitType(.badge)
                    .monospacedDigit()
                    .kitHeld()
                    .foregroundStyle(Surface.meta)
                    .frame(width: CalendarGridMath.hourGutterWidth - 6, height: CalendarGridMath.hourHeight, alignment: .topTrailing)
                    .padding(.trailing, 6)
            }
        }
        .frame(width: CalendarGridMath.hourGutterWidth)
        .accessibilityHidden(true)
    }

    private func dayTimeColumn(dayLayout: CalendarDayLayout, compact: Bool) -> some View {
        GeometryReader { proxy in
            let colWidth = max(proxy.size.width, 1)
            ZStack(alignment: .topLeading) {
                VStack(spacing: 0) {
                    ForEach(0..<24, id: \.self) { hour in
                        Rectangle()
                            .fill(Color.clear)
                            .frame(height: CalendarGridMath.hourHeight)
                            .overlay(alignment: .top) {
                                Rectangle()
                                    .fill(Surface.line)
                                    .frame(height: CentraidGeometry.hairline)
                            }
                            .contentShape(Rectangle())
                            .onLongPressGesture(minimumDuration: 0.45) {
                                emitCreate(day: dayLayout.day.day, minute: UInt32(hour * 60), allDay: false)
                            }
                    }
                }

                ForEach(dayLayout.timedPlacements) { placement in
                    let laneWidth = colWidth / CGFloat(max(placement.laneCount, 1))
                    let top = CalendarGridMath.minuteOffset(placement.startMinute)
                    let bottom = CalendarGridMath.minuteOffset(placement.endMinute)
                    let blockHeight = max(bottom - top, 24)

                    timedItemBlock(item: placement.item, compact: compact)
                        .frame(width: max(laneWidth - 4, 8), height: blockHeight)
                        .offset(x: CGFloat(placement.lane) * laneWidth + 2, y: top)
                }

                if dayLayout.day.today, grid.nowMinute < 1440 {
                    let nowY = CalendarGridMath.minuteOffset(grid.nowMinute)
                    HStack(spacing: 0) {
                        Circle()
                            .fill(accent.fill)
                            .frame(width: 7, height: 7)
                        Rectangle()
                            .fill(accent.fill)
                            .frame(height: 1.5)
                    }
                    .offset(x: -3.5, y: nowY - 3.5)
                    .accessibilityHidden(true)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: CalendarGridMath.totalGridHeight)
    }

    private func timedItemBlock(item: Centraid_Core_V1_RoomCalendarItem, compact: Bool) -> some View {
        let color = CanvasHue.color(for: item.hueKey, scheme: scheme, accent: accent)
        let borderColor = item.overdue
            ? StateColor.red.text
            : (item.needsReply ? StateColor.amber.text : color)

        return Button { onTap(item.selectorID) } label: {
            HStack(alignment: .top, spacing: 4) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(borderColor)
                    .frame(width: 3)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        if item.kind != .event {
                            itemLeadingMark(item: item, color: color, size: 12)
                        }
                        Text(item.title)
                            .kitType(compact ? .badge : .meta)
                            .kitHeld()
                            .fontWeight(.semibold)
                            .strikethrough(item.done)
                            .foregroundStyle(item.done ? Surface.meta : Surface.ink)
                            .lineLimit(compact ? 2 : 3)
                    }
                    if !compact && !item.timeLabel.isEmpty {
                        Text(item.timeLabel)
                            .kitType(.badge)
                            .kitHeld()
                            .foregroundStyle(Surface.meta)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 3)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(color.opacity(item.done ? 0.06 : 0.14), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(
                        item.needsReply ? StateColor.amber.text : Color.clear,
                        style: StrokeStyle(lineWidth: 1, dash: [3, 2])
                    )
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(item.a11yLabel.isEmpty ? item.title : item.a11yLabel)
        .accessibilityIdentifier(item.selectorID)
    }

    // MARK: - Month view

    private var monthView: some View {
        let columns = Array(repeating: GridItem(.flexible(), spacing: 0), count: 7)
        return ScrollView {
            VStack(spacing: 0) {
                LazyVGrid(columns: columns, spacing: 0) {
                    ForEach(dayLayouts) { dayLayout in
                        monthCell(dayLayout: dayLayout)
                    }
                }
                .padding(.horizontal, 12)

                if let selected = focusedDayLayout, !selected.day.items.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(selected.day.label)
                            .kitType(.group)
                            .foregroundStyle(Surface.meta)
                            .padding(.horizontal, CentraidGeometry.pageMargin)
                            .padding(.top, 14)
                            .padding(.bottom, 6)
                        ForEach(Array(selected.day.items.enumerated()), id: \.offset) { _, item in
                            calendarItemRow(item: item)
                        }
                    }
                    .readableColumn()
                }
            }
            .padding(.bottom, 24)
        }
    }

    private func monthCell(dayLayout: CalendarDayLayout) -> some View {
        let day = dayLayout.day
        return VStack(spacing: 4) {
            Text(day.label)
                .kitType(.row)
                .kitHeld()
                .fontWeight(day.today || day.selected ? .semibold : .regular)
                .foregroundStyle(
                    day.today
                        ? Color.white
                        : (day.inScope ? Surface.ink : Surface.meta)
                )
                .frame(width: 34, height: 34)
                .background {
                    if day.today {
                        Circle().fill(accent.fill)
                    } else if day.selected {
                        Circle().fill(Surface.fill)
                    }
                }

            VStack(spacing: 2) {
                ForEach(Array(day.items.prefix(2).enumerated()), id: \.offset) { _, item in
                    compactEventPill(item: item)
                }
                if day.moreCount > 0 {
                    Text("+\(day.moreCount)")
                        .kitType(.badge)
                        .kitHeld()
                        .foregroundStyle(Surface.meta)
                }
            }
            .padding(.horizontal, 2)
            Spacer(minLength: 0)
        }
        .padding(.top, 6)
        .frame(maxWidth: .infinity, minHeight: 70, alignment: .top)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(Surface.line)
                .frame(height: CentraidGeometry.hairline)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            emitPickDay(day.day)
        }
        .onLongPressGesture(minimumDuration: 0.45) {
            emitCreate(day: day.day, minute: 0, allDay: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(day.selected ? [.isButton, .isSelected] : .isButton)
    }

    private func compactEventPill(item: Centraid_Core_V1_RoomCalendarItem) -> some View {
        let color = CanvasHue.color(for: item.hueKey, scheme: scheme, accent: accent)
        return Text(item.title)
            .kitType(.badge)
            .kitHeld()
            .strikethrough(item.done)
            .foregroundStyle(item.done ? Surface.meta : Surface.ink)
            .lineLimit(1)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(color.opacity(item.done ? 0.08 : 0.18), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
    }

    // MARK: - List view

    private var listView: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(dayLayouts) { dayLayout in
                    if !dayLayout.day.items.isEmpty {
                        Button { emitPickDay(dayLayout.day.day) } label: {
                            HStack(spacing: 6) {
                                Text(dayLayout.day.label)
                                    .kitType(.group)
                                    .foregroundStyle(dayLayout.day.today ? accent.text : Surface.meta)
                                    .accessibilityAddTraits(.isHeader)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, CentraidGeometry.pageMargin)
                            .padding(.top, 14)
                            .padding(.bottom, 6)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)

                        ForEach(Array(dayLayout.day.items.enumerated()), id: \.offset) { _, item in
                            calendarItemRow(item: item)
                        }
                    }
                }
            }
            .readableColumn()
            .padding(.bottom, 24)
        }
    }

    private func calendarItemRow(item: Centraid_Core_V1_RoomCalendarItem) -> some View {
        let color = CanvasHue.color(for: item.hueKey, scheme: scheme, accent: accent)
        return Button { onTap(item.selectorID) } label: {
            HStack(spacing: 12) {
                itemLeadingMark(item: item, color: color, size: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .kitType(.row)
                        .strikethrough(item.done)
                        .foregroundStyle(item.done ? Surface.meta : Surface.ink)
                        .kitLineLimit(2, wide: 6)
                    if !item.timeLabel.isEmpty {
                        Text(item.timeLabel)
                            .kitType(.meta)
                            .foregroundStyle(item.overdue ? StateColor.red.text : Surface.meta)
                            .kitLineLimit(1, wide: 3)
                    }
                }
                Spacer(minLength: 8)
                if item.needsReply {
                    Circle()
                        .fill(StateColor.amber.fill)
                        .frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(Surface.line)
                    .frame(height: CentraidGeometry.hairline)
                    .padding(.leading, CentraidGeometry.pageMargin)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(item.a11yLabel.isEmpty ? item.title : item.a11yLabel)
        .accessibilityIdentifier(item.selectorID)
    }

    @ViewBuilder
    private func itemLeadingMark(item: Centraid_Core_V1_RoomCalendarItem, color: Color, size: CGFloat) -> some View {
        switch item.kind {
        case .task:
            ZStack {
                if item.done {
                    Circle().fill(color)
                    CentraidIconView(iconKey: "Check", tint: .white, size: size * 0.65)
                } else {
                    Circle()
                        .strokeBorder(item.overdue ? StateColor.red.text : color, lineWidth: 1.6)
                }
            }
            .frame(width: size, height: size)
        case .personDate:
            CentraidIconView(iconKey: "Gift", tint: color, size: size)
        case .event, .unspecified, .UNRECOGNIZED:
            RoundedRectangle(cornerRadius: 2)
                .fill(color)
                .frame(width: 3, height: size)
        }
    }

    // MARK: - Year view

    private var yearView: some View {
        let monthColumnCount = dynamicTypeSize >= Theme.reflowSize ? 2 : 3
        let monthColumns = Array(repeating: GridItem(.flexible(), spacing: 12), count: monthColumnCount)
        let miniColumns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 7)

        return ScrollView {
            LazyVGrid(columns: monthColumns, alignment: .leading, spacing: 16) {
                ForEach(monthGroups) { group in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(group.monthKey)
                            .kitType(.group)
                            .kitHeld()
                            .foregroundStyle(Surface.ink)
                        LazyVGrid(columns: miniColumns, spacing: 4) {
                            ForEach(Array(group.days.enumerated()), id: \.offset) { _, day in
                                Button { emitPickDay(day.day) } label: {
                                    VStack(spacing: 1) {
                                        Text(day.label)
                                            .kitType(.badge)
                                            .kitHeld()
                                            .foregroundStyle(
                                                day.today
                                                    ? Color.white
                                                    : (day.inScope ? Surface.ink : Surface.meta)
                                            )
                                            .frame(width: 18, height: 18)
                                            .background {
                                                if day.today {
                                                    Circle().fill(accent.fill)
                                                }
                                            }
                                        Circle()
                                            .fill(day.items.isEmpty ? Color.clear : accent.fill)
                                            .frame(width: 3, height: 3)
                                    }
                                    .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .padding(10)
                    .kitCard()
                }
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
        }
    }

    // MARK: - Canvas events

    private func emitPickDay(_ day: String) {
        guard !day.isEmpty else { return }
        var pick = Centraid_Core_V1_RoomCalendarPickDay()
        pick.day = day
        var event = Centraid_Core_V1_RoomCanvasEvent()
        event.selectorID = canvasSelectorID
        event.kind = .calendarDay(pick)
        onCanvas(event)
    }

    private func emitCreate(day: String, minute: UInt32, allDay: Bool) {
        guard !day.isEmpty else { return }
        var create = Centraid_Core_V1_RoomCalendarCreateAt()
        create.day = day
        create.minute = minute
        create.allDay = allDay
        var event = Centraid_Core_V1_RoomCanvasEvent()
        event.selectorID = canvasSelectorID
        event.kind = .calendarCreate(create)
        onCanvas(event)
    }
}
