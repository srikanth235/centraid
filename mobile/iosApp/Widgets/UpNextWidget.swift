import SwiftUI
import WidgetKit

/// "Up next": the next item of the day (small), or the next four (medium).
/// Tapping opens the app; a tap to a screen would need a route the core names
/// (owner follow-up), so no `widgetURL` is set.
struct UpNextWidget: Widget {
    static let kind = "dev.centraid.widget.upnext"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: GlanceProvider()) { entry in
            UpNextView(entry: entry)
                .containerBackground(for: .widget) { WidgetPalette.page }
        }
        .configurationDisplayName(GlanceWords.WIDGET_UP_NEXT_NAME)
        .description(GlanceWords.WIDGET_UP_NEXT_DESCRIPTION)
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct UpNextView: View {
    let entry: GlanceEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.snapshot?.words.upNextTitle ?? GlanceWords.WIDGET_UP_NEXT_NAME)
                .font(WidgetType.heading)
                .foregroundStyle(WidgetPalette.meta)
                .lineLimit(1)
            if let snapshot = entry.snapshot {
                if let notice = entry.notice {
                    Spacer(minLength: 0)
                    Text(notice)
                        .font(WidgetType.body)
                        .foregroundStyle(WidgetPalette.ink)
                        .minimumScaleFactor(0.8)
                } else if snapshot.upNext.isEmpty {
                    Spacer(minLength: 0)
                    Text(snapshot.words.nothingNext)
                        .font(WidgetType.body)
                        .foregroundStyle(WidgetPalette.ink)
                        .minimumScaleFactor(0.8)
                } else if family == .systemSmall {
                    UpNextSmall(item: snapshot.upNext[0])
                } else {
                    UpNextRows(items: Array(snapshot.upNext.prefix(4)))
                }
            }
            if entry.snapshot == nil || family == .systemSmall { Spacer(minLength: 0) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The small widget's one item: its time in the item's tint, its title, its day.
private struct UpNextSmall: View {
    let item: AgendaGlanceSnapshot.UpNext

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(item.timeLabel)
                .font(WidgetType.bigTime)
                .foregroundStyle(item.allDay ? WidgetPalette.meta : WidgetPalette.tint(item.tint))
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .padding(.top, 4)
            Text(item.title)
                .font(WidgetType.body)
                .foregroundStyle(WidgetPalette.ink)
                .lineLimit(2)
                .privacySensitive()
            if !item.dayLabel.isEmpty {
                Text(item.dayLabel)
                    .font(WidgetType.meta)
                    .foregroundStyle(WidgetPalette.meta)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The medium widget's rows, with the day's label above the first row of a new day.
private struct UpNextRows: View {
    let items: [AgendaGlanceSnapshot.UpNext]
    @ScaledMetric(relativeTo: .footnote) private var timeWidth: CGFloat = 62

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if !item.dayLabel.isEmpty, index == 0 || items[index - 1].dayLabel != item.dayLabel {
                    Text(item.dayLabel)
                        .font(WidgetType.metaStrong)
                        .foregroundStyle(WidgetPalette.meta)
                        .lineLimit(1)
                        .padding(.top, 2)
                }
                row(item)
            }
        }
    }

    private func row(_ item: AgendaGlanceSnapshot.UpNext) -> some View {
        let tint = WidgetPalette.tint(item.tint)
        return HStack(spacing: 10) {
            Text(item.timeLabel)
                .font(WidgetType.metaStrong)
                .foregroundStyle(item.allDay ? WidgetPalette.meta : tint)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(width: timeWidth, alignment: .leading)
            RoundedRectangle(cornerRadius: 2)
                .fill(tint)
                .frame(width: 3, height: 16)
            Text(item.title)
                .font(WidgetType.rowTitle)
                .foregroundStyle(WidgetPalette.ink)
                .lineLimit(1)
                .privacySensitive()
        }
        .accessibilityElement(children: .combine)
    }
}
