import EventKit
import Foundation

/// THE PHONE'S CALENDARS, WRITTEN FOR THE CORE (#1173, two-way sync): the `CalendarWrite` effect
/// answered with a `CalendarWritten`, one answer per item in the order asked.
///
/// **This performs and decides nothing.** Rust says which event, which calendar, which fields are
/// stated, which span (a series or one occurrence) and what the phone last stated of a delete; this
/// finds the event by the id the read minted (`PhoneCalendar.phoneId`), writes through EventKit and
/// answers the id of a created one in that same form. It NEVER asks for access: without full access
/// every item fails by value (`ok: false`), and Rust says what that means.
enum PhoneCalendarWrite {
    /// The effect's answer: one `CalendarWrittenItem` per `CalendarWriteItem`.
    static func perform(_ write: Centraid_Core_V1_CalendarWrite) async -> Centraid_Core_V1_EffectResult.OneOf_Outcome {
        let items = await Task.detached(priority: .utility) { run(write.items) }.value
        var written = Centraid_Core_V1_CalendarWritten()
        written.items = items
        return .calendarWritten(written)
    }

    /// Why an item was not done: never shown, only logged by Rust.
    private struct Failure: Error {
        let reason: String
    }

    private static func run(_ items: [Centraid_Core_V1_CalendarWriteItem]) -> [Centraid_Core_V1_CalendarWrittenItem] {
        let store = EKEventStore()
        let granted = PhoneCalendar.granted
        return items.map { (item) -> Centraid_Core_V1_CalendarWrittenItem in
            var answer = Centraid_Core_V1_CalendarWrittenItem()
            answer.eventID = item.eventID
            guard granted else {
                answer.ok = false
                answer.error = "calendar access not given"
                return answer
            }
            do {
                switch item.op {
                case .create:
                    answer.externalID = try create(item, store)
                    answer.ok = true
                case .update:
                    try update(item, store)
                    answer.ok = true
                case .delete:
                    answer.phoneKept = try delete(item, store)
                    answer.ok = true
                default:
                    throw Failure(reason: "unknown operation")
                }
            } catch let failure as Failure {
                answer.ok = false
                answer.error = failure.reason
            } catch {
                answer.ok = false
                answer.error = error.localizedDescription
            }
            return answer
        }
    }

    // MARK: Create, update, delete

    /// A new event in `calendar_key`; the answer is its id in the read's form.
    private static func create(_ item: Centraid_Core_V1_CalendarWriteItem, _ store: EKEventStore) throws -> String {
        guard let calendar = store.calendar(withIdentifier: item.calendarKey), calendar.allowsContentModifications else {
            throw Failure(reason: "the calendar cannot be written")
        }
        let event = EKEvent(eventStore: store)
        event.calendar = calendar
        try apply(item.fields, to: event)
        try store.save(event, span: .thisEvent, commit: true)
        return PhoneCalendar.phoneId(event, fallback: event.eventIdentifier ?? event.calendarItemIdentifier)
    }

    private static func update(_ item: Centraid_Core_V1_CalendarWriteItem, _ store: EKEventStore) throws {
        guard let master = find(item.externalID, calendarKey: item.calendarKey, store) else {
            throw Failure(reason: "the event is not on the phone")
        }
        switch item.span {
        case .this:
            guard let occurrence = occurrence(of: master, originalStart: item.originalStart, store) else {
                throw Failure(reason: "the occurrence is not on the phone")
            }
            if item.cancel {
                try store.remove(occurrence, span: .thisEvent, commit: true)
            } else {
                try apply(item.fields, to: occurrence)
                try store.save(occurrence, span: .thisEvent, commit: true)
            }
        default:
            // THE WHOLE SERIES: `.futureEvents` on the master; an event that does not repeat is itself.
            try apply(item.fields, to: master)
            try store.save(master, span: master.hasRecurrenceRules ? .futureEvents : .thisEvent, commit: true)
        }
    }

    /// Whether the phone's copy was KEPT: a delete is not performed when it differs from what the
    /// phone last stated (`expected`), and that is not a failure. An event already gone is done.
    private static func delete(_ item: Centraid_Core_V1_CalendarWriteItem, _ store: EKEventStore) throws -> Bool {
        guard let master = find(item.externalID, calendarKey: item.calendarKey, store) else { return false }
        var target = master
        if item.span == .this {
            guard let occurrence = occurrence(of: master, originalStart: item.originalStart, store) else { return false }
            target = occurrence
        }
        if item.hasExpected, differs(target, from: item.expected) { return true }
        let span: EKSpan = (item.span == .this || !target.hasRecurrenceRules) ? .thisEvent : .futureEvents
        try store.remove(target, span: span, commit: true)
        return false
    }

