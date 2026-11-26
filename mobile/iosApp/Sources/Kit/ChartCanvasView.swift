import SwiftUI

enum CanvasHue {
    static func color(
        for hueKey: String,
        fallbackIndex: Int = 0,
        scheme: ColorScheme,
        accent: AppAccent
    ) -> Color {
        switch hueKey.lowercased() {
        case "blue": return Color(CentraidAsset.listBlue)
        case "graphite": return Color(CentraidAsset.listGraphite)
        case "indigo": return Color(CentraidAsset.listIndigo)
        case "mustard": return Color(CentraidAsset.listMustard)
        case "orchid": return Color(CentraidAsset.listOrchid)
        case "petrol": return Color(CentraidAsset.listPetrol)
        case "raspberry": return Color(CentraidAsset.listRaspberry)
        case "violet": return Color(CentraidAsset.listViolet)
        case "calendar": return AppAccent("calendar").fill
        case "docs": return AppAccent("docs").fill
        case "health": return AppAccent("health").fill
        case "locker": return AppAccent("locker").fill
        case "money": return AppAccent("money").fill
        case "notes": return AppAccent("notes").fill
        case "people": return AppAccent("people").fill
        case "photos": return AppAccent("photos").fill
        case "reminders": return AppAccent("reminders").fill
        case "green", "income": return StateColor.green.fill
        case "red", "expense", "net": return StateColor.red.fill
        case "amber", "warning": return StateColor.amber.fill
        default:
            if let role = KitHue.role(hueKey) {
                return Theme.color(role, scheme)
            }
            switch fallbackIndex % 6 {
            case 0: return accent.fill
            case 1: return Color(CentraidAsset.listPetrol)
            case 2: return Color(CentraidAsset.listBlue)
            case 3: return Color(CentraidAsset.listMustard)
            case 4: return Color(CentraidAsset.listViolet)
            default: return Color(CentraidAsset.listGraphite)
            }
        }
    }
}

struct ChartDomain: Equatable, Sendable {
    let xMin: Double
    let xMax: Double
    let yMin: Double
    let yMax: Double
    let hasBars: Bool
    let xStep: Double

    func xFraction(_ x: Double) -> CGFloat {
        let span = xMax - xMin
        guard span > 0 else { return 0.5 }
        return CGFloat(min(max((x - xMin) / span, 0), 1))
    }

    func yFraction(_ y: Double) -> CGFloat {
        let span = yMax - yMin
        guard span > 0 else { return 0.5 }
        return CGFloat(min(max((y - yMin) / span, 0), 1))
    }
}

struct ChartPointEntry: Equatable, Sendable {
    let seriesIndex: Int
    let id: String
    let x: Double
    let y: Double
    let yDisplay: Double
    let yBase: Double
    let yLow: Double
    let yHigh: Double
    let xLabel: String
    let yLabel: String
    let a11yLabel: String
    let mark: Centraid_Core_V1_RoomChartMark
}

struct ChartBarRect: Equatable, Sendable {
    let seriesIndex: Int
    let pointID: String
    let x: Double
    let slotIndex: Int
    let slotCount: Int
    let yBase: Double
    let yTop: Double
}

struct ChartLegendItem: Equatable, Sendable, Identifiable {
    let id: Int
    let seriesIndex: Int
    let label: String
    let hueKey: String
}

struct ChartLayout: Sendable {
    let domain: ChartDomain
    let hasData: Bool
    let entries: [ChartPointEntry]
    let barRects: [ChartBarRect]
    let legendItems: [ChartLegendItem]
    let horizontalInset: CGFloat

