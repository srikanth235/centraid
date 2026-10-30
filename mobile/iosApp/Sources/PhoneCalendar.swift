import EventKit
import Foundation

/// THE PHONE'S CALENDARS, READ FOR THE CORE (#1135): the `CalendarRead` effect
/// answered with a `CalendarSnapshot` — every occurrence in the window as the OS
/// holds it, an occurrence of a series carrying its series (the master's rule
/// and its own first occurrence), a cancelled occurrence simply absent. Rust
/// folds a series back into one event and makes every record; this reads and
/// words nothing. iOS 17's full access is asked only when the effect says the
/// member's tap may ask, never at launch.
enum PhoneCalendar {
    /// EventKit posts `EKEventStoreChanged` only for a store that exists, so one
    /// is held for the life of the process. Making it asks for nothing.
    static let watcher = EKEventStore()

    /// Full access the member has already given. Never prompts.
    static var granted: Bool {
        EKEventStore.authorizationStatus(for: .event) == .fullAccess
    }

    /// The effect's answer: a snapshot, or a refusal by value when access is not given.
    static func snapshot(_ read: Centraid_Core_V1_CalendarRead) async -> Centraid_Core_V1_EffectResult.OneOf_Outcome {
        let store = EKEventStore()
        if read.askPermission {
            guard (try? await store.requestFullAccessToEvents()) ?? false else { return .failed(denied()) }
        } else if !granted {
            return .failed(denied())
        }
        return await Task.detached(priority: .utility) { .calendar(snapshot(store, read)) }.value
    }

    private static func denied() -> Centraid_Core_V1_EffectFailed {
        var failed = Centraid_Core_V1_EffectFailed()
        failed.reason = "calendar access not given"
        failed.denied = true
        return failed
    }

    /// This install's id, minted once and kept off the vault (R-1127-10).
    static var deviceID: String {
        let key = "dev.centraid.install-id"
        if let known = UserDefaults.standard.string(forKey: key) { return known }
        let minted = UUID().uuidString
        UserDefaults.standard.set(minted, forKey: key)
        return minted
    }

    /// **Complete only with full access** (R-1127-10), which is the only access this reads under.
    private static func snapshot(_ store: EKEventStore, _ read: Centraid_Core_V1_CalendarRead) -> Centraid_Core_V1_CalendarSnapshot {
        let now = Date()
        // ONLY CALENDARS THE MEMBER WRITES TO: a subscribed holiday calendar
        // is nobody's own events, and the Birthdays calendar would copy what
        // Contacts -> People already brought in. Each is listed, empty or not.
        let own = store.calendars(for: .event)
            .filter(\.allowsContentModifications)
            .sorted { $0.calendarIdentifier < $1.calendarIdentifier }
        var out = Centraid_Core_V1_CalendarSnapshot()
        out.nowMs = Int64(now.timeIntervalSince1970 * 1000)
        out.deviceZone = TimeZone.current.identifier
        out.complete = granted
        out.deviceID = deviceID
        out.calendars = own.map { calendar in
            var entry = Centraid_Core_V1_PhoneCalendar()
            entry.key = calendar.calendarIdentifier
            entry.sourceTitle = calendar.source?.title ?? ""
            entry.title = calendar.title
            entry.color = hex(calendar.cgColor)
            return entry
        }
        out.events = events(store, own, now, read)
        return out
    }

    /// `uid:` plus the iCal UID the provider fills, else `local:` plus an id that means something on this device only.
    private static func phoneId(_ item: EKCalendarItem, fallback: String) -> String {
        if let uid = item.calendarItemExternalIdentifier, !uid.isEmpty { return "uid:" + uid }
        return "local:" + fallback
    }

    private static func events(
        _ store: EKEventStore,
        _ own: [EKCalendar],
        _ now: Date,
        _ read: Centraid_Core_V1_CalendarRead
    ) -> [Centraid_Core_V1_PhoneCalendarEvent] {
        guard !own.isEmpty else { return [] }
        let calendar = Calendar.current
        let from = calendar.date(byAdding: .day, value: -Int(read.daysBack), to: calendar.startOfDay(for: now)) ?? now
        let to = calendar.date(byAdding: .day, value: Int(read.daysOn), to: now) ?? now
        let predicate = store.predicateForEvents(withStart: from, end: to, calendars: own)
        var masters: [String: Master?] = [:]
        // Read in calendar order, so an invitation held by two calendars is kept under the same one every pass.
        let found = store.events(matching: predicate)
            .sorted { ($0.calendar?.calendarIdentifier ?? "") < ($1.calendar?.calendarIdentifier ?? "") }
        return found.compactMap { (event: EKEvent) -> Centraid_Core_V1_PhoneCalendarEvent? in
            guard let start = event.startDate, let end = event.endDate else { return nil }
            let zone = event.timeZone ?? TimeZone.current
            let master = (event.hasRecurrenceRules || event.isDetached)
                ? lookup(seriesKey(event), store, &masters) : nil
            // WHERE THE RULE PUT A MOVED ONE, read in the SERIES' zone — the
            // one the vault keys its occurrences in.
            let original = event.isDetached ? event.occurrenceDate : nil
            var out = Centraid_Core_V1_PhoneCalendarEvent()
            out.title = event.title ?? ""
            out.notes = event.notes ?? ""
            out.allDay = event.isAllDay
            out.free = event.availability == .free
            if let series = master?.series { out.series = series }
            out.moved = master != nil && event.isDetached
            out.phoneID = phoneId(event, fallback: event.eventIdentifier ?? event.calendarItemIdentifier)
            out.calendarKey = event.calendar?.calendarIdentifier ?? ""
            out.url = event.url?.absoluteString ?? ""
            out.location = event.location ?? ""
            if event.isAllDay {
                // EventKit ends an all-day event at the next midnight (or
                // 23:59:59); the all-day end is the LAST day, inclusive.
                let last = end.addingTimeInterval(-1)
                out.start = civil(start, zone, "yyyy-MM-dd")
                out.end = civil(max(last, start), zone, "yyyy-MM-dd")
                out.originalStart = master.flatMap { m in original.map { civil($0, m.zone, "yyyy-MM-dd") } } ?? ""
            } else {
                out.start = civil(start, zone, "yyyy-MM-dd'T'HH:mm:ss")
                out.end = civil(end, zone, "yyyy-MM-dd'T'HH:mm:ss")
                out.tz = event.timeZone?.identifier ?? ""
                out.originalStart = master.flatMap { m in original.map { civil($0, m.zone, "yyyy-MM-dd'T'HH:mm:ss") } } ?? ""
            }
            return out
        }
    }