    /// The phone's copy against what Rust last read of it; an empty expected field states nothing.
    private static func differs(_ event: EKEvent, from expected: Centraid_Core_V1_CalendarStated) -> Bool {
        let (start, end) = civilRange(event)
        let pairs: [(String, String)] = [
            (expected.title, event.title ?? ""),
            (expected.notes, event.notes ?? ""),
            (expected.url, event.url?.absoluteString ?? ""),
            (expected.start, start),
            (expected.end, end),
        ]
        return pairs.contains { !$0.0.isEmpty && $0.0 != $0.1 }
    }

    // MARK: Finding

    /// The event for an id in the read's form: `local:` is an `eventIdentifier`, `uid:` an iCal UID
    /// (`calendarItemExternalIdentifier`), and for a series the master answers.
    private static func find(_ id: String, calendarKey: String, _ store: EKEventStore) -> EKEvent? {
        if id.hasPrefix("local:") {
            return store.event(withIdentifier: String(id.dropFirst("local:".count)))
        }
        if id.hasPrefix("uid:") {
            let found = store.calendarItems(withExternalIdentifier: String(id.dropFirst("uid:".count)))
                .compactMap { $0 as? EKEvent }
            return found.first { $0.calendar?.calendarIdentifier == calendarKey } ?? found.first
        }
        return nil
    }

    /// One occurrence of a series, found by where the series' rule put it (`original_start`, in the
    /// series' own wall clock), looked up in a window of a day either side of it.
    private static func occurrence(of master: EKEvent, originalStart: String, _ store: EKEventStore) -> EKEvent? {
        let zone = master.timeZone ?? .current
        guard let target = parse(originalStart, zone: zone), let calendar = master.calendar else { return nil }
        let window = store.predicateForEvents(
            withStart: target.addingTimeInterval(-86_400), end: target.addingTimeInterval(2 * 86_400), calendars: [calendar]
        )
        let format = originalStart.count == 10 ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm:ss"
        let sameSeries = { (event: EKEvent) -> Bool in
            if let uid = master.calendarItemExternalIdentifier, !uid.isEmpty {
                return event.calendarItemExternalIdentifier == uid
            }
            return event.eventIdentifier == master.eventIdentifier
        }
        return store.events(matching: window).first { event in
            guard sameSeries(event) else { return false }
            let was = event.occurrenceDate ?? event.startDate ?? target
            return PhoneCalendar.civil(was, zone, format) == originalStart
        }
    }

    // MARK: Fields

    /// Write the fields the item states, and only those; a create states all of them.
    private static func apply(_ fields: Centraid_Core_V1_CalendarWriteFields, to event: EKEvent) throws {
        if fields.statesTitle { event.title = fields.title }
        if fields.statesNotes { event.notes = fields.notes.isEmpty ? nil : fields.notes }
        if fields.statesURL { event.url = fields.url.isEmpty ? nil : URL(string: fields.url) }
        if fields.statesWhen { try setWhen(fields, on: event) }
        if fields.statesBusy { event.availability = fields.busy ? .busy : .free }
        if fields.statesAlerts {
            event.alarms = fields.alerts.isEmpty
                ? nil
                : fields.alerts.map { EKAlarm(relativeOffset: -TimeInterval($0) * 60) }
        }
        if fields.statesRrule {
            if fields.rrule.isEmpty {
                event.recurrenceRules = nil
            } else if let rule = rule(from: fields.rrule) {
                event.recurrenceRules = [rule]
            } else {
                throw Failure(reason: "the repeat rule cannot be written")
            }
        }
    }

    /// All-day dates are floating days, the end the last day inclusive (written as that day's last
    /// second, which `PhoneCalendar` reads back as the same day); a timed event is a wall clock in
    /// `tz`, the end exclusive, and floating when `tz` is empty.
    private static func setWhen(_ fields: Centraid_Core_V1_CalendarWriteFields, on event: EKEvent) throws {
        event.isAllDay = fields.allDay
        if fields.allDay {
            guard let first = parse(fields.start, zone: .current), let last = parse(fields.end, zone: .current) else {
                throw Failure(reason: "the dates cannot be read")
            }
            event.timeZone = nil
            event.startDate = first
            event.endDate = last.addingTimeInterval(86_399)
        } else {
            let zone = fields.tz.isEmpty ? TimeZone.current : (TimeZone(identifier: fields.tz) ?? .current)
            guard let start = parse(fields.start, zone: zone), let end = parse(fields.end, zone: zone) else {
                throw Failure(reason: "the times cannot be read")
            }
            event.timeZone = fields.tz.isEmpty ? nil : zone
            event.startDate = start
            event.endDate = end
        }
    }

