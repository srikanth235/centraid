import SwiftProtobuf
import SwiftUI

import CentraidShared

// HEALTH'S SHARED DRAWING PARTS (#1129).
//
// Every word, number and unit here is the state's, and every length is the state's basis points
// of its own span (10,000 is full): nothing here computes a typical, a range or a delta, and
// nothing picks a unit. The identity hue (olive, R-1129-10) is drawn in exactly one place — the
// bar of the period a chart's `current` names — and the app's icon chip, which is the catalogue's.

/// One Health event, encoded: the bytes every Health bridge takes.
func healthEvent<Event: SwiftProtobuf.Message>(_ type: Event.Type, _ build: (inout Event) -> Void) -> Data {
    var event = Event()
    build(&event)
    return event.encoded
}

/// A basis point length as a fraction, clamped: 10,000 is the whole span.
func healthFraction<Number: BinaryInteger>(_ basisPoints: Number) -> CGFloat {
    min(max(CGFloat(Int(basisPoints)) / 10_000, 0), 1)
}

// MARK: - The read law, per state

extension Centraid_Screen_V1_HealthHomeState {
    var readContent: ScreenContent<Centraid_Screen_V1_HealthHomeData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Screen_V1_HealthMetricState {
    var readContent: ScreenContent<Centraid_Screen_V1_HealthMetricData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

extension Centraid_Screen_V1_HealthWorkoutState {
    var readContent: ScreenContent<Centraid_Screen_V1_HealthWorkoutData> {
        switch content {
        case let .loading(loading)?: return .loading(loading.firstLoad)
        case let .failure(failure)?: return .failed(failure)
        case let .denied(denied)?: return .denied(denied)
        case let .data(data)?: return .data(data)
        case nil: return .loading(true)
        }
    }
}

// MARK: - A card

/// THE GROUND A GROUP OF FIGURES SITS ON: `bgElev`, the `lg` radius, a `line` hairline.
struct HealthCard<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder let content: () -> Content

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Theme.radius("lg", scheme))
                    .fill(Theme.color("bgElev", scheme))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radius("lg", scheme))
                    .strokeBorder(Theme.color("line", scheme), lineWidth: CentraidGeometry.hairline)
            )
    }
}

/// A short line of soft words under a group: a foot, a compare line, a caption.
struct HealthNote: View {
    let text: String

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if !text.isEmpty {
            Text(text)
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: - The range bar

/// WHERE A DAY SITS AGAINST THE MEMBER'S OWN USUAL RANGE (R-1129-8): the 25th–75th range as a
/// band, the day as a dot, both placed by the state's basis points. No dot when there is no
/// figure. The hero's bar carries its three labels under it.
struct HealthRangeBarView: View {
    let bar: Centraid_Screen_V1_HealthRangeBar
    var hero: Bool = false

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let track: CGFloat = hero ? 8 : 4
        let dot: CGFloat = hero ? 14 : 10
        VStack(alignment: .leading, spacing: 6) {
            GeometryReader { proxy in
                let width = proxy.size.width
                let low = healthFraction(bar.lowBp) * width
                let high = max(healthFraction(bar.highBp) * width, low)
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.color("bgSunken", scheme)).frame(height: track)
                    Capsule()
                        .fill(Theme.color("lineStrong", scheme))
                        .frame(width: max(high - low, track), height: track)
                        .offset(x: low)
                    if bar.hasValue_p {
                        Circle()
                            .fill(Theme.color("text", scheme))
                            .overlay(Circle().strokeBorder(Theme.color("bgElev", scheme), lineWidth: 2))
                            .frame(width: dot, height: dot)
                            .offset(x: min(max(healthFraction(bar.valueBp) * width - dot / 2, 0), width - dot))
                    }
                }
                .frame(height: dot)
            }
            .frame(height: dot)
            .accessibilityHidden(true)
            if hero, !(bar.startLabel.isEmpty && bar.middleLabel.isEmpty && bar.endLabel.isEmpty) {
                HStack {
                    Text(bar.startLabel)
                    Spacer(minLength: 8)
                    Text(bar.middleLabel)
                    Spacer(minLength: 8)
                    Text(bar.endLabel)
                }
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
                .lineLimit(1)
                .accessibilityHidden(true)
            }
        }
    }
}

// MARK: - One metric line (Today)

/// ONE DAILY METRIC AS TODAY LISTS IT: name and figure, when and the typical, the range bar.
/// The whole line is the tap to the metric's page.
struct HealthMetricLineView: View {
    let line: Centraid_Screen_V1_HealthMetricLine
    let onTap: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(line.label)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                    Spacer(minLength: 0)
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(line.value)
                            .centraidType("smallStrong")
                            .monospacedDigit()
                            .foregroundStyle(Theme.color("text", scheme))
                        if !line.unit.isEmpty {
                            Text(line.unit)
                                .centraidType("annotLabel")
                                .foregroundStyle(Theme.color("textSoft", scheme))
                        }
                    }
                }
                HStack(spacing: 12) {
                    Text(line.whenLabel)
                    Spacer(minLength: 0)
                    Text(line.typical)
                }
                .centraidType("annotLabel")
                .foregroundStyle(Theme.color("textSoft", scheme))
                if line.hasBar {
                    HealthRangeBarView(bar: line.bar).padding(.top, 8)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(line.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("health-metric-\(line.metric)")
    }
}

