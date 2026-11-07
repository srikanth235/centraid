import SwiftUI
import WidgetKit

/// WHAT A WIDGET DRAWS AT ONE MOMENT: the snapshot as the app last kept it (nil
/// when there is none, or it is not a version-1 document) and the instant the
/// entry is for. Whether the day is stale is decided against `date`, so the entry
/// at `refresh_after` flips to the stale sentence without the app running.
struct GlanceEntry: TimelineEntry, Sendable {
    let date: Date
    let snapshot: AgendaGlanceSnapshot?

    /// The sentence shown instead of rows (unavailable, or stale), if any.
    var notice: String? { snapshot?.notice(now: date) }
}

/// THE ONE PROVIDER BOTH WIDGETS USE. Read-only: it loads the App Group file the
/// app wrote and never opens the vault or the core (the extension links neither).
///
/// The timeline is one entry now and, while the document is fresh, one at
/// `refresh_after`; `.atEnd` then asks again at that instant, finds the same
/// document stale and ends with `.never` (no loop). A new snapshot from the app
/// reloads every timeline (`AgendaGlanceWriter`).
struct GlanceProvider: TimelineProvider {
    func placeholder(in context: Context) -> GlanceEntry {
        GlanceEntry(date: Date(), snapshot: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (GlanceEntry) -> Void) {
        completion(GlanceEntry(date: Date(), snapshot: AgendaGlanceSnapshot.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GlanceEntry>) -> Void) {
        completion(Self.timeline(now: Date(), snapshot: AgendaGlanceSnapshot.load()))
    }

    static func timeline(now: Date, snapshot: AgendaGlanceSnapshot?) -> Timeline<GlanceEntry> {
        var entries = [GlanceEntry(date: now, snapshot: snapshot)]
        if let snapshot, snapshot.state == "ready", let refresh = snapshot.refreshDate, refresh > now {
            entries.append(GlanceEntry(date: refresh, snapshot: snapshot))
            return Timeline(entries: entries, policy: .atEnd)
        }
        return Timeline(entries: entries, policy: .never)
    }
}
