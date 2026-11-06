import SwiftUI

private final class TimelineMeasurement {
    var geometry: TimelineGeometry?
}

/// The same measured time map draws hour rules, block endpoints and both gestures.
struct AgendaTimelineView: View {
    let day: Centraid_Core_V1_AgendaHourDay
    let chrome: Centraid_Core_V1_AgendaChrome
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    @State private var measurement = TimelineMeasurement()
    @State private var viewport: CGFloat = 0
    @ScaledMetric(relativeTo: .caption) private var gutter: CGFloat = 56
    @ScaledMetric(relativeTo: .body) private var hourHeight: CGFloat = 64

    var body: some View {
        let lanes = max(1, Int(day.timeline.map(\.laneCount).max() ?? 1))
        let width = max(viewport, gutter + CentraidGeometry.pageMargin + 8 + CGFloat(lanes) * 120)
        ScrollView(.horizontal) {
            AgendaTimelineLayout(day: day, gutter: gutter, hourHeight: hourHeight, measurement: measurement) {
                ForEach(day.hours, id: \.key) { slot in
                    TimelineHour(slot: slot, chrome: chrome, gutter: gutter, open: open)
                }
                ForEach(Array(day.timeline.enumerated()), id: \.offset) { _, placement in
                    TimelineItemView(placement: placement, send: send, open: open) { translation, resize in
                        let row = placement.row.event
                        let step = row.adjustments.filter { $0.resize == resize && $0.deltaMinutes != 0 }.map { abs($0.deltaMinutes) }.min() ?? 0
                        let anchor = resize ? placement.endOffsetMs : placement.startOffsetMs
                        let delta = measurement.geometry?.delta(anchor: anchor, translation: Double(translation), stepMinutes: step) ?? 0
                        if delta != 0 { adjust(row, delta: delta, resize: resize) }
                    }
                }
            }
            .frame(width: width)
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { viewport = $0 }
        .accessibilityIdentifier("agenda-timeline-\(day.day)")
    }

    private func adjust(_ row: Centraid_Core_V1_AgendaEventRow, delta: Int32, resize: Bool) {
        send(.with { $0.eventAdjusted = .with { $0.instanceKey = row.instanceKey; $0.deltaMinutes = delta; $0.resize = resize } })
    }
}

private struct TimelinePlan {
    let geometry: TimelineGeometry
    let widths: [CGFloat]
    let heights: [CGFloat]
}

private struct AgendaTimelineLayout: Layout {
    let day: Centraid_Core_V1_AgendaHourDay
    let gutter: CGFloat
    let hourHeight: CGFloat
    let measurement: TimelineMeasurement
    private var leading: CGFloat { gutter + CentraidGeometry.pageMargin + 8 }

