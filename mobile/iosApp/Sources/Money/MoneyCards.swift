import SwiftUI

// MONEY'S CARDS (#1173): the pieces Activity and Spending are drawn from, on the kit. The state
// carries every word, figure, colour key and length (as basis points); nothing here computes a
// figure or spells a sentence. A list colour is a key of the one palette (`color_key`, set by
// Rust); `docsListColor` only looks the colour set up.

/// A white card on a card page, its rows laid out with no gaps between.
struct MoneyCardStack<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0, content: content)
            .frame(maxWidth: .infinity, alignment: .leading)
            .kitCard()
    }
}

/// The ink a figure is drawn in: money in is the state green, a state tone its state colour,
/// otherwise plain ink. Money out is ink, never red.
func moneyInk(positive: Bool, tone: Centraid_Core_V1_StatusChip.Tone) -> Color {
    if positive { return StateColor.green.text }
    switch tone {
    case .net: return StateColor.red.text
    case .seam, .warning: return Surface.meta
    default: return Surface.ink
    }
}

// MARK: - The month's overview card

/// SPENT AND LEFT AGAINST THE TARGET, then In, Out and Net, in one card. The bar is spent over
/// planned (its length is the state's basis points) with a tick for how far through the month
/// today falls; over plan is the state red and the figure's own minus sign.
struct MoneyOverviewCard: View {
    let hero: Centraid_Core_V1_MoneyHero
    let daysLeft: String
    let inOut: Centraid_Core_V1_MoneyInOutNet?

    @Environment(\.appAccent) private var accent

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(hero.spentLabel)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                Text(hero.spent)
                    .kitType(.title)
                    .monospacedDigit()
                    .foregroundStyle(hero.over ? StateColor.red.text : Surface.ink)
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
                if hero.hasBar_p {
                    MoneyPlanBar(fillBp: hero.fillBp, tickBp: hero.tickBp, over: hero.over, spoken: hero.accessibilityLabel)
                        .padding(.top, 6)
                }
                HStack(alignment: .firstTextBaseline) {
                    Text(hero.figures.map { "\($0.label) \($0.amount)" }.joined(separator: " \u{00B7} "))
                        .kitType(.meta)
                        .foregroundStyle(Surface.body)
                        .lineLimit(2)
                    Spacer(minLength: 8)
                    Text(daysLeft)
                        .kitType(.meta)
                        .foregroundStyle(Surface.meta)
                        .lineLimit(1)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("money-hero")
            if let inOut, !inOut.figures.isEmpty {
                KitHairline(inset: 0).padding(.vertical, 12)
                HStack(alignment: .top, spacing: 12) {
                    ForEach(Array(inOut.figures.enumerated()), id: \.offset) { _, figure in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(figure.label)
                                .kitType(.meta)
                                .foregroundStyle(Surface.meta)
                            Text(figure.amount)
                                .kitType(.row)
                                .fontWeight(.semibold)
                                .monospacedDigit()
                                .foregroundStyle(moneyInk(positive: figure.positive, tone: figure.tone))
                                .minimumScaleFactor(0.75)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(MoneyWords.spoken(figure.label, figure.amount))
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .kitCard()
    }
}

/// A plan bar from the state's basis points: the fill in the app's colour (red over plan), and a
/// tick for the day.
struct MoneyPlanBar: View {
    let fillBp: UInt32
    let tickBp: UInt32
    let over: Bool
    let spoken: String

    @Environment(\.appAccent) private var accent

    private func fraction(_ bp: UInt32) -> Double { Double(min(bp, 10_000)) / 10_000 }

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(Surface.fill)
                Capsule()
                    .fill(over ? StateColor.red.fill : accent.fill)
                    .frame(width: width * fraction(fillBp))
                if tickBp > 0 {
                    Rectangle()
                        .fill(Surface.ink)
                        .frame(width: 2, height: 10)
                        .offset(x: min(width * fraction(tickBp), width - 2))
                }
            }
        }
        .frame(height: 10)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
    }
}

// MARK: - The review banner

/// ROWS THAT NEED A CATEGORY: the count in its badge, "Need a category · ₹4,310", and the word
/// that opens exactly those rows. Amber says it is pending.
struct MoneyReviewBanner: View {
    let count: String
    let title: String
    let review: String
    let spoken: String
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                Text(count)
                    .kitType(.meta)
                    .fontWeight(.bold)
                    .foregroundStyle(Color.white)
                    .frame(minWidth: 26, minHeight: 26)
                    .background(StateColor.amber.fill, in: Circle())
                Text(title)
                    .kitType(.row)
                    .foregroundStyle(Surface.ink)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(review)
                    .kitType(.row)
                    .fontWeight(.semibold)
                    .foregroundStyle(StateColor.amber.text)
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .background(StateColor.amber.tint, in: RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(spoken)
        .accessibilityIdentifier("money-needs-category")
    }
}

