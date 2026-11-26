import SwiftUI
import WidgetKit

struct GlanceEntry: TimelineEntry, Sendable {
    let date: Date
    let snapshot: TodayGlanceSnapshot?
}

struct GlanceProvider: TimelineProvider {
    func placeholder(in context: Context) -> GlanceEntry {
        GlanceEntry(date: Date(), snapshot: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (GlanceEntry) -> Void) {
        completion(GlanceEntry(date: Date(), snapshot: TodayGlanceSnapshot.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GlanceEntry>) -> Void) {
        completion(Self.timeline(now: Date(), snapshot: TodayGlanceSnapshot.load()))
    }

    static func timeline(now: Date, snapshot: TodayGlanceSnapshot?) -> Timeline<GlanceEntry> {
        Timeline(entries: [GlanceEntry(date: now, snapshot: snapshot)], policy: .never)
    }
}
