import SwiftUI

// HEALTH'S SHARED DRAWING PARTS (#1129, #1135, #1173).
//
// Every word, number and unit here is the state's, and every length is the state's basis points
// of its own span (10,000 is full): nothing here computes a typical, a range or a delta, and
// nothing picks a unit. INSIDE HEALTH EVERY METRIC WEARS THE HEALTH COLOUR (`AppAccent("health")`):
// a heart rate is not red and exercise is not green, because red and green mean a state. The one
// place a card is green is the line the core marks `good`.

/// A basis point length as a fraction, clamped: 10,000 is the whole span.
func healthFraction<Number: BinaryInteger>(_ basisPoints: Number) -> CGFloat {
    min(max(CGFloat(Int(basisPoints)) / 10_000, 0), 1)
}

// MARK: - A card

/// THE GROUND A GROUP OF FIGURES SITS ON: a white card on a card page (`kitCard`), or the same
/// with an edge on a plain page (`bordered`).
struct HealthCard<Content: View>: View {
    var padding: CGFloat = 16
    var bordered: Bool = false
    @ViewBuilder let content: () -> Content

    var body: some View {
        let inner = VStack(alignment: .leading, spacing: 0) { content() }
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
        if bordered { inner.kitBorderedCard() } else { inner.kitCard() }
    }
}

/// A short line of soft words under a group: a compare line, a caption.
struct HealthNote: View {
    let text: String

    var body: some View {
        if !text.isEmpty {
            Text(text)
                .kitType(.meta)
                .foregroundStyle(Surface.meta)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: - A pinned card (Summary)

/// SEVEN DAYS AS BARS: the last is today's and the Health colour, the rest quiet. A day with no
/// row (-1) draws no bar and never a zero.
struct HealthSparkBars: View {
    let points: [Int32]
    let label: String

    @Environment(\.appAccent) private var accent

    var body: some View {
        HStack(alignment: .bottom, spacing: 4) {
            ForEach(Array(points.enumerated()), id: \.offset) { index, point in
                Capsule()
                    .fill(index == points.count - 1 ? accent.fill : Surface.border)
                    .frame(width: 7, height: point < 0 ? 0 : max(40 * healthFraction(point), 3))
            }
        }
        .frame(height: 40, alignment: .bottom)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityAddTraits(.isImage)
    }
}

/// ONE PINNED METRIC: its mark and name in the Health colour, when, the figure, and the typical
/// under it. A wide card carries the sparkline; the rest sit two to a row. The whole card opens
/// the metric's page.
struct HealthPinnedCard: View {
    let line: Centraid_Core_V1_HealthMetricLine
    let identifier: String
    let onTap: () -> Void

    @Environment(\.appAccent) private var accent

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    CentraidIconView(iconKey: line.iconKey, tint: accent.text, size: line.wide ? 16 : 14)
                        .accessibilityHidden(true)
                    Text(line.label)
                        .kitType(.meta)
                        .fontWeight(.semibold)
                        .foregroundStyle(accent.text)
                        .lineLimit(1)
                    if line.wide {
                        Spacer(minLength: 8)
                        Text(line.whenLabel)
                            .kitType(.meta)
                            .foregroundStyle(Surface.meta)
                    }
                }
                if line.wide {
                    HStack(alignment: .bottom) {
                        VStack(alignment: .leading, spacing: 2) {
                            figure(size: CentraidScale.titleSize - 6, unitSize: CentraidScale.metaSize)
                            if !line.typical.isEmpty {
                                Text(line.typical)
                                    .kitType(.meta)
                                    .foregroundStyle(line.good ? StateColor.green.text : Surface.meta)
                            }
                        }
                        Spacer(minLength: 8)
                        HealthSparkBars(points: line.sparkBp, label: line.sparkLabel)
                    }
                } else {
                    figure(size: 22, unitSize: CentraidScale.metaSize)
                    Text(line.compactLine)
                        .kitType(.meta)
                        .foregroundStyle(Surface.meta)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .kitCard()
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(line.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier(identifier)
    }

    private func figure(size: CGFloat, unitSize: CGFloat) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Self.runs(line.value, size: size, unitSize: unitSize)
            if !line.unit.isEmpty {
                Text(line.unit)
                    .font(.system(size: unitSize))
                    .foregroundStyle(Surface.meta)
            }
        }
    }

    /// A FIGURE THAT CARRIES ITS OWN UNITS ("7 h 12 min", the core's words): the numbers in the
    /// figure's weight, every run of letters in the small meta unit, as the board draws it.
    static func runs(_ value: String, size: CGFloat, unitSize: CGFloat) -> Text {
        var text = Text("")
        var run = ""
        var isUnit = false
        func flush() {
            guard !run.isEmpty else { return }
            text = text + (isUnit
                ? Text(run).font(.system(size: unitSize)).foregroundColor(Surface.meta)
                : Text(run).font(.system(size: size, weight: .bold)).foregroundColor(Surface.ink))
            run = ""
        }
        for ch in value {
            let unit = ch.isLetter || ch == " "
            if unit != isUnit { flush() }
            isUnit = unit
            run.append(ch)
        }
        flush()
        return text.monospacedDigit()
    }
}

private extension Centraid_Core_V1_HealthMetricLine {
    /// A compact card has no room for "So far today" and the typical: the core's typical, or when
    /// there is none the when.
    var compactLine: String { typical.isEmpty ? whenLabel : typical }
}

/// ONE HIGHLIGHT: the Health colour's mark in a pale chip and the sentence, its middle in bold.
struct HealthHighlightCard: View {
    let highlight: Centraid_Core_V1_HealthHighlight
    let onTap: () -> Void