    /// The event's start and end in the read's form (an all-day end is the last day).
    private static func civilRange(_ event: EKEvent) -> (String, String) {
        guard let start = event.startDate, let end = event.endDate else { return ("", "") }
        let zone = event.timeZone ?? .current
        if event.isAllDay {
            return (
                PhoneCalendar.civil(start, zone, "yyyy-MM-dd"),
                PhoneCalendar.civil(max(end.addingTimeInterval(-1), start), zone, "yyyy-MM-dd")
            )
        }
        return (
            PhoneCalendar.civil(start, zone, "yyyy-MM-dd'T'HH:mm:ss"),
            PhoneCalendar.civil(end, zone, "yyyy-MM-dd'T'HH:mm:ss")
        )
    }

    /// `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS` as the instant it names on `zone`'s wall clock.
    private static func parse(_ text: String, zone: TimeZone) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = zone
        formatter.dateFormat = text.count == 10 ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm:ss"
        return formatter.date(from: text)
    }

    // MARK: The rule

    /// RFC 5545 rule text (no `RRULE:` prefix) as an `EKRecurrenceRule`: FREQ, INTERVAL, BYDAY (with
    /// an ordinal), BYMONTHDAY, BYMONTH, BYSETPOS, COUNT and UNTIL. nil when a part is not one of
    /// these or is not whole, so the write fails instead of writing a different rule.
    static func rule(from text: String) -> EKRecurrenceRule? {
        var parts: [String: String] = [:]
        for part in text.split(separator: ";") {
            let pair = part.split(separator: "=", maxSplits: 1).map(String.init)
            guard pair.count == 2 else { return nil }
            parts[pair[0].uppercased()] = pair[1]
        }
        let frequency: EKRecurrenceFrequency
        switch parts["FREQ"] {
        case "DAILY": frequency = .daily
        case "WEEKLY": frequency = .weekly
        case "MONTHLY": frequency = .monthly
        case "YEARLY": frequency = .yearly
        default: return nil
        }
        let known: Set<String> = ["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS", "COUNT", "UNTIL", "WKST"]
        guard Set(parts.keys).isSubset(of: known) else { return nil }
        let interval = parts["INTERVAL"].flatMap { Int($0) } ?? 1
        guard interval >= 1 else { return nil }
        var weekdays: [EKRecurrenceDayOfWeek]?
        if let by = parts["BYDAY"] {
            var days: [EKRecurrenceDayOfWeek] = []
            for token in by.split(separator: ",") {
                guard token.count >= 2, let day = weekday(String(token.suffix(2))) else { return nil }
                let ordinal = String(token.dropLast(2))
                if ordinal.isEmpty {
                    days.append(EKRecurrenceDayOfWeek(day))
                } else if let number = Int(ordinal) {
                    days.append(EKRecurrenceDayOfWeek(day, weekNumber: number))
                } else {
                    return nil
                }
            }
            weekdays = days
        }
        let numbers = { (key: String) -> [NSNumber]? in
            parts[key].map { $0.split(separator: ",").compactMap { Int($0) }.map { NSNumber(value: $0) } }
        }
        var end: EKRecurrenceEnd?
        if let count = parts["COUNT"].flatMap({ Int($0) }), count > 0 {
            end = EKRecurrenceEnd(occurrenceCount: count)
        } else if let until = parts["UNTIL"] {
            guard let date = untilDate(until) else { return nil }
            end = EKRecurrenceEnd(end: date)
        }
        return EKRecurrenceRule(
            recurrenceWith: frequency,
            interval: interval,
            daysOfTheWeek: weekdays,
            daysOfTheMonth: numbers("BYMONTHDAY"),
            monthsOfTheYear: numbers("BYMONTH"),
            weeksOfTheYear: nil,
            daysOfTheYear: nil,
            setPositions: numbers("BYSETPOS"),
            end: end
        )
    }

    private static func weekday(_ code: String) -> EKWeekday? {
        switch code.uppercased() {
        case "SU": return .sunday
        case "MO": return .monday
        case "TU": return .tuesday
        case "WE": return .wednesday
        case "TH": return .thursday
        case "FR": return .friday
        case "SA": return .saturday
        default: return nil
        }
    }

    /// `20261231`, `20261231T235959` or the same with a trailing `Z` (UTC).
    private static func untilDate(_ text: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        let utc = text.hasSuffix("Z")
        formatter.timeZone = utc ? TimeZone(identifier: "UTC") : .current
        let body = utc ? String(text.dropLast()) : text
        formatter.dateFormat = body.count == 8 ? "yyyyMMdd" : "yyyyMMdd'T'HHmmss"
        return formatter.date(from: body)
    }
}