    static func build(from chart: Centraid_Core_V1_RoomChart) -> ChartLayout {
        var xs: [Double] = []
        var ys: [Double] = []
        var hasBars = false
        var anchorsZero = false
        var hasData = false

        var stackedPos: [String: Double] = [:]
        var stackedNeg: [String: Double] = [:]
        var entries: [ChartPointEntry] = []

        var barSlots: [String: Int] = [:]
        var barSlotCount = 0
        var barSeriesSlot: [Int: Int] = [:]

        for (seriesIndex, series) in chart.series.enumerated() {
            if !series.points.isEmpty { hasData = true }
            if series.mark == .bar {
                hasBars = true
                anchorsZero = true
                let slotKey = series.stack.isEmpty ? "#unstacked-\(seriesIndex)" : "stack:\(series.stack)"
                if let existing = barSlots[slotKey] {
                    barSeriesSlot[seriesIndex] = existing
                } else {
                    barSlots[slotKey] = barSlotCount
                    barSeriesSlot[seriesIndex] = barSlotCount
                    barSlotCount += 1
                }
            }
            if series.mark == .area {
                anchorsZero = true
            }
        }

        var barRects: [ChartBarRect] = []

        for (seriesIndex, series) in chart.series.enumerated() {
            for pt in series.points {
                xs.append(pt.x)
                let yBase: Double
                let yDisp: Double
                if series.mark == .bar && !series.stack.isEmpty {
                    let key = "\(series.stack)|\(pt.x.bitPattern)"
                    if pt.y >= 0 {
                        let prev = stackedPos[key] ?? 0
                        let next = prev + pt.y
                        stackedPos[key] = next
                        yBase = prev
                        yDisp = next
                    } else {
                        let prev = stackedNeg[key] ?? 0
                        let next = prev + pt.y
                        stackedNeg[key] = next
                        yBase = prev
                        yDisp = next
                    }
                    ys.append(yDisp)
                } else {
                    yBase = 0
                    yDisp = pt.y
                    ys.append(pt.y)
                }
                if pt.yHigh > pt.yLow {
                    ys.append(pt.yLow)
                    ys.append(pt.yHigh)
                }
                entries.append(
                    ChartPointEntry(
                        seriesIndex: seriesIndex,
                        id: pt.id,
                        x: pt.x,
                        y: pt.y,
                        yDisplay: yDisp,
                        yBase: yBase,
                        yLow: pt.yLow,
                        yHigh: pt.yHigh,
                        xLabel: pt.xLabel,
                        yLabel: pt.yLabel,
                        a11yLabel: pt.a11yLabel,
                        mark: series.mark
                    )
                )
                if series.mark == .bar, let slot = barSeriesSlot[seriesIndex] {
                    barRects.append(
                        ChartBarRect(
                            seriesIndex: seriesIndex,
                            pointID: pt.id,
                            x: pt.x,
                            slotIndex: slot,
                            slotCount: max(barSlotCount, 1),
                            yBase: yBase,
                            yTop: yDisp
                        )
                    )
                }
            }
        }

        for tick in chart.xTicks { xs.append(tick.at) }
        for tick in chart.yTicks { ys.append(tick.at) }
        for rule in chart.rules { ys.append(rule.at) }
        if anchorsZero { ys.append(0) }

        var xMin = xs.min() ?? 0
        var xMax = xs.max() ?? 1
        let distinctX = Array(Set(xs)).sorted()
        let xStep: Double
        if distinctX.count >= 2 {
            var minGap = Double.greatestFiniteMagnitude
            for i in 1..<distinctX.count {
                let gap = distinctX[i] - distinctX[i - 1]
                if gap > 0 && gap < minGap { minGap = gap }
            }
            xStep = minGap.isFinite ? minGap : 1
        } else {
            xStep = 1
        }
        if xMin == xMax {
            xMin -= 0.5
            xMax += 0.5
        }

        var yMin = ys.min() ?? 0
        var yMax = ys.max() ?? 1
        if yMin == yMax {
            if yMax > 0 {
                yMin = 0
                yMax *= 1.15
            } else {
                yMin -= 1
                yMax += 1
            }
        } else if chart.yTicks.isEmpty {
            let pad = (yMax - yMin) * 0.08
            yMax += pad
            if !anchorsZero || yMin < 0 {
                yMin -= pad
            }
        }

        let domain = ChartDomain(
            xMin: xMin,
            xMax: xMax,
            yMin: yMin,
            yMax: yMax,
            hasBars: hasBars,
            xStep: xStep
        )

        let legendItems: [ChartLegendItem] = chart.series.enumerated().compactMap { idx, s in
            guard !s.label.isEmpty else { return nil }
            return ChartLegendItem(id: idx, seriesIndex: idx, label: s.label, hueKey: s.hueKey)
        }

        let horizontalInset: CGFloat = hasBars ? 18 : 8
        return ChartLayout(
            domain: domain,
            hasData: hasData,
            entries: entries,
            barRects: barRects,
            legendItems: legendItems,
            horizontalInset: horizontalInset
        )
    }

    func activeEntry(for pointID: String) -> ChartPointEntry? {
        guard !pointID.isEmpty else { return nil }
        return entries.first { $0.id == pointID }
    }