    @Environment(\.appAccent) private var accent
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 10) {
                CentraidIconView(iconKey: "BarChart2", tint: accent.text, size: 16)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(accent.wash(dark: scheme == .dark)))
                    .accessibilityHidden(true)
                (Text(highlight.lead) + Text(highlight.emphasis).font(.system(size: CentraidScale.rowSize, weight: .bold)) + Text(highlight.tail))
                    .kitType(.row)
                    .foregroundStyle(Surface.ink)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .kitCard()
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(highlight.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("health-highlight-\(highlight.metric)")
    }
}

// MARK: - One workout row

/// ONE WORKOUT AS A LIST DRAWS IT: its kind's mark in the Health colour on a pale chip, the title
/// over the meta, and when. The whole row opens the workout.
struct HealthWorkoutRow: View {
    let row: Centraid_Core_V1_HealthWorkoutLine
    let onTap: () -> Void

    @Environment(\.appAccent) private var accent
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 14) {
                CentraidIconView(iconKey: row.iconKey, tint: accent.text, size: 20)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(accent.wash(dark: scheme == .dark)))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .kitType(.row)
                        .fontWeight(.semibold)
                        .foregroundStyle(Surface.ink)
                        .lineLimit(1)
                    Text(row.meta)
                        .kitType(.meta)
                        .foregroundStyle(Surface.meta)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Text(row.whenLabel)
                    .kitType(.meta)
                    .monospacedDigit()
                    .foregroundStyle(Surface.meta)
                CentraidIconView(iconKey: "ChevronRight", tint: Surface.meta, size: 16)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("health-workout-\(row.activityID)")
    }
}

// MARK: - The sparkline (Trends)

/// A PERIOD'S SHAPE: the buckets oldest first as a line, broken where a bucket has no value (-1,
/// a gap and never a zero), and the period's average as a dashed rule. The line is the Health
/// colour; the rule is quiet.
struct HealthSparkline: View {
    let points: [Int32]
    let average: Int32

    @Environment(\.appAccent) private var accent

