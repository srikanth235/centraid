import SwiftUI
import WidgetKit

/// WHAT THE HEALTH WIDGET DRAWS AT ONE MOMENT (#1185): the snapshot as the app last
/// kept it (nil when there is none, or it is not a version-1 document) and the
/// instant the entry is for. Staleness is decided against `date`, so the entry at
/// `refresh_after` flips to the stale words without the app running.
struct HealthEntry: TimelineEntry, Sendable {
    let date: Date
    let snapshot: HealthGlanceSnapshot?
}

/// Read-only, like Agenda's provider: it loads the App Group file the app wrote and
/// never opens the vault or the core. One entry now and, while the document is
/// fresh, one at `refresh_after`; a new snapshot from the app reloads this widget
/// (`HealthGlanceWriter`).
struct HealthProvider: TimelineProvider {
    func placeholder(in context: Context) -> HealthEntry {
        HealthEntry(date: Date(), snapshot: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (HealthEntry) -> Void) {
        completion(HealthEntry(date: Date(), snapshot: HealthGlanceSnapshot.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<HealthEntry>) -> Void) {
        completion(Self.timeline(now: Date(), snapshot: HealthGlanceSnapshot.load()))
    }

    static func timeline(now: Date, snapshot: HealthGlanceSnapshot?) -> Timeline<HealthEntry> {
        var entries = [HealthEntry(date: now, snapshot: snapshot)]
        if let snapshot, snapshot.state == "ready", let refresh = snapshot.refreshDate, refresh > now {
            entries.append(HealthEntry(date: refresh, snapshot: snapshot))
            return Timeline(entries: entries, policy: .atEnd)
        }
        return Timeline(entries: entries, policy: .never)
    }
}

/// Today's steps, sleep and activity: the first figure big (small) or a 2x2 grid
/// (medium). Home-screen families only: figures about the body never draw on a
/// locked phone (the same ruling as Agenda's widgets), and each is `privacySensitive`.
/// A tap opens Health's home through the core's opaque key (`centraid://health`).
struct HealthWidget: Widget {
    static let kind = HealthGlanceSnapshot.widgetKind

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: HealthProvider()) { entry in
            HealthView(entry: entry)
                .containerBackground(for: .widget) { WidgetPalette.page }
        }
        .configurationDisplayName(GlanceWords.WIDGET_HEALTH_NAME)
        .description(GlanceWords.WIDGET_HEALTH_DESCRIPTION)
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct HealthView: View {
    let entry: HealthEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.snapshot?.words.title ?? GlanceWords.WIDGET_HEALTH_NAME)
                .font(WidgetType.heading)
                .foregroundStyle(WidgetPalette.meta)
                .lineLimit(1)
            if let snapshot = entry.snapshot {
                content(snapshot)
            } else {
                // No snapshot yet (the app has not run): say so, never an empty healthy day.
                Spacer(minLength: 0)
                sentence(GlanceWords.WIDGET_HEALTH_UNAVAILABLE)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(HealthGlanceSnapshot.openURL(entry.snapshot?.open))
    }

    @ViewBuilder
    private func content(_ snapshot: HealthGlanceSnapshot) -> some View {
        switch snapshot.state {
        case "ready":
            if snapshot.isStale(now: entry.date) {
                Spacer(minLength: 0)
                sentence(snapshot.words.stale)
                Text(snapshot.words.staleHint)
                    .font(WidgetType.meta)
                    .foregroundStyle(WidgetPalette.meta)
                    .lineLimit(2)
            } else if snapshot.figures.isEmpty {
                Spacer(minLength: 0)
                sentence(snapshot.words.nothing)
            } else if family == .systemSmall {
                HealthSmall(snapshot: snapshot)
            } else {
                HealthGrid(figures: Array(snapshot.figures.prefix(4)))
            }
        case "empty":
            Spacer(minLength: 0)
            sentence(snapshot.words.empty)
        default:
            Spacer(minLength: 0)
            sentence(snapshot.words.unavailable)
        }
    }

    private func sentence(_ text: String) -> some View {
        Text(text)
            .font(WidgetType.body)
            .foregroundStyle(WidgetPalette.ink)
            .minimumScaleFactor(0.8)
    }
}

/// The small widget: the first figure big, the steps caption under it when it is
/// steps, then last night's sleep.
private struct HealthSmall: View {
    let snapshot: HealthGlanceSnapshot

    var body: some View {
        let first = snapshot.figures[0]
        VStack(alignment: .leading, spacing: 2) {
            Text(first.text)
                .font(WidgetType.bigTime)
                .foregroundStyle(WidgetPalette.health)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .padding(.top, 4)
                .privacySensitive()
            if first.metric == "steps" {
                Text(snapshot.words.stepsCaption)
                    .font(WidgetType.meta)
                    .foregroundStyle(WidgetPalette.meta)
                    .lineLimit(1)
                    .privacySensitive()
            }
            if !snapshot.sleepLine.isEmpty {
                Text(snapshot.sleepLine)
                    .font(WidgetType.body)
                    .foregroundStyle(WidgetPalette.ink)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
                    .padding(.top, 4)
                    .privacySensitive()
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The medium widget: up to four figures in a 2x2 grid, each label above its text.
private struct HealthGrid: View {
    let figures: [HealthGlanceSnapshot.Figure]

    var body: some View {
        let columns = [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)]
        LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
            ForEach(figures) { figure in
                VStack(alignment: .leading, spacing: 0) {
                    Text(figure.label)
                        .font(WidgetType.meta)
                        .foregroundStyle(WidgetPalette.meta)
                        .lineLimit(1)
                    Text(figure.text)
                        .font(WidgetType.rowTitle)
                        .foregroundStyle(WidgetPalette.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .privacySensitive()
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.top, 4)
    }
}
