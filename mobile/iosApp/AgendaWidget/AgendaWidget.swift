import SwiftUI
import WidgetKit

private struct AgendaEntry: TimelineEntry {
    let date: Date
    let data: AgendaWidgetData?
}

private struct AgendaProvider: TimelineProvider {
    func placeholder(in context: Context) -> AgendaEntry { AgendaEntry(date: Date(), data: nil) }
    func getSnapshot(in context: Context, completion: @escaping (AgendaEntry) -> Void) {
        completion(AgendaEntry(date: Date(), data: AgendaWidgetData.read()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<AgendaEntry>) -> Void) {
        // Host updates reload this timeline. The timestamp makes the age of the
        // last vault read visible while the application is not running.
        completion(Timeline(entries: [AgendaEntry(date: Date(), data: AgendaWidgetData.read())], policy: .never))
    }
}

private struct AgendaWidgetView: View {
    let entry: AgendaEntry
    @Environment(\.colorScheme) private var scheme
    @Environment(\.widgetFamily) private var family


    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(entry.data?.title ?? KitWords.WIDGET_AGENDA)
                .centraidType("title").foregroundStyle(Theme.color("agendaText", scheme))
                .accessibilityIdentifier("agenda-widget-title")
            if let data = entry.data {
                Text(data.eventTitle).centraidType("body").lineLimit(family == .systemSmall ? 2 : 3)
                    .accessibilityIdentifier("agenda-widget-event")
                if !data.eventWhen.isEmpty { Text(data.eventWhen).centraidType("small").foregroundStyle(Theme.color("textSoft", scheme)) }
                if family != .systemSmall && !data.reminders.isEmpty {
                    Text(data.reminders).centraidType("title").foregroundStyle(Theme.color("agendaText", scheme))
                    Text(data.reminderTitle).centraidType("body").lineLimit(2)
                        .accessibilityIdentifier("agenda-widget-reminders")
                }
                Spacer(minLength: 0)
                HStack(spacing: 4) {
                    Text(data.updatedLabel)
                    Text(data.updatedAt, style: .date)
                    Text(data.updatedAt, style: .time)
                }.centraidType("small").foregroundStyle(Theme.color("textSoft", scheme))
                    .accessibilityIdentifier("agenda-widget-updated")
            } else {
                Text(KitWords.WIDGET_EMPTY).centraidType("body")
                Spacer(minLength: 0)
            }
            // A small WidgetKit widget has one tap destination. The medium
            // family supports the separate New reminder link.
            if family != .systemSmall {
                Link(entry.data?.newLabel ?? KitWords.WIDGET_NEW, destination: URL(string: "centraid://agenda/new")!)
                    .centraidType("small").foregroundStyle(Theme.color("agendaText", scheme))
                    .accessibilityIdentifier("agenda-widget-new")
            }
        }
        .containerBackground(Theme.color("bgElev", scheme), for: .widget)
        .widgetURL(URL(string: "centraid://agenda/calendar"))
        .accessibilityHint(entry.data?.openLabel ?? KitWords.WIDGET_OPEN)
        .accessibilityIdentifier("agenda-widget")
        .privacySensitive()
    }
}

@main
struct CentraidAgendaWidget: Widget {
    let kind = "dev.centraid.agenda"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: AgendaProvider()) { entry in AgendaWidgetView(entry: entry) }
            .configurationDisplayName(LocalizedStringKey(KitWords.WIDGET_AGENDA))
            .description(LocalizedStringKey(KitWords.WIDGET_OPEN))
            .supportedFamilies([.systemSmall, .systemMedium])
    }
}