    var body: some View {
        Canvas { context, size in
            let inset: CGFloat = 3
            let height = size.height - inset * 2
            func y(_ basisPoints: Int32) -> CGFloat { inset + height * (1 - healthFraction(basisPoints)) }
            if average >= 0 {
                var rule = Path()
                rule.move(to: CGPoint(x: 0, y: y(average)))
                rule.addLine(to: CGPoint(x: size.width, y: y(average)))
                context.stroke(rule, with: .color(Surface.border), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
            guard points.count > 1 else { return }
            let step = (size.width - inset * 2) / CGFloat(points.count - 1)
            var line = Path()
            var drawing = false
            var last: CGPoint?
            for (index, point) in points.enumerated() {
                guard point >= 0 else {
                    drawing = false
                    continue
                }
                let at = CGPoint(x: inset + step * CGFloat(index), y: y(point))
                if drawing { line.addLine(to: at) } else { line.move(to: at) }
                drawing = true
                last = at
            }
            context.stroke(line, with: .color(accent.text), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            if let last {
                context.fill(Path(ellipseIn: CGRect(x: last.x - 3, y: last.y - 3, width: 6, height: 6)), with: .color(accent.fill))
            }
        }
        .frame(width: 120, height: 48)
        .accessibilityHidden(true)
    }
}

// MARK: - The bar chart (a metric)

/// ONE METRIC OVER A WEEK, A MONTH, 6 MONTHS OR A YEAR: a bar a bucket, its height the state's
/// basis points of the chart, no bar for a bucket with no value. The typical is a dashed rule
/// with its label, and the usual range a pale band behind the bars. THE CURRENT BUCKET, AND THE
/// BAR UNDER A FINGER, WEAR THE HEALTH COLOUR; the rest are its pale tint. A finger on the chart
/// scrubs: the bar under it shows the core's callout. The finger's place is the view's own (a
/// drag is never an event a frame).
struct HealthBarChart: View {
    let data: Centraid_Core_V1_HealthMetricData

    @Environment(\.appAccent) private var accent
    @State private var scrubbed: Int?

    /// THE TYPICAL'S WORD HAS A GUTTER OF ITS OWN (HealthMetric): at the line's end, past the last
    /// bar, never over it.
    private var gutter: CGFloat { data.hasTypical_p && !data.typicalLabel.isEmpty ? 52 : 0 }

    var body: some View {
        let spacing: CGFloat = data.bars.count > 14 ? 3 : 8
        VStack(alignment: .leading, spacing: 8) {
            GeometryReader { proxy in
                let height = proxy.size.height
                let width = proxy.size.width - gutter
                ZStack(alignment: .topLeading) {
                    if data.hasTypicalRange_p {
                        let top = height * (1 - healthFraction(data.typicalHighBp))
                        let bottom = height * (1 - healthFraction(data.typicalLowBp))
                        Rectangle()
                            .fill(accent.fill.opacity(0.08))
                            .frame(width: width, height: max(bottom - top, 2))
                            .offset(y: top)
                    }
                    HStack(alignment: .bottom, spacing: spacing) {
                        ForEach(Array(data.bars.enumerated()), id: \.offset) { index, bar in
                            let lit = bar.current || scrubbed == index
                            RoundedRectangle(cornerRadius: spacing > 5 ? 6 : 2)
                                .fill(bar.hasValue_p ? (lit ? accent.fill : accent.fill.opacity(0.28)) : Color.clear)
                                .frame(height: bar.hasValue_p ? max(height * healthFraction(bar.heightBp), 2) : 0)
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .frame(width: width, height: height, alignment: .bottom)
                    if data.hasTypical_p {
                        let at = height * (1 - healthFraction(data.typicalBp))
                        Path { path in
                            path.move(to: CGPoint(x: 0, y: at))
                            path.addLine(to: CGPoint(x: width, y: at))
                        }
                        .stroke(accent.text, style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                        Text(data.typicalLabel)
                            .kitType(.meta)
                            .foregroundStyle(accent.text)
                            .lineLimit(1)
                            .padding(.leading, 4)
                            .frame(width: gutter, alignment: .leading)
                            .offset(x: width, y: max(at - 9, 0))
                    }
                    if let index = scrubbed, data.bars.indices.contains(index), !data.bars[index].callout.isEmpty {
                        let slot = width / CGFloat(max(data.bars.count, 1))
                        let x = slot * (CGFloat(index) + 0.5)
                        let barTop = height * (1 - healthFraction(data.bars[index].heightBp))
                        Text(data.bars[index].callout)
                            .kitType(.meta)
                            .fontWeight(.semibold)
                            .foregroundStyle(Color.white)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Surface.ink.opacity(0.92), in: Capsule())
                            .fixedSize()
                            .position(x: min(max(x, 70), max(width - 70, 70)), y: max(barTop - 18, 12))
                            .accessibilityHidden(true)
                    }
                }
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { drag in
                            let slot = width / CGFloat(max(data.bars.count, 1))
                            let index = Int(drag.location.x / max(slot, 1))
                            scrubbed = min(max(index, 0), max(data.bars.count - 1, 0))
                        }
                        .onEnded { _ in scrubbed = nil }
                )
            }
            .frame(height: 200)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(data.chartLabel)
            .accessibilityAddTraits(.isImage)
            .accessibilityIdentifier("health-metric-chart")
            HStack {
                ForEach(Array(data.ticks.enumerated()), id: \.offset) { index, tick in
                    if index > 0 { Spacer(minLength: 4) }
                    Text(tick)
                }
            }
            .kitType(.meta)
            .foregroundStyle(Surface.meta)
            .lineLimit(1)
            .padding(.trailing, gutter)
            .accessibilityHidden(true)
        }
    }
}

// MARK: - A fact row

/// A LABEL AND ITS FIGURE, on one line: a metric page's facts.
struct HealthFactRow: View {
    let label: String
    let detail: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label)
                .kitType(.row)
                .foregroundStyle(Surface.ink)
            Spacer(minLength: 0)
            Text(detail)
                .kitType(.row)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .foregroundStyle(Surface.meta)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// THE SHEET'S BINDING, read from the state and written as an event (Money's shape).
@MainActor
func healthSheetBinding(_ open: Bool, close: @escaping @MainActor @Sendable () -> Void) -> Binding<Bool> {
    Binding(
        get: { open },
        set: { now in
            guard !now, open else { return }
            MainActor.assumeIsolated { close() }
        }
    )
}

extension Centraid_Core_V1_HealthMetricLine: Identifiable {
    public var id: String { metric }
}