    func nearestPointID(
        at location: CGPoint,
        in size: CGSize,
        verticalPadding: CGFloat = 8
    ) -> String? {
        let usableW = max(size.width - horizontalInset * 2, 1)
        let usableH = max(size.height - verticalPadding * 2, 1)
        var bestID: String?
        var bestDx = CGFloat.greatestFiniteMagnitude
        var bestDy = CGFloat.greatestFiniteMagnitude

        for entry in entries {
            guard !entry.id.isEmpty else { continue }
            let px = horizontalInset + domain.xFraction(entry.x) * usableW
            let py = verticalPadding + (1 - domain.yFraction(entry.yDisplay)) * usableH
            let dx = abs(px - location.x)
            let dy = abs(py - location.y)
            if dx < bestDx - 1 || (abs(dx - bestDx) <= 1 && dy < bestDy) {
                bestDx = dx
                bestDy = dy
                bestID = entry.id
            }
        }
        return bestID
    }

    static func readoutLabel(for entry: ChartPointEntry) -> String {
        if !entry.xLabel.isEmpty && !entry.yLabel.isEmpty {
            return "\(entry.xLabel) · \(entry.yLabel)"
        }
        return entry.yLabel.isEmpty ? entry.xLabel : entry.yLabel
    }

    static func spokenSummary(
        summary: String,
        emptySentence: String,
        activeEntry: ChartPointEntry?
    ) -> String {
        let base = summary.isEmpty ? emptySentence : summary
        let pointSpoken: String
        if let active = activeEntry {
            pointSpoken = active.a11yLabel.isEmpty ? readoutLabel(for: active) : active.a11yLabel
        } else {
            pointSpoken = ""
        }
        if !base.isEmpty && !pointSpoken.isEmpty {
            return "\(base). \(pointSpoken)"
        }
        return base.isEmpty ? pointSpoken : base
    }
}

struct ChartCanvasView: View {
    let chart: Centraid_Core_V1_RoomChart
    let onCanvas: (Centraid_Core_V1_RoomCanvasEvent) -> Void

    private let layout: ChartLayout

    @Environment(\.colorScheme) private var scheme
    @Environment(\.appAccent) private var accent
    @State private var activePointID: String

    init(
        chart: Centraid_Core_V1_RoomChart,
        onCanvas: @escaping (Centraid_Core_V1_RoomCanvasEvent) -> Void
    ) {
        self.chart = chart
        self.onCanvas = onCanvas
        self.layout = ChartLayout.build(from: chart)
        _activePointID = State(initialValue: chart.readoutPointID)
    }