// MARK: - Day groups and rows

/// A DAY'S HEADING AND WHAT IT CAME TO: "Today" and "−₹2,450" (money in is green).
struct MoneyDayHeading: View {
    let section: Centraid_Core_V1_MoneyDaySection

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(section.heading)
                .kitType(.row)
                .fontWeight(.semibold)
                .foregroundStyle(Surface.ink)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            if !section.total.isEmpty {
                Text(section.total)
                    .kitType(.meta)
                    .monospacedDigit()
                    .foregroundStyle(section.totalPositive ? StateColor.green.text : Surface.meta)
                    .accessibilityLabel(MoneyWords.spoken(section.heading, section.total))
            }
        }
        .padding(.horizontal, 4)
        .padding(.top, 8)
    }
}

/// THE TRANSACTION ROW: a tile in the category's colour (or a swap glyph for a transfer, a
/// neutral tile in search), the name over its meta line, the signed amount, and any badge.
struct MoneyTxnRow: View {
    let row: Centraid_Core_V1_MoneyRow
    var onTap: (() -> Void)? = nil

    var body: some View {
        Button { onTap?() } label: {
            HStack(spacing: 12) {
                MoneyTile(row: row)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .kitType(.row)
                        .foregroundStyle(row.dimmed ? Surface.meta : Surface.ink)
                        .lineLimit(2)
                    if !row.meta.isEmpty {
                        Text(row.meta)
                            .kitType(.meta)
                            .foregroundStyle(Surface.meta)
                            .lineLimit(2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .trailing, spacing: 4) {
                    Text(row.amount)
                        .kitType(.row)
                        .fontWeight(.semibold)
                        .monospacedDigit()
                        .foregroundStyle(moneyInk(positive: row.positive, tone: row.amountTone))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    if !row.categoryLabel.isEmpty {
                        Text(row.categoryLabel)
                            .kitType(.meta)
                            .foregroundStyle(Surface.meta)
                            .lineLimit(1)
                    }
                    ForEach(Array(row.chips.enumerated()), id: \.offset) { _, chip in
                        StatusChipView(chip)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .disabled(onTap == nil)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(MoneyWords.spoken(row.accessibilityLabel, row.amount))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("money-row-\(row.txnID)")
    }
}

/// The tile at a row's start: the category's colour as a pale ground with its first letter, a
/// swap glyph for a transfer, and a dashed outline where the row has no category yet.
struct MoneyTile: View {
    let row: Centraid_Core_V1_MoneyRow

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let side: CGFloat = 36
        let shape = RoundedRectangle(cornerRadius: side * CentraidGeometry.iconChipRadiusRatio, style: .continuous)
        ZStack {
            if !row.tileIcon.isEmpty {
                shape.fill(Surface.fill)
                CentraidIconView(iconKey: row.tileIcon, tint: Surface.meta, size: 18)
            } else if row.colorKey.isEmpty {
                shape.fill(Surface.fill)
                Text(row.initial).kitType(.row).fontWeight(.semibold).foregroundStyle(Surface.body)
            } else {
                shape.fill(docsListColor(row.colorKey).opacity(scheme == .dark ? CentraidGeometry.iconChipTintDark : CentraidGeometry.iconChipTintLight))
                Text(row.initial).kitType(.row).fontWeight(.semibold).foregroundStyle(Surface.ink)
            }
        }
        .frame(width: side, height: side)
        .accessibilityHidden(true)
    }
}

// MARK: - Spending

/// THE SPENDING CHART: stacked bars, one per week or day, each cut by category. The state gives
/// every height as basis points of the tallest bar (or of the plan's pace), every colour as a
/// list-palette key and the words under it; a tap picks a bar and the caption follows.
struct MoneyBarsChart: View {
    let bars: Centraid_Core_V1_MoneyBars
    let onPick: (Int) -> Void

    @Environment(\.colorScheme) private var scheme

    private let chartHeight: CGFloat = 132

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .bottom) {
                HStack(alignment: .bottom, spacing: bars.bars.count > 8 ? 3 : 10) {
                    ForEach(Array(bars.bars.enumerated()), id: \.offset) { index, bar in
                        column(index, bar)
                    }
                }
                .frame(height: chartHeight + 22)
                if bars.paceBp > 0 {
                    pace
                }
            }
            if !bars.caption.isEmpty {
                Text(bars.caption)
                    .kitType(.meta)
                    .foregroundStyle(Surface.body)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("money-bars-caption")
            }
        }
    }

    private func column(_ index: Int, _ bar: Centraid_Core_V1_MoneyBar) -> some View {
        Button { onPick(index) } label: {
            VStack(spacing: 6) {
                ZStack(alignment: .bottom) {
                    Color.clear.frame(height: chartHeight)
                    if bar.upcoming {
                        RoundedRectangle(cornerRadius: Theme.radius("sm", scheme), style: .continuous)
                            .strokeBorder(Surface.border, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                            .frame(height: chartHeight * 0.34)
                    } else {
                        VStack(spacing: 0) {
                            // Top to bottom: the last segment is the top of the stack.
                            ForEach(Array(bar.segments.enumerated().reversed()), id: \.offset) { _, segment in
                                Rectangle()
                                    .fill(docsListColor(segment.colorKey))
                                    .frame(height: max(0, chartHeight * CGFloat(bar.heightBp) / 10_000 * CGFloat(segment.shareBp) / 10_000))
                            }
                        }
                        .clipShape(RoundedRectangle(cornerRadius: Theme.radius("sm", scheme), style: .continuous))
                    }
                }
                .overlay(alignment: .bottom) {
                    if bar.selected {
                        RoundedRectangle(cornerRadius: Theme.radius("md", scheme), style: .continuous)
                            .strokeBorder(Surface.ink, lineWidth: 2)
                            .frame(height: bar.upcoming ? chartHeight * 0.34 + 4 : max(8, chartHeight * CGFloat(bar.heightBp) / 10_000 + 4))
                            .padding(.horizontal, -2)
                    }
                }
                Text(bar.label)
                    .kitType(.meta)
                    .fontWeight(bar.selected ? .semibold : .regular)
                    .foregroundStyle(bar.selected ? Surface.ink : Surface.meta)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .frame(height: 16)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(bar.accessibilityLabel)
        .accessibilityAddTraits(bar.selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("money-bar-\(index)")
    }

    /// The plan's pace: a dashed line across the chart at its height, named at the trailing edge.
    private var pace: some View {
        VStack(spacing: 2) {
            Text(bars.paceLabel)
                .kitType(.meta)
                .foregroundStyle(Surface.meta)
                .frame(maxWidth: .infinity, alignment: .trailing)
            Rectangle()
                .stroke(Surface.meta, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                .frame(height: 1)
        }
        .offset(y: -(22 + chartHeight * CGFloat(bars.paceBp) / 10_000) + 8)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// ONE CATEGORY: its dot, what it spent, and the bar of its plan with the sentence under it
/// (over plan is the state red). A line with no plan has no bar.
struct MoneyCategoryProgressRow: View {
    let line: Centraid_Core_V1_MoneyCategoryLine
    let onTap: () -> Void

    @Environment(\.appAccent) private var accent

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 10) {
                    Circle().fill(docsListColor(line.colorKey)).frame(width: 10, height: 10)
                    Text(line.label)
                        .kitType(.row)
                        .foregroundStyle(Surface.ink)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(line.spent)
                        .kitType(.row)
                        .fontWeight(.semibold)
                        .monospacedDigit()
                        .foregroundStyle(Surface.ink)
                }
                if line.hasPlan_p {
                    GeometryReader { proxy in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Surface.fill)
                            Capsule()
                                .fill(line.over ? StateColor.red.fill : docsListColor(line.colorKey))
                                .frame(width: proxy.size.width * CGFloat(min(line.progressBp, 10_000)) / 10_000)
                        }
                    }
                    .frame(height: 6)
                }
                Text(line.caption)
                    .kitType(.meta)
                    .foregroundStyle(line.over ? StateColor.red.text : Surface.meta)
                    .lineLimit(2)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(line.accessibilityLabel)
        .accessibilityAddTraits(.isButton)
    }
}

/// "4 more categories" and "No category": a line under the categories that is not one of them.
/// A dashed dot says no category; the amber ground says it is waiting on the member.
struct MoneyRestRow: View {
    let line: Centraid_Core_V1_MoneyRestLine
    var pending: Bool = false
    let identifier: String
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 10) {
                if line.colorKey.isEmpty {
                    Circle()
                        .strokeBorder(Surface.meta, style: StrokeStyle(lineWidth: 1.2, dash: [2, 2]))
                        .frame(width: 10, height: 10)
                } else {
                    Circle().fill(docsListColor(line.colorKey)).frame(width: 10, height: 10)
                }
                Text(line.label)
                    .kitType(.row)
                    .foregroundStyle(Surface.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(line.amount)
                    .kitType(.row)
                    .fontWeight(.semibold)
                    .monospacedDigit()
                    .foregroundStyle(Surface.ink)
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .background(pending ? StateColor.amber.tint : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(KitRowPress())
        .accessibilityLabel(line.accessibilityLabel)
        .accessibilityIdentifier(identifier)
    }
}