    /// `#RRGGBB` of a calendar's colour as the sRGB it paints with; empty when it has none.
    private static func hex(_ color: CGColor?) -> String {
        guard let color,
              let srgb = color.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil),
              let parts = srgb.components, parts.count >= 3
        else { return "" }
        let byte = { (value: CGFloat) in Int((min(max(value, 0), 1) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", byte(parts[0]), byte(parts[1]), byte(parts[2]))
    }

    /// A series' master, and the zone its wall clocks are read in.
    private struct Master {
        let series: Centraid_Core_V1_PhoneCalendarSeries
        let zone: TimeZone
    }

    /// THE SERIES AN OCCURRENCE BELONGS TO: its `eventIdentifier` without the
    /// `/RID=…` a moved (detached) occurrence carries — that one has a
    /// `calendarItemIdentifier` of its own, so the item id would orphan it.
    private static func seriesKey(_ event: EKEvent) -> String {
        guard let id = event.eventIdentifier else { return "" }
        return id.range(of: "/RID=").map { String(id[..<$0.lowerBound]) } ?? id
    }

    /// THE SERIES OF ONE EVENT IDENTIFIER, looked up once: EventKit answers a
    /// recurring event's FIRST occurrence for it, whose times are the series'
    /// own. More than one rule, or none, is no series — its occurrences
    /// import one by one.
    private static func lookup(_ id: String, _ store: EKEventStore, _ cache: inout [String: Master?]) -> Master? {
        if id.isEmpty { return nil }
        if let known = cache[id] { return known }
        var found: Master?
        if let first = store.event(withIdentifier: id),
           let rules = first.recurrenceRules, rules.count == 1,
           let start = first.startDate, let end = first.endDate {
            let zone = first.timeZone ?? TimeZone.current
            var series = Centraid_Core_V1_PhoneCalendarSeries()
            series.id = phoneId(first, fallback: id)
            series.rrule = rrule(rules[0])
            if first.isAllDay {
                series.start = civil(start, zone, "yyyy-MM-dd")
                series.end = civil(max(end.addingTimeInterval(-1), start), zone, "yyyy-MM-dd")
            } else {
                series.start = civil(start, zone, "yyyy-MM-dd'T'HH:mm:ss")
                series.end = civil(end, zone, "yyyy-MM-dd'T'HH:mm:ss")
            }
            found = Master(series: series, zone: zone)
        }
        cache[id] = found
        return found
    }

    /// AN `EKRecurrenceRule` AS RFC 5545 WRITES IT, every part it holds: the
    /// vault refuses a part it cannot honour, and the importer falls back to
    /// the occurrences, so a part is never dropped here.
    static func rrule(_ rule: EKRecurrenceRule) -> String {
        let days = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
        let frequency: String
        switch rule.frequency {
        case .daily: frequency = "DAILY"
        case .weekly: frequency = "WEEKLY"
        case .monthly: frequency = "MONTHLY"
        case .yearly: frequency = "YEARLY"
        @unknown default: return ""
        }
        var parts = ["FREQ=\(frequency)"]
        if rule.interval > 1 { parts.append("INTERVAL=\(rule.interval)") }
        let numbers = { (name: String, values: [NSNumber]?) in
            if let values, !values.isEmpty {
                parts.append("\(name)=" + values.map { $0.stringValue }.joined(separator: ","))
            }
        }
        if let weekdays = rule.daysOfTheWeek, !weekdays.isEmpty {
            parts.append("BYDAY=" + weekdays.map { day in
                (day.weekNumber != 0 ? "\(day.weekNumber)" : "") + days[day.dayOfTheWeek.rawValue - 1]
            }.joined(separator: ","))
        }
        numbers("BYMONTHDAY", rule.daysOfTheMonth)
        numbers("BYMONTH", rule.monthsOfTheYear)
        numbers("BYWEEKNO", rule.weeksOfTheYear)
        numbers("BYYEARDAY", rule.daysOfTheYear)
        numbers("BYSETPOS", rule.setPositions)
        if let end = rule.recurrenceEnd {
            if end.occurrenceCount > 0 {
                parts.append("COUNT=\(end.occurrenceCount)")
            } else if let until = end.endDate {
                parts.append("UNTIL=" + civil(until, TimeZone(identifier: "UTC")!, "yyyyMMdd'T'HHmmss'Z'"))
            }
        }
        if (1...7).contains(rule.firstDayOfTheWeek), rule.firstDayOfTheWeek != 1 {
            parts.append("WKST=" + days[rule.firstDayOfTheWeek - 1])
        }
        return parts.joined(separator: ";")
    }

    /// The wall clock of [date] in [zone]: what `propose_event` takes with `tz`.
    fileprivate static func civil(_ date: Date, _ zone: TimeZone, _ format: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = zone
        formatter.dateFormat = format
        return formatter.string(from: date)
    }
}