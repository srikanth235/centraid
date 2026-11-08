import SwiftUI
import WidgetKit

/// "Reminders": today's count and what needs attention (small), or the next four
/// reminders (medium). A tap opens the page the core names: the body opens
/// Reminders, a row on the medium widget opens its task, and the "New Reminder"
/// pill opens Reminders with the quick-add bar open. The widget holds only the
/// opaque keys the snapshot carries (`AgendaGlanceSnapshot.openURL`); the pill is a
/// `Link`, so nothing needs `AddReminderIntent` compiled into this extension.
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
            } else {
                // No snapshot yet (the app has not run): say so, never an empty healthy list.
                Spacer(minLength: 0)
                sentence(GlanceWords.WIDGET_UNAVAILABLE)
            }
            if entry.snapshot == nil || family == .systemSmall { Spacer(minLength: 0) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // THE BODY'S TAP (a row's or the pill's own Link wins over it). No snapshot or
        // no key sets none, and the tap opens the app as it always did.
        .widgetURL(AgendaGlanceSnapshot.openURL(entry.snapshot?.openReminders))
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
                Spacer(minLength: 4)
                if let url = AgendaGlanceSnapshot.openURL(snapshot.openAdd) {
                    NewReminderPill(label: snapshot.words.addLabel, url: url)
                }
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

/// THE MOCKUP'S "NEW REMINDER" PILL (`design/mockups/AgendaWidgets.dc.html`, the
/// medium Reminders widget): a tinted capsule, a plus and the core's word for the
/// action. A `Link` to the `open_add` key, so a tap opens Reminders with the
/// quick-add bar open; nothing is written until the member taps Add in the app.
private struct NewReminderPill: View {
    let label: String
    let url: URL

    var body: some View {
        Link(destination: url) {
            HStack(spacing: 4) {
                // A drawn plus (stated geometry, not an SF Symbol: the shell
                // draws no system icon set).
                ZStack {
                    Capsule().frame(width: 10, height: 2)
                    Capsule().frame(width: 2, height: 10)
                }
                .frame(width: 11, height: 11)
                .accessibilityHidden(true)
                Text(label)
                    .font(WidgetType.sans(12, semibold: true, relativeTo: .caption))
                    .lineLimit(1)
            }
            .foregroundStyle(WidgetPalette.agenda)
            .padding(.leading, 6)
            .padding(.trailing, 9)
            .frame(minHeight: 24)
            .background(WidgetPalette.agenda.opacity(0.14), in: Capsule())
        }
        .accessibilityLabel(label)
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
                linked(row) { content(row) }
            }
        }
    }

    private func content(_ row: AgendaGlanceSnapshot.Reminders.Row) -> some View {
        HStack(spacing: 8) {
            Circle()
                // THE BOARD DRAWS EVERY CIRCLE IN AGENDA'S BLUE; only the date wears the red.
                .stroke(WidgetPalette.agenda, lineWidth: 1.5)
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
                .privacySensitive()
        }
        .frame(minHeight: 24)
        .accessibilityElement(children: .combine)
    }

    /// A row is a `Link` to its task's key; a row with no key is plain.
    @ViewBuilder
    private func linked<Content: View>(
        _ row: AgendaGlanceSnapshot.Reminders.Row, @ViewBuilder content: () -> Content
    ) -> some View {
        if let url = AgendaGlanceSnapshot.openURL(row.open) {
            Link(destination: url) { content() }
        } else {
            content()
        }
    }
}
