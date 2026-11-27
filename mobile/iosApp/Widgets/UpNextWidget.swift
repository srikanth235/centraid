import SwiftUI
import WidgetKit

struct UpNextWidget: Widget {
    static let kind = "dev.centraid.widget.upnext"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: GlanceProvider()) { entry in
            UpNextView(entry: entry)
                .containerBackground(for: .widget) { WidgetPalette.page }
        }
        .configurationDisplayName("Today")
        .description("Today's events and reminders.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct UpNextView: View {
    let entry: GlanceEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.snapshot?.title ?? "Today")
                .font(WidgetType.heading)
                .foregroundStyle(WidgetPalette.meta)
                .lineLimit(1)
            if let snapshot = entry.snapshot {
                if !snapshot.summary.isEmpty {
                    Text(snapshot.summary)
                        .font(WidgetType.meta)
                        .foregroundStyle(WidgetPalette.meta)
                        .lineLimit(1)
                }
                if snapshot.lines.isEmpty {
                    Spacer(minLength: 0)
                    Text(snapshot.summary)
                        .font(WidgetType.body)
                        .foregroundStyle(WidgetPalette.ink)
                        .minimumScaleFactor(0.8)
                } else {
                    let shown = family == .systemSmall ? Array(snapshot.lines.prefix(1)) : Array(snapshot.lines.prefix(3))
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(shown) { line in
                            if let url = URL(string: line.url) {
                                Link(destination: url) { row(line) }
                            } else {
                                row(line)
                            }
                        }
                    }
                    .padding(.top, 4)
                }
            } else {
                Spacer(minLength: 0)
                Text("Open Centraid to see your day")
                    .font(WidgetType.body)
                    .foregroundStyle(WidgetPalette.ink)
                    .minimumScaleFactor(0.8)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func row(_ line: TodayGlanceSnapshot.Line) -> some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 2)
                .fill(WidgetPalette.calendar)
                .frame(width: 3, height: 16)
            Text(line.text)
                .font(WidgetType.rowTitle)
                .foregroundStyle(WidgetPalette.ink)
                .lineLimit(1)
                .privacySensitive()
        }
        .accessibilityElement(children: .combine)
    }
}