// MARK: - One workout row

/// ONE WORKOUT AS A LIST DRAWS IT: its kind's mark on a neutral chip, the title over the meta,
/// and when. The whole row opens the workout.
struct HealthWorkoutRow: View {
    let row: Centraid_Screen_V1_HealthWorkoutLine
    let onTap: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 14) {
                CentraidIconView(iconKey: row.iconKey, tint: Theme.color("text", scheme), size: 20)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(Theme.color("bgSunken", scheme)))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(1)
                    Text(row.meta)
                        .centraidType("annotLabel")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Text(row.whenLabel)
                    .centraidType("annotLabel")
                    .monospacedDigit()
                    .foregroundStyle(Theme.color("textSoft", scheme))
                CentraidIconView(iconKey: "ChevronRight", tint: Theme.color("textFaint", scheme), size: 16)
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
/// a gap and never a zero), and the period's average as a dashed rule. Ink only: the hue is the
/// chart's current bar, not a trend.
struct HealthSparkline: View {
    let points: [Int32]
    let average: Int32

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Canvas { context, size in
            let inset: CGFloat = 3
            let height = size.height - inset * 2
            func y(_ basisPoints: Int32) -> CGFloat { inset + height * (1 - healthFraction(basisPoints)) }
            if average >= 0 {
                var rule = Path()
                rule.move(to: CGPoint(x: 0, y: y(average)))
                rule.addLine(to: CGPoint(x: size.width, y: y(average)))
                context.stroke(rule, with: .color(Theme.color("lineStrong", scheme)), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
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
            context.stroke(line, with: .color(Theme.color("textSoft", scheme)), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            if let last {
                context.fill(Path(ellipseIn: CGRect(x: last.x - 3, y: last.y - 3, width: 6, height: 6)), with: .color(Theme.color("text", scheme)))
            }
        }
        .frame(width: 120, height: 48)
        .accessibilityHidden(true)
    }
}

// MARK: - The bar chart (a metric)

/// ONE METRIC OVER A WEEK, A MONTH OR A YEAR: a bar a bucket, its height the state's basis points
/// of the chart, no bar for a bucket with no value; the typical as a dashed rule with its label.
/// THE CURRENT BUCKET IS THE ONE HUE MARK (R-1129-10); a bucket above the typical is drawn in
/// soft ink, the rest in the quiet line.
struct HealthBarChart: View {
    let data: Centraid_Screen_V1_HealthMetricData

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let hue = scheme.centraidMarks[AppIds.shared.HEALTH]?.hue ?? Theme.color("text", scheme)
        let spacing: CGFloat = data.bars.count > 14 ? 3 : 8
        VStack(alignment: .leading, spacing: 8) {
            GeometryReader { proxy in
                let height = proxy.size.height
                ZStack(alignment: .topLeading) {
                    HStack(alignment: .bottom, spacing: spacing) {
                        ForEach(Array(data.bars.enumerated()), id: \.offset) { _, bar in
                            let fill = bar.current ? hue : Theme.color(bar.aboveTypical ? "textSoft" : "lineStrong", scheme)
                            RoundedRectangle(cornerRadius: spacing > 5 ? 4 : 2)
                                .fill(bar.hasValue_p ? fill : Color.clear)
                                .frame(height: bar.hasValue_p ? max(height * healthFraction(bar.heightBp), 2) : 0)
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .frame(height: height, alignment: .bottom)
                    if data.hasTypical_p {
                        let at = height * (1 - healthFraction(data.typicalBp))
                        Path { path in
                            path.move(to: CGPoint(x: 0, y: at))
                            path.addLine(to: CGPoint(x: proxy.size.width, y: at))
                        }
                        .stroke(Theme.color("textFaint", scheme), style: StrokeStyle(lineWidth: 2, dash: [5, 4]))
                        Text(data.typicalLabel)
                            .centraidType("eyebrow")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .padding(.horizontal, 4)
                            .background(Theme.color("bgElev", scheme))
                            .frame(maxWidth: .infinity, alignment: .trailing)
                            .offset(y: max(at - 18, 0))
                    }
                }
            }
            .frame(height: 200)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(data.chartLabel)
            .accessibilityAddTraits(.isImage)
            HStack {
                ForEach(Array(data.ticks.enumerated()), id: \.offset) { index, tick in
                    if index > 0 { Spacer(minLength: 4) }
                    Text(tick)
                }
            }
            .centraidType("annotLabel")
            .foregroundStyle(Theme.color("textSoft", scheme))
            .lineLimit(1)
            .accessibilityHidden(true)
        }
    }
}

// MARK: - A fact row

/// A LABEL AND ITS FIGURE, on one line: a metric page's facts, a workout's figures' foot.
struct HealthFactRow: View {
    let label: String
    let detail: String

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label)
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
            Spacer(minLength: 0)
            Text(detail)
                .centraidType("smallStrong")
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .foregroundStyle(Theme.color("text", scheme))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// THE SHEET'S BINDING, read from the state and written as an event (Money's shape).
func healthSheetBinding(_ open: Bool, close: @escaping () -> Void) -> Binding<Bool> {
    Binding(
        get: { open },
        set: { now in
            guard !now, open else { return }
            close()
        }
    )
}
