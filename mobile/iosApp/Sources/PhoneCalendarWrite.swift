import EventKit
import Foundation

/// Executes the core's field plan against EventKit. Re-read before every write;
/// a changed source is returned as a conflict for the next three-way merge.
enum PhoneCalendarWrite {
    static func perform(_ request: Centraid_Core_V1_CalendarWrite) async -> Centraid_Core_V1_EffectResult.OneOf_Outcome {
        guard PhoneCalendar.granted else {
            return .failed(.with { $0.denied = true; $0.reason = "calendar access not given" })
        }
        return await Task.detached(priority: .utility) {
            let store = EKEventStore()
            var answer = Centraid_Core_V1_CalendarWritten()
            for change in request.changes {
                do {
                    let event: EKEvent
                    if change.hasExpected {
                        guard let found = find(change, store: store),
                              matches(found, change: change) else { answer.conflicted += 1; continue }
                        event = found
                    } else {
                        guard let calendar = store.calendar(withIdentifier: change.calendarKey), calendar.allowsContentModifications else {
                            answer.refused += 1; continue
                        }
                        event = EKEvent(eventStore: store)
                        event.calendar = calendar
                    }
                    if change.deleted {
                        try store.remove(event, span: change.originalStart.isEmpty ? .futureEvents : .thisEvent, commit: true)
                        answer.applied += 1
                        continue
                    }
                    let desired = change.desired
                    var fields = change.fields
                    // EventKit exposes attendees for reading only. Other edits
                    // can still save; Rust acknowledges exactly these fields.
                    if fields.contains("attendees") {
                        fields.removeAll { $0 == "attendees" }
                        answer.refused += 1
                        answer.unsupportedFields.append("attendees")
                    }
                    if fields.isEmpty { continue }
                    if fields.contains("title") { event.title = desired.title }
                    if fields.contains("description") { event.notes = desired.notes.isEmpty ? nil : desired.notes }
                    if fields.contains("url") { event.url = desired.url.isEmpty ? nil : URL(string: desired.url) }
                    if fields.contains("location") { event.location = desired.location.isEmpty ? nil : desired.location }
                    if fields.contains("busy") { event.availability = desired.free ? .free : .busy }
                    if fields.contains(where: { ["starts", "ends", "timing", "zone"].contains($0) }) || !change.hasExpected {
                        guard let start = date(desired.start, day: desired.allDay, zone: desired.tz),
                              let end = date(desired.end, day: desired.allDay, zone: desired.tz, inclusiveEnd: desired.allDay) else {
                            answer.refused += 1; continue
                        }
                        event.isAllDay = desired.allDay
                        event.timeZone = desired.tz.isEmpty ? nil : TimeZone(identifier: desired.tz)
                        event.startDate = start
                        event.endDate = end
                    }
                    if fields.contains("reminders") {
                        let locationAlarms = (event.alarms ?? []).filter { $0.structuredLocation != nil }
                        event.alarms = locationAlarms + desired.alarmsBeforeMin.map { EKAlarm(relativeOffset: -Double($0) * 60) }
                    }
                    if fields.contains("rule") {
                        if change.rule.isEmpty { event.recurrenceRules = nil }
                        else if let rule = recurrence(change.rule) { event.recurrenceRules = [rule] }
                        else { answer.refused += 1; answer.unsupportedFields.append("rule"); continue }
                    }
                    try store.save(event, span: change.originalStart.isEmpty ? .futureEvents : .thisEvent, commit: true)
                    answer.applied += 1
                    let external = event.calendarItemExternalIdentifier ?? ""
                    answer.receipts.append(.with {
                        $0.entityID = change.entityID
                        $0.phoneID = external.isEmpty ? "local:" + (event.eventIdentifier ?? event.calendarItemIdentifier) : "uid:" + external
                        $0.fields = fields
                        $0.originalStart = change.originalStart
                    })
                } catch { answer.refused += 1 }
            }
            return .calendarWritten(answer)
        }.value
    }