    private func plan(width: CGFloat, subviews: Subviews) -> TimelinePlan {
        let widths = day.timeline.map { placement in
            let lanes = CGFloat(max(1, placement.laneCount))
            return max(1, (width - leading - 4 * (lanes - 1)) / lanes)
        }
        let measured = day.timeline.indices.map { index in
            subviews[day.hours.count + index].sizeThatFits(.init(width: widths[index], height: nil)).height
        }
        let spans = day.timeline.enumerated().map { index, placement in
            let minimum: Double
            if case .nowLine? = placement.row.kind { minimum = 0 } else { minimum = Double(measured[index]) }
            return TimelineSpan(start: placement.startOffsetMs, end: placement.endOffsetMs, minimumHeight: minimum)
        }
        let geometry = TimelineGeometry(duration: day.durationMs, hourOffsets: day.hours.map(\.offsetMs), spans: spans, hourHeight: Double(hourHeight))
        let heights = day.timeline.enumerated().map { index, placement in
            max(measured[index], CGFloat(geometry.y(placement.endOffsetMs) - geometry.y(placement.startOffsetMs)))
        }
        return TimelinePlan(geometry: geometry, widths: widths, heights: heights)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 320
        let result = plan(width: width, subviews: subviews)
        measurement.geometry = result.geometry
        return CGSize(width: width, height: CGFloat(result.geometry.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = plan(width: bounds.width, subviews: subviews)
        measurement.geometry = result.geometry
        for (index, slot) in day.hours.enumerated() {
            let end = index + 1 < day.hours.count ? day.hours[index + 1].offsetMs : day.durationMs
            let y = CGFloat(result.geometry.y(slot.offsetMs))
            subviews[index].place(at: CGPoint(x: bounds.minX, y: bounds.minY + y), anchor: .topLeading,
                                  proposal: .init(width: bounds.width, height: CGFloat(result.geometry.y(end)) - y))
        }
        for (index, placement) in day.timeline.enumerated() {
            let x = leading + CGFloat(placement.lane) * (result.widths[index] + 4)
            subviews[day.hours.count + index].place(at: CGPoint(x: bounds.minX + x, y: bounds.minY + CGFloat(result.geometry.y(placement.startOffsetMs))), anchor: .topLeading,
                                                  proposal: .init(width: result.widths[index], height: result.heights[index]))
        }
    }
}

private struct TimelineHour: View {
    let slot: Centraid_Core_V1_AgendaHourSlot
    let chrome: Centraid_Core_V1_AgendaChrome
    let gutter: CGFloat
    let open: (Centraid_Core_V1_Route) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(slot.label).centraidType("annotLabel").foregroundStyle(Theme.color("textSoft", scheme))
                .monospacedDigit().fixedSize(horizontal: true, vertical: false).frame(width: gutter, alignment: .trailing)
            Color.clear.overlay(alignment: .top) { Rectangle().fill(Theme.color("line", scheme)).frame(height: 1) }
                .contentShape(Rectangle())
                .onLongPressGesture { if slot.hasCreateRoute { open(slot.createRoute) } }
                .accessibilityAction(named: Text(chrome.newEvent)) { if slot.hasCreateRoute { open(slot.createRoute) } }
                .accessibilityIdentifier("agenda-slot-\(slot.key)")
        }
        .padding(.leading, CentraidGeometry.pageMargin)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct TimelineItemView: View {
    let placement: Centraid_Core_V1_AgendaTimelineItem
    let send: (Centraid_Core_V1_AgendaHomeEvent) -> Void
    let open: (Centraid_Core_V1_Route) -> Void
    let onAdjust: (CGFloat, Bool) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        switch placement.row.kind {
        case let .event(row): event(row)
        case let .task(row):
            TodoRowView(row: row, onCheck: { id in send(.with { $0.taskChecked = .with { $0.taskID = id } }) }, onPick: open, embedded: true, identifierPrefix: "agenda-task-row",
                        onAction: { action in send(.with { $0.taskAction = action }) })
        case let .nowLine(now):
            HStack(spacing: 4) {
                Text(now.label).centraidType("annotLabelOn").foregroundStyle(Theme.color("agendaText", scheme))
                Rectangle().fill(Theme.color("agendaText", scheme)).frame(height: 2)
            }.accessibilityLabel(now.accessibilityLabel).accessibilityIdentifier("agenda-now-line")
        case .none: Color.clear.frame(height: 1)
        }
    }

    private func adjust(_ row: Centraid_Core_V1_AgendaEventRow, option: Centraid_Core_V1_AgendaEventAdjustment) {
        send(.with { $0.eventAdjusted = .with { $0.instanceKey = row.instanceKey; $0.deltaMinutes = option.deltaMinutes; $0.resize = option.resize } })
    }

    private func event(_ row: Centraid_Core_V1_AgendaEventRow) -> some View {
        VStack(spacing: 0) {
            Button { if row.hasRoute { open(row.route) } } label: {
                HStack(alignment: .top, spacing: 6) {
                    Rectangle().fill(Theme.color(KitHue.role(row.calendarHueKey) ?? "cSlate", scheme)).frame(width: 3, height: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.title).centraidType("bodyStrong").foregroundStyle(Theme.color("text", scheme))
                        Text(row.timeLabel).centraidType("annotLabel").foregroundStyle(Theme.color("textSoft", scheme))
                        if !row.statusLabel.isEmpty { Text(row.statusLabel).centraidType("annotLabel").foregroundStyle(Theme.color("attention", scheme)) }
                    }.fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                }.padding(8).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(row.accessibilityLabel)
            .accessibilityIdentifier("agenda-row-\(row.rowKey)")
            Spacer(minLength: 0)
            if let resize = row.adjustments.last(where: \.resize) {
                Capsule().fill(Theme.color("agendaText", scheme)).frame(width: 36, height: 4)
                    .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 5).onEnded { onAdjust($0.translation.height, true) })
                    .accessibilityLabel(resize.label)
                    .accessibilityAction { adjust(row, option: resize) }
                    .accessibilityIdentifier("agenda-resize-\(row.instanceKey)")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.color("agendaTint", scheme), in: RoundedRectangle(cornerRadius: Theme.radius("lg", scheme)))
        .simultaneousGesture(LongPressGesture(minimumDuration: 0.4).sequenced(before: DragGesture()).onEnded { value in
            if case let .second(true, drag?) = value { onAdjust(drag.translation.height, false) }
        })
        .contextMenu {
            ForEach(Array(row.adjustments.enumerated()), id: \.offset) { _, option in
                Button(option.label) { adjust(row, option: option) }
            }
        }
    }
}
