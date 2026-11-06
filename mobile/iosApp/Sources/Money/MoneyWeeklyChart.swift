import SwiftUI

/// The state supplies the amount, accessible description and each segment's height.
struct MoneyWeeklyChart: View {
    let series: Centraid_Core_V1_MoneyWeeklySeries
    @Environment(\.colorScheme) private var scheme
    @ScaledMetric(relativeTo: .caption) private var columnWidth: CGFloat = 48

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(series.heading).centraidType("smallStrong").accessibilityAddTraits(.isHeader)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(Array(series.weeks.enumerated()), id: \.offset) { _, week in
                        VStack(spacing: 8) {
                            VStack(spacing: 0) {
                                Spacer(minLength: 0)
                                ForEach(Array(week.segments.enumerated()), id: \.offset) { _, segment in
                                    Rectangle().fill(Theme.color(segment.colorKey, scheme))
                                        .frame(height: 140 * CGFloat(segment.heightBp) / 10_000)
                                        .accessibilityLabel(segment.label)
                                }
                            }
                            .frame(height: 140).clipShape(RoundedRectangle(cornerRadius: Theme.radius("sm", scheme)))
                            Text(week.total).centraidType("annotLabelOn").monospacedDigit()
                            Text(week.label).centraidType("annotLabel").foregroundStyle(Theme.color("textSoft", scheme))
                        }
                        .frame(width: columnWidth)
                        .accessibilityElement(children: .ignore).accessibilityLabel(week.accessibilityLabel)
                    }
                }
            }
        }
        .padding(16)
        .background(Theme.color("bgElev", scheme), in: RoundedRectangle(cornerRadius: Theme.radius("lg", scheme)))
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
    }
}

struct MoneyDayHeader: View {
    let title: String
    let total: String
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack {
                Text(title).frame(maxWidth: .infinity, alignment: .leading)
                Text(total).monospacedDigit()
            }
            VStack(alignment: .leading, spacing: 4) { Text(title); Text(total).monospacedDigit() }
        }
        .centraidType("annotLabelOn").foregroundStyle(Theme.color("textSoft", scheme))
        .padding(.horizontal, CentraidGeometry.pageMargin).padding(.top, 20).padding(.bottom, 8)
        .accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
    }
}
