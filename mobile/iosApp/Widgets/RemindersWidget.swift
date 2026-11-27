import SwiftUI
import WidgetKit

struct RemindersWidget: Widget {
    static let kind = "dev.centraid.widget.reminders"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: GlanceProvider()) { entry in
            RemindersView(entry: entry)
                .containerBackground(for: .widget) { WidgetPalette.page }
        }
        .configurationDisplayName("Reminders")
        .description("Today's reminders.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct RemindersView: View {
    let entry: GlanceEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.snapshot?.title ?? "Reminders")
                .font(WidgetType.heading)
                .foregroundStyle(WidgetPalette.calendar)
                .lineLimit(1)
            if let snapshot = entry.snapshot {
                let tasks = snapshot.lines.filter { $0.kind == "task" }
                if tasks.isEmpty {
                    Spacer(minLength: 0)
                    sentence(snapshot.summary)
                } else {
                    let shown = family == .systemSmall ? Array(tasks.prefix(2)) : Array(tasks.prefix(3))
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
                sentence("Open Centraid to see your day")
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func row(_ line: TodayGlanceSnapshot.Line) -> some View {
        HStack(spacing: 8) {
            Circle()
                .stroke(WidgetPalette.calendar, lineWidth: 1.5)
                .frame(width: 14, height: 14)
            Text(line.text)
                .font(WidgetType.rowTitle)
                .foregroundStyle(WidgetPalette.ink)
                .lineLimit(1)
                .privacySensitive()
        }
        .frame(minHeight: 24)
        .accessibilityElement(children: .combine)
    }

    private func sentence(_ text: String) -> some View {
        Text(text)
            .font(WidgetType.body)
            .foregroundStyle(WidgetPalette.ink)
            .minimumScaleFactor(0.8)
    }
}