    private static func find(_ change: Centraid_Core_V1_CalendarMutation, store: EKEventStore) -> EKEvent? {
        if change.originalStart.isEmpty { return store.event(withIdentifier: change.nativeID) }
        let expected = change.expected
        guard let calendar = store.calendar(withIdentifier: change.calendarKey),
              let start = date(expected.start, day: expected.allDay, zone: expected.tz),
              let original = date(change.originalStart, day: expected.series.start.count == 10, zone: expected.series.tz) else { return nil }
        // event(withIdentifier:) returns a series' first occurrence. A concrete
        // occurrence is resolved through the window and checked by original date.
        let predicate = store.predicateForEvents(withStart: start.addingTimeInterval(-1), end: start.addingTimeInterval(86_400), calendars: [calendar])
        return store.events(matching: predicate).first { event in
            let identifier = event.eventIdentifier ?? ""
            let master = identifier.range(of: "/RID=").map { String(identifier[..<$0.lowerBound]) } ?? identifier
            return master == expected.nativeSeriesID && event.startDate == start
                && (event.isDetached ? event.occurrenceDate == original : event.startDate == original)
        }
    }

    static func date(_ value: String, day: Bool, zone: String, inclusiveEnd: Bool = false) -> Date? {
        guard let timeZone = zone.isEmpty ? TimeZone.current : TimeZone(identifier: zone) else { return nil }
        let pieces = value.split(separator: ".", omittingEmptySubsequences: false)
        guard pieces.count <= 2 else { return nil }
        let base = String(pieces[0])
        let fraction: Double
        if pieces.count == 2 {
            guard !day, !pieces[1].isEmpty, pieces[1].allSatisfy({ $0.isASCII && $0.isNumber }),
                  let parsed = Double("0." + String(pieces[1])) else { return nil }
            fraction = parsed
        } else { fraction = 0 }
        let pattern: String
        if day { guard base.count == 10 else { return nil }; pattern = "yyyy-MM-dd" }
        else if base.count == 16 { pattern = "yyyy-MM-dd'T'HH:mm" }
        else if base.count == 19 { pattern = "yyyy-MM-dd'T'HH:mm:ss" }
        else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone
        formatter.isLenient = false
        formatter.dateFormat = pattern
        guard var found = formatter.date(from: base), formatter.string(from: found) == base else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        if !day {
            let components = calendar.dateComponents([.hour, .minute, .second], from: found)
            guard let first = calendar.nextDate(after: calendar.startOfDay(for: found).addingTimeInterval(-1), matching: components,
                                               matchingPolicy: .strict, repeatedTimePolicy: .first),
                  formatter.string(from: first) == base else { return nil }
            found = first.addingTimeInterval(fraction)
        }
        if !inclusiveEnd { return found }
        return calendar.date(byAdding: .day, value: 1, to: found)
    }

    private static func matches(_ event: EKEvent, change: Centraid_Core_V1_CalendarMutation) -> Bool {
        let expected = change.expected
        var fields = change.deleted ? ["title", "description", "starts", "ends", "timing", "zone", "url", "busy", "rule", "reminders", "attendees", "location"] : change.fields
        if !change.originalStart.isEmpty { fields.removeAll { $0 == "rule" } }
        if event.calendar.calendarIdentifier != change.calendarKey { return false }
        for field in fields {
            switch field {
            case "title": if (event.title ?? "") != expected.title { return false }
            case "description": if (event.notes ?? "") != expected.notes { return false }
            case "url": if (event.url?.absoluteString ?? "") != expected.url { return false }
            case "location": if (event.location ?? "") != expected.location { return false }
            case "busy": if (event.availability == .free) != expected.free { return false }
            case "rule": if (event.recurrenceRules?.first.map(PhoneCalendar.rrule) ?? "") != change.expectedRule { return false }
            case "starts", "ends", "timing", "zone":
                if event.isAllDay != expected.allDay
                    || event.startDate != date(expected.start, day: expected.allDay, zone: expected.tz)
                    || event.endDate != date(expected.end, day: expected.allDay, zone: expected.tz, inclusiveEnd: expected.allDay) { return false }
            case "reminders":
                let held = (event.alarms ?? []).filter { $0.structuredLocation == nil }.compactMap { alarm -> Int32? in
                    let seconds = alarm.absoluteDate.map { event.startDate.timeIntervalSince($0) } ?? -alarm.relativeOffset
                    return Int32(exactly: (seconds / 60).rounded())
                }.sorted()
                if held != expected.alarmsBeforeMin.sorted() { return false }
            case "attendees":
                let held = (event.attendees ?? []).map { guest in
                    let email = guest.url.absoluteString.replacingOccurrences(of: "mailto:", with: "").lowercased()
                    let state: String
                    switch guest.participantStatus {
                    case .accepted: state = "accepted"
                    case .declined: state = "declined"
                    case .tentative: state = "tentative"
                    default: state = "needs-action"
                    }
                    return email + "\n" + (guest.name ?? email) + "\n" + state
                }.sorted()
                let before = expected.attendees.map { $0.email.lowercased() + "\n" + $0.name + "\n" + $0.state }.sorted()
                if held != before { return false }
            default: break
            }
        }
        return true
    }

