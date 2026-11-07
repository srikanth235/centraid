import SwiftUI
import WidgetKit

/// "Reminders": today's count and what needs attention (small), or the next four
/// reminders (medium). Tapping opens the app. A tap to Reminders itself would need
/// a route-carrying URL from the core (owner follow-up), so no `widgetURL` is set,
/// and the mockup's "New Reminder" pill is not here: a button that runs
/// `AddReminderIntent` needs the intent compiled into this extension.
struct RemindersWidget: Widget {
    static let kind = "dev.centraid.widget.reminders"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: GlanceProvider()) { entry in
            RemindersView(entry: entry)
                .containerBackground(for: .widget) { WidgetPalette.page }
        }
        .configurationDisplayName(GlanceWords.WIDGET_REMINDERS_NAME)
        .description(GlanceWords.WIDGET_REMINDERS_DESCRIPTION)
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct RemindersView: View {
    let entry: GlanceEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            header
            if let snapshot = entry.snapshot {
                if let notice = entry.notice {
                    Spacer(minLength: 0)
                    sentence(notice)
                } else if family == .systemSmall {
                    RemindersSmall(snapshot: snapshot)
                } else if snapshot.reminders.rows.isEmpty {
                    Spacer(minLength: 0)
                    sentence(snapshot.words.noReminders)
                } else {
                    RemindersRows(rows: Array(snapshot.reminders.rows.prefix(4)))
                }
            }
            if entry.snapshot == nil || family == .systemSmall { Spacer(minLength: 0) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Text(entry.snapshot?.words.remindersTitle ?? GlanceWords.WIDGET_REMINDERS_NAME)
                .font(WidgetType.heading)
                .foregroundStyle(WidgetPalette.agenda)
            if family == .systemMedium, entry.notice == nil, let snapshot = entry.snapshot {
                Text(snapshot.words.todayLabel)
                    .font(WidgetType.meta)
                    .foregroundStyle(WidgetPalette.meta)
            }
        }
        .lineLimit(1)
    }

    private func sentence(_ text: String) -> some View {
        Text(text)
            .font(WidgetType.body)
            .foregroundStyle(WidgetPalette.ink)
            .minimumScaleFactor(0.8)
    }
}

private struct RemindersSmall: View {
    let snapshot: AgendaGlanceSnapshot

    var body: some View {
        let reminders = snapshot.reminders
        if reminders.todayCount == 0, reminders.overdueCount == 0, reminders.flaggedCount == 0 {
            Spacer(minLength: 0)
            Text(snapshot.words.noReminders)
                .font(WidgetType.body)
                .foregroundStyle(WidgetPalette.ink)
                .minimumScaleFactor(0.8)
        } else {
            Text(String(reminders.todayCount))
                .font(WidgetType.bigCount)
                .foregroundStyle(WidgetPalette.agenda)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(snapshot.words.todayTitle)
                .font(WidgetType.metaStrong)
                .foregroundStyle(WidgetPalette.meta)
                .lineLimit(1)
            Spacer(minLength: 0)
            if reminders.overdueCount > 0 {
                Text(snapshot.words.overdueLabel)
                    .font(WidgetType.metaStrong)
                    .foregroundStyle(WidgetPalette.red)
                    .lineLimit(1)
            }
            if reminders.flaggedCount > 0 {
                Text(snapshot.words.flaggedLabel)
                    .font(WidgetType.meta)
                    .foregroundStyle(WidgetPalette.meta)
                    .lineLimit(1)
            }
        }
    }
}

private struct RemindersRows: View {
    let rows: [AgendaGlanceSnapshot.Reminders.Row]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(rows) { row in
                HStack(spacing: 8) {
                    Circle()
                        .stroke(row.overdue ? WidgetPalette.red : WidgetPalette.agenda, lineWidth: 1.5)
                        .frame(width: 14, height: 14)
                    Text(row.title)
                        .font(WidgetType.rowTitle)
                        .foregroundStyle(WidgetPalette.ink)
                        .lineLimit(1)
                        .privacySensitive()
                    Spacer(minLength: 4)
                    Text(row.dueLabel)
                        .font(WidgetType.meta)
                        .foregroundStyle(row.overdue ? WidgetPalette.red : WidgetPalette.meta)
                        .lineLimit(1)
                }
                .frame(minHeight: 24)
                .accessibilityElement(children: .combine)
            }
        }
    }
}