    var body: some View {
        let activeEntry = layout.activeEntry(for: activePointID)
        let spoken = ChartLayout.spokenSummary(
            summary: chart.summary,
            emptySentence: chart.emptySentence,
            activeEntry: activeEntry
        )

        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if !layout.hasData {
                    emptyView
                } else {
                    if layout.legendItems.count > 1 {
                        legendRow
                    }
                    if let active = activeEntry {
                        let label = ChartLayout.readoutLabel(for: active)
                        if !label.isEmpty {
                            readoutBar(label: label, xFraction: layout.domain.xFraction(active.x))
                        }
                    }
                    chartBody(activeEntry: activeEntry)
                }
            }
            .padding(16)
            .kitCard()
            .padding(.horizontal, CentraidGeometry.pageMargin)
            .padding(.vertical, 8)
            .readableColumn()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(spoken)
        .accessibilityIdentifier(chart.selectorID.isEmpty ? "block-chart" : chart.selectorID)
        .onChange(of: chart.readoutPointID) { _, next in
            if next != activePointID {
                activePointID = next
            }
        }
    }

    private var emptyView: some View {
        Text(chart.emptySentence.isEmpty ? chart.summary : chart.emptySentence)
            .kitType(.meta)
            .foregroundStyle(Surface.meta)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, minHeight: 140)
    }

    private var legendRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                ForEach(layout.legendItems) { item in
                    HStack(spacing: 6) {
                        Circle()
                            .fill(
                                CanvasHue.color(
                                    for: item.hueKey,
                                    fallbackIndex: item.seriesIndex,
                                    scheme: scheme,
                                    accent: accent
                                )
                            )
                            .frame(width: 8, height: 8)
                        Text(item.label)
                            .kitType(.meta)
                            .kitHeld()
                            .foregroundStyle(Surface.meta)
                            .lineLimit(1)
                    }
                }
            }
        }
    }

    private func readoutBar(label: String, xFraction: CGFloat) -> some View {
        let leadingOffset: CGFloat = chart.yTicks.isEmpty ? 0 : 54
        return GeometryReader { proxy in
            let usable = max(proxy.size.width - leadingOffset - layout.horizontalInset * 2, 1)
            let anchorX = leadingOffset + layout.horizontalInset + xFraction * usable
            Text(label)
                .kitType(.meta)
                .fontWeight(.semibold)
                .monospacedDigit()
                .kitHeld()
                .foregroundStyle(Theme.color("textInv", scheme))
                .lineLimit(1)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Surface.ink, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .position(
                    x: min(max(anchorX, leadingOffset + 64), max(proxy.size.width - 64, leadingOffset + 64)),
                    y: 13
                )
                .accessibilityIdentifier("chart-readout")
        }
        .frame(height: 26)
    }

    private func chartBody(activeEntry: ChartPointEntry?) -> some View {
        let hasYTicks = !chart.yTicks.isEmpty
        let plotHeight: CGFloat = 196
        let verticalPadding: CGFloat = 8

        return VStack(spacing: 4) {
            HStack(alignment: .top, spacing: hasYTicks ? 6 : 0) {
                if hasYTicks {
                    yAxisColumn(height: plotHeight, verticalPadding: verticalPadding)
                        .frame(width: 48, height: plotHeight)
                }
                plotCanvas(
                    height: plotHeight,
                    verticalPadding: verticalPadding,
                    activeEntry: activeEntry
                )
            }
            if !chart.xTicks.isEmpty {
                xAxisRow(leadingOffset: hasYTicks ? 54 : 0)
            }
        }
    }

    private func yAxisColumn(height: CGFloat, verticalPadding: CGFloat) -> some View {
        let usableH = max(height - verticalPadding * 2, 1)
        return ZStack(alignment: .topTrailing) {
            ForEach(Array(chart.yTicks.enumerated()), id: \.offset) { _, tick in
                let y = verticalPadding + (1 - layout.domain.yFraction(tick.at)) * usableH
                Text(tick.label)
                    .kitType(.meta)
                    .monospacedDigit()
                    .kitHeld()
                    .foregroundStyle(Surface.meta)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .frame(width: 48, alignment: .trailing)
                    .position(x: 24, y: min(max(y, 8), height - 8))
            }
        }
    }

    private func xAxisRow(leadingOffset: CGFloat) -> some View {
        GeometryReader { proxy in
            let usableW = max(proxy.size.width - leadingOffset - layout.horizontalInset * 2, 1)
            ZStack(alignment: .leading) {
                ForEach(Array(chart.xTicks.enumerated()), id: \.offset) { _, tick in
                    let x = leadingOffset + layout.horizontalInset + layout.domain.xFraction(tick.at) * usableW
                    Text(tick.label)
                        .kitType(.meta)
                        .kitHeld()
                        .foregroundStyle(Surface.meta)
                        .lineLimit(1)
                        .position(x: x, y: 10)
                }
            }
        }
        .frame(height: 20)
    }

    private func plotCanvas(
        height: CGFloat,
        verticalPadding: CGFloat,
        activeEntry: ChartPointEntry?
    ) -> some View {
        let seriesColors = chart.series.enumerated().map { idx, s in
            CanvasHue.color(for: s.hueKey, fallbackIndex: idx, scheme: scheme, accent: accent)
        }
        let ruleColors = chart.rules.map { rule in
            RoomToneStyle.color(rule.tone, scheme: scheme, accent: accent, neutral: Surface.meta)
        }
        let gridColor = Surface.line
        let guideColor = Surface.border
        let cardColor = Surface.card

        return GeometryReader { proxy in
            ZStack(alignment: .topTrailing) {
                Canvas { context, size in
                    let usableW = max(size.width - layout.horizontalInset * 2, 1)
                    let usableH = max(size.height - verticalPadding * 2, 1)
                    func xOf(_ x: Double) -> CGFloat {
                        layout.horizontalInset + layout.domain.xFraction(x) * usableW
                    }
                    func yOf(_ y: Double) -> CGFloat {
                        verticalPadding + (1 - layout.domain.yFraction(y)) * usableH
                    }

                    for tick in chart.yTicks {
                        let y = yOf(tick.at)
                        var grid = Path()
                        grid.move(to: CGPoint(x: 0, y: y))
                        grid.addLine(to: CGPoint(x: size.width, y: y))
                        context.stroke(grid, with: .color(gridColor), lineWidth: CentraidGeometry.hairline)
                    }

                    drawRangeBands(context: &context, seriesColors: seriesColors, xOf: xOf, yOf: yOf)
                    drawRules(context: &context, size: size, ruleColors: ruleColors, yOf: yOf)
                    drawBars(
                        context: &context,
                        usableW: usableW,
                        seriesColors: seriesColors,
                        activePointID: activeEntry?.id ?? "",
                        xOf: xOf,
                        yOf: yOf
                    )
                    drawAreasAndLines(context: &context, seriesColors: seriesColors, xOf: xOf, yOf: yOf)
                    drawPoints(context: &context, seriesColors: seriesColors, cardColor: cardColor, xOf: xOf, yOf: yOf)

                    if let active = activeEntry {
                        let ax = xOf(active.x)
                        var guide = Path()
                        guide.move(to: CGPoint(x: ax, y: verticalPadding))
                        guide.addLine(to: CGPoint(x: ax, y: size.height - verticalPadding))
                        context.stroke(guide, with: .color(guideColor), lineWidth: 1)

                        if active.mark != .bar {
                            let ay = yOf(active.yDisplay)
                            let color = seriesColors[min(active.seriesIndex, max(seriesColors.count - 1, 0))]
                            let haloRect = CGRect(x: ax - 6, y: ay - 6, width: 12, height: 12)
                            let dotRect = CGRect(x: ax - 4, y: ay - 4, width: 8, height: 8)
                            context.fill(Path(ellipseIn: haloRect), with: .color(cardColor))
                            context.fill(Path(ellipseIn: dotRect), with: .color(color))
                        }
                    }
                }

                ForEach(Array(chart.rules.enumerated()), id: \.offset) { idx, rule in
                    if !rule.label.isEmpty {
                        let usableH = max(height - verticalPadding * 2, 1)
                        let y = verticalPadding + (1 - layout.domain.yFraction(rule.at)) * usableH
                        Text(rule.label)
                            .kitType(.badge)
                            .kitHeld()
                            .foregroundStyle(ruleColors[idx])
                            .lineLimit(1)
                            .position(x: max(proxy.size.width - 28, 28), y: max(y - 9, 8))
                    }
                }
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        scrub(at: value.location, in: proxy.size, verticalPadding: verticalPadding)
                    }
            )
        }
        .frame(height: height)
    }

    private func drawRangeBands(
        context: inout GraphicsContext,
        seriesColors: [Color],
        xOf: (Double) -> CGFloat,
        yOf: (Double) -> CGFloat
    ) {
        for (idx, series) in chart.series.enumerated() {
            let banded = series.points.filter { $0.yHigh > $0.yLow }
            guard !banded.isEmpty else { continue }
            let color = seriesColors[idx]
            if banded.count == 1, let pt = banded.first {
                let x = xOf(pt.x)
                let top = yOf(pt.yHigh)
                let bottom = yOf(pt.yLow)
                let rect = CGRect(x: x - 12, y: min(top, bottom), width: 24, height: max(abs(bottom - top), 2))
                context.fill(Path(roundedRect: rect, cornerRadius: 4), with: .color(color.opacity(0.10)))
            } else {
                var path = Path()
                for (i, pt) in banded.enumerated() {
                    let p = CGPoint(x: xOf(pt.x), y: yOf(pt.yHigh))
                    if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
                }
                for pt in banded.reversed() {
                    path.addLine(to: CGPoint(x: xOf(pt.x), y: yOf(pt.yLow)))
                }
                path.closeSubpath()
                context.fill(path, with: .color(color.opacity(0.10)))
            }
        }
    }

    private func drawRules(
        context: inout GraphicsContext,
        size: CGSize,
        ruleColors: [Color],
        yOf: (Double) -> CGFloat
    ) {
        let dashStyle = StrokeStyle(lineWidth: 1.5, dash: [4, 4])
        for (idx, rule) in chart.rules.enumerated() {
            let y = yOf(rule.at)
            var path = Path()
            path.move(to: CGPoint(x: 0, y: y))
            path.addLine(to: CGPoint(x: size.width, y: y))
            context.stroke(path, with: .color(ruleColors[idx]), style: dashStyle)
        }
    }

    private func drawBars(
        context: inout GraphicsContext,
        usableW: CGFloat,
        seriesColors: [Color],
        activePointID: String,
        xOf: (Double) -> CGFloat,
        yOf: (Double) -> CGFloat
    ) {
        guard !layout.barRects.isEmpty else { return }
        let span = max(layout.domain.xMax - layout.domain.xMin, layout.domain.xStep)
        let stepPx = max(CGFloat(layout.domain.xStep / span) * usableW, 12)
        let groupWidth = min(stepPx * 0.72, 48)
        let hasActiveBar = !activePointID.isEmpty && layout.barRects.contains { $0.pointID == activePointID }

        for bar in layout.barRects {
            let slots = CGFloat(max(bar.slotCount, 1))
            let gap: CGFloat = bar.slotCount > 1 ? 3 : 0
            let barWidth = max((groupWidth - gap * (slots - 1)) / slots, 4)
            let groupLeft = xOf(bar.x) - groupWidth / 2
            let left = groupLeft + CGFloat(bar.slotIndex) * (barWidth + gap)
            let y1 = yOf(bar.yBase)
            let y2 = yOf(bar.yTop)
            let top = min(y1, y2)
            let height = max(abs(y2 - y1), 2)
            let rect = CGRect(x: left, y: top, width: barWidth, height: height)
            let radius = min(6, barWidth / 2, height / 2)
            let baseColor = seriesColors[bar.seriesIndex]
            let fillColor: Color
            if hasActiveBar && bar.pointID != activePointID {
                fillColor = baseColor.opacity(0.32)
            } else {
                fillColor = baseColor
            }
            context.fill(Path(roundedRect: rect, cornerRadius: radius), with: .color(fillColor))
        }
    }

    private func drawAreasAndLines(
        context: inout GraphicsContext,
        seriesColors: [Color],
        xOf: (Double) -> CGFloat,
        yOf: (Double) -> CGFloat
    ) {
        let strokeStyle = StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round)
        let baselineY = yOf(min(max(0, layout.domain.yMin), layout.domain.yMax))

        for (idx, series) in chart.series.enumerated() {
            guard series.mark == .line || series.mark == .area, !series.points.isEmpty else { continue }
            let color = seriesColors[idx]
            var linePath = Path()
            for (i, pt) in series.points.enumerated() {
                let p = CGPoint(x: xOf(pt.x), y: yOf(pt.y))
                if i == 0 { linePath.move(to: p) } else { linePath.addLine(to: p) }
            }
            if series.mark == .area, let first = series.points.first, let last = series.points.last {
                var areaPath = linePath
                areaPath.addLine(to: CGPoint(x: xOf(last.x), y: baselineY))
                areaPath.addLine(to: CGPoint(x: xOf(first.x), y: baselineY))
                areaPath.closeSubpath()
                let gradient = Gradient(colors: [color.opacity(0.24), color.opacity(0.02)])
                context.fill(
                    areaPath,
                    with: .linearGradient(
                        gradient,
                        startPoint: CGPoint(x: 0, y: 0),
                        endPoint: CGPoint(x: 0, y: baselineY)
                    )
                )
            }
            context.stroke(linePath, with: .color(color), style: strokeStyle)
        }
    }

    private func drawPoints(
        context: inout GraphicsContext,
        seriesColors: [Color],
        cardColor: Color,
        xOf: (Double) -> CGFloat,
        yOf: (Double) -> CGFloat
    ) {
        for (idx, series) in chart.series.enumerated() {
            guard series.mark == .point else { continue }
            let color = seriesColors[idx]
            for pt in series.points {
                let cx = xOf(pt.x)
                let cy = yOf(pt.y)
                context.fill(
                    Path(ellipseIn: CGRect(x: cx - 5.5, y: cy - 5.5, width: 11, height: 11)),
                    with: .color(cardColor)
                )
                context.fill(
                    Path(ellipseIn: CGRect(x: cx - 4, y: cy - 4, width: 8, height: 8)),
                    with: .color(color)
                )
            }
        }
    }

    private func scrub(at location: CGPoint, in size: CGSize, verticalPadding: CGFloat) {
        guard let pointID = layout.nearestPointID(at: location, in: size, verticalPadding: verticalPadding),
              pointID != activePointID
        else { return }
        activePointID = pointID
        guard !chart.selectorID.isEmpty else { return }
        var scrub = Centraid_Core_V1_RoomChartScrubbed()
        scrub.pointID = pointID
        var event = Centraid_Core_V1_RoomCanvasEvent()
        event.selectorID = chart.selectorID
        event.kind = .chartScrub(scrub)
        onCanvas(event)
    }
}