    /// EventKit's public recurrence initializer, with no unsupported part dropped.
    static func recurrence(_ value: String) -> EKRecurrenceRule? {
        var fields: [String: String] = [:]
        for part in value.split(separator: ";", omittingEmptySubsequences: false) {
            let pair = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard pair.count == 2, !pair[1].isEmpty, fields[String(pair[0])] == nil else { return nil }
            fields[String(pair[0])] = String(pair[1])
        }
        let supported: Set<String> = ["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYWEEKNO", "BYYEARDAY", "BYSETPOS", "COUNT", "UNTIL"]
        guard fields.keys.allSatisfy(supported.contains) else { return nil }
        let frequency: EKRecurrenceFrequency
        switch fields["FREQ"] { case "DAILY": frequency = .daily; case "WEEKLY": frequency = .weekly; case "MONTHLY": frequency = .monthly; case "YEARLY": frequency = .yearly; default: return nil }
        var numbers: [String: [NSNumber]] = [:]
        for (key, limit) in [("BYMONTHDAY", 31), ("BYMONTH", 12), ("BYWEEKNO", 53), ("BYYEARDAY", 366), ("BYSETPOS", 366)] {
            if let list = fields[key] {
                var values: [NSNumber] = []
                for value in list.split(separator: ",", omittingEmptySubsequences: false) {
                    guard let number = Int(value), number != 0, number >= (key == "BYMONTH" ? 1 : -limit), number <= limit else { return nil }
                    values.append(NSNumber(value: number))
                }
                numbers[key] = values
            }
        }
        var weekdays: [EKRecurrenceDayOfWeek]?
        if let days = fields["BYDAY"] {
            let names = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
            weekdays = []
            for day in days.split(separator: ",", omittingEmptySubsequences: false) {
                guard let index = names.firstIndex(of: String(day.suffix(2))), let weekday = EKWeekday(rawValue: index + 1) else { return nil }
                let ordinal = day.dropLast(2)
                guard let week = ordinal.isEmpty ? 0 : Int(ordinal), (-53...53).contains(week), ordinal.isEmpty || week != 0 else { return nil }
                weekdays?.append(EKRecurrenceDayOfWeek(weekday, weekNumber: week))
            }
        }
        var end: EKRecurrenceEnd?
        if let raw = fields["COUNT"] {
            guard let count = Int(raw), count > 0, fields["UNTIL"] == nil else { return nil }
            end = EKRecurrenceEnd(occurrenceCount: count)
        }
        if let until = fields["UNTIL"] {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.isLenient = false
            formatter.dateFormat = until.count == 8 ? "yyyyMMdd" : "yyyyMMdd'T'HHmmss'Z'"
            guard let date = formatter.date(from: until), formatter.string(from: date) == until else { return nil }
            end = EKRecurrenceEnd(end: date)
        }
        guard let interval = fields["INTERVAL"].map({ Int($0) }) ?? 1, interval > 0 else { return nil }
        return EKRecurrenceRule(recurrenceWith: frequency, interval: interval, daysOfTheWeek: weekdays, daysOfTheMonth: numbers["BYMONTHDAY"], monthsOfTheYear: numbers["BYMONTH"], weeksOfTheYear: numbers["BYWEEKNO"], daysOfTheYear: numbers["BYYEARDAY"], setPositions: numbers["BYSETPOS"], end: end)
    }
}
