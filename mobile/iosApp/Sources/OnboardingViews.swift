import Contacts
import EventKit
import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

// ONBOARDING WITHOUT SAMPLE DATA (docs/decisions.md, "Onboarding without sample
// data"): an app's day-one empty state offers "See an example" — a read-only
// preview over an ephemeral example core — and, where the phone already holds
// the data, a one-tap import asked at the point of use. These are the shell's
// halves: the two environment doors the kit's `EmptyStateView` reads, the one
// banner the preview and the import draw, and the address-book read.

private struct SeeExampleKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

private struct ImportFromPhoneKey: EnvironmentKey {
    static let defaultValue: ((Centraid_Screen_V1_ImportSource) -> Void)? = nil
}

extension EnvironmentValues {
    /// "See an example", or nil — and nil while a preview is open, so an empty
    /// state inside the example offers nothing.
    var seeExample: (() -> Void)? {
        get { self[SeeExampleKey.self] }
        set { self[SeeExampleKey.self] = newValue }
    }

    /// An import from where the phone already holds the data, or nil.
    var importFromPhone: ((Centraid_Screen_V1_ImportSource) -> Void)? {
        get { self[ImportFromPhoneKey.self] }
        set { self[ImportFromPhoneKey.self] = newValue }
    }
}

/// "SEE AN EXAMPLE": a quiet link under an app's day-one empty state — never a
/// second button, so the empty state keeps its one action. Draws nothing where
/// the shell offers no example (and inside one).
struct SeeExampleLink: View {
    @Environment(\.seeExample) private var seeExample
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if let seeExample {
            Button(action: seeExample) {
                Text(ShellWords.seeExample)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color("link", scheme))
                    .frame(minHeight: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("kit-empty-example")
        }
    }
}

/// THE SHELL'S BANNER (DESIGN.md's Banner recipe: one sentence, plus one
/// action): "Example — not your data" with its one exit while a preview is
/// open, else the contacts import's progress and outcome. Never both — the
/// preview has no empty state to import from.
struct ShellBanner: View {
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if shell.previewing {
            line(ShellWords.exampleBanner, action: ShellWords.exampleDone, identifier: "example") {
                shell.leaveExample()
            }
        } else if !shell.importNotice.isEmpty {
            line(
                shell.importNotice,
                action: shell.importing ? "" : ShellWords.exampleDone,
                identifier: "import"
            ) { shell.dismissImportNotice() }
        }
    }

    private func line(
        _ sentence: String,
        action: String,
        identifier: String,
        act: @escaping () -> Void
    ) -> some View {
        HStack(spacing: 12) {
            Text(sentence)
                .centraidType("smallStrong")
                .foregroundStyle(Theme.color("text", scheme))
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("\(identifier)-banner-text")
            if !action.isEmpty {
                KitOutlineButton(label: action, action: act)
                    .accessibilityIdentifier("\(identifier)-done")
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .background(Theme.color("bgSunken", scheme))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("\(identifier)-banner")
    }
}

#if canImport(CentraidShared)
/// THE PHONE'S ADDRESS BOOK, read once the member tapped "Import contacts".
/// The OS asks its own permission here — the first time, and never at launch —
/// and a limited grant reads the contacts the member chose.
enum PhoneContacts {
    enum Outcome {
        case denied
        case read([PhoneContact])
    }

    static func read() async -> Outcome {
        let store = CNContactStore()
        let granted = (try? await store.requestAccess(for: .contacts)) ?? false
        guard granted else { return .denied }
        return await Task.detached(priority: .userInitiated) { .read(enumerate(store)) }.value
    }

    private static func enumerate(_ store: CNContactStore) -> [PhoneContact] {
        let keys: [CNKeyDescriptor] = [
            CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
            CNContactBirthdayKey as CNKeyDescriptor,
        ]
        var found: [PhoneContact] = []
        let request = CNContactFetchRequest(keysToFetch: keys)
        try? store.enumerateContacts(with: request) { contact, _ in
            let name = CNContactFormatter.string(from: contact, style: .fullName) ?? contact.organizationName
            found.append(
                PhoneContact(
                    name: name,
                    phones: contact.phoneNumbers.map { $0.value.stringValue },
                    emails: contact.emailAddresses.map { $0.value as String },
                    birthday: monthDay(contact.birthday)
                )
            )
        }
        return found
    }

    /// `MM-DD`, or empty: a People important date is a day of the year.
    private static func monthDay(_ birthday: DateComponents?) -> String {
        guard let month = birthday?.month, let day = birthday?.day else { return "" }
        return String(format: "%02d-%02d", month, day)
    }
}

/// THE PHONE'S CALENDARS, read once the member tapped "Import calendar": every
/// occurrence in `CalendarImport`'s window one event, an occurrence of a series
/// carrying its series — the master's rule and its own first occurrence — so
/// the shared importer folds it back into one repeating event. A cancelled
/// occurrence is not in EventKit's answer, which is how the importer knows to
/// skip it. iOS 17's full access is asked at the tap, never at launch.
enum PhoneCalendar {
    enum Outcome {
        case denied
        case read([PhoneEvent], now: Int64)
    }

    static func read() async -> Outcome {
        let store = EKEventStore()
        let granted = (try? await store.requestFullAccessToEvents()) ?? false
        guard granted else { return .denied }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return await Task.detached(priority: .userInitiated) { .read(events(store, now), now: now) }.value
    }

    private static func events(_ store: EKEventStore, _ now: Int64) -> [PhoneEvent] {
        let window = CalendarImport.shared
        // ONLY CALENDARS THE MEMBER WRITES TO: a subscribed holiday calendar
        // is nobody's own events, and the Birthdays calendar would copy what
        // Contacts → People already brought in.
        let own = store.calendars(for: .event).filter(\.allowsContentModifications)
        guard !own.isEmpty else { return [] }
        let predicate = store.predicateForEvents(
            withStart: Date(timeIntervalSince1970: TimeInterval(window.windowStart(now: now)) / 1000),
            end: Date(timeIntervalSince1970: TimeInterval(window.windowEnd(now: now)) / 1000),
            calendars: own
        )
        var masters: [String: Master?] = [:]
        return store.events(matching: predicate).compactMap { (event: EKEvent) -> PhoneEvent? in
            guard let start = event.startDate, let end = event.endDate else { return nil }
            let zone = event.timeZone ?? TimeZone.current
            let master = (event.hasRecurrenceRules || event.isDetached)
                ? lookup(seriesKey(event), store, &masters) : nil
            // WHERE THE RULE PUT A MOVED ONE, read in the SERIES' zone — the
            // one the vault keys its occurrences in.
            let original = event.isDetached ? event.occurrenceDate : nil
            if event.isAllDay {
                // EventKit ends an all-day event at the next midnight (or
                // 23:59:59); Agenda's all-day end is the LAST day, inclusive.
                let last = end.addingTimeInterval(-1)
                return PhoneEvent(
                    title: event.title ?? "",
                    notes: event.notes ?? "",
                    allDay: true,
                    start: civil(start, zone, "yyyy-MM-dd"),
                    end: civil(max(last, start), zone, "yyyy-MM-dd"),
                    tz: "",
                    free: event.availability == .free,
                    series: master?.series,
                    originalStart: master.flatMap { m in original.map { civil($0, m.zone, "yyyy-MM-dd") } } ?? "",
                    moved: master != nil && event.isDetached
                )
            }
            return PhoneEvent(
                title: event.title ?? "",
                notes: event.notes ?? "",
                allDay: false,
                start: civil(start, zone, "yyyy-MM-dd'T'HH:mm:ss"),
                end: civil(end, zone, "yyyy-MM-dd'T'HH:mm:ss"),
                tz: event.timeZone?.identifier ?? "",
                free: event.availability == .free,
                series: master?.series,
                originalStart: master.flatMap { m in original.map { civil($0, m.zone, "yyyy-MM-dd'T'HH:mm:ss") } } ?? "",
                moved: master != nil && event.isDetached
            )
        }
    }

    /// A series' master, and the zone its wall clocks are read in.
    private struct Master {
        let series: PhoneSeries
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
            let series: PhoneSeries
            if first.isAllDay {
                series = PhoneSeries(
                    id: id,
                    rrule: rrule(rules[0]),
                    start: civil(start, zone, "yyyy-MM-dd"),
                    end: civil(max(end.addingTimeInterval(-1), start), zone, "yyyy-MM-dd")
                )
            } else {
                series = PhoneSeries(
                    id: id,
                    rrule: rrule(rules[0]),
                    start: civil(start, zone, "yyyy-MM-dd'T'HH:mm:ss"),
                    end: civil(end, zone, "yyyy-MM-dd'T'HH:mm:ss")
                )
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

/// THE PHONE'S OPEN REMINDERS, read once the member tapped "Import reminders".
enum PhoneReminders {
    enum Outcome {
        case denied
        case read([PhoneReminder])
    }

    static func read() async -> Outcome {
        let store = EKEventStore()
        let granted = (try? await store.requestFullAccessToReminders()) ?? false
        guard granted else { return .denied }
        let predicate = store.predicateForIncompleteReminders(
            withDueDateStarting: nil, ending: nil, calendars: nil
        )
        let found: [EKReminder] = await withCheckedContinuation { done in
            store.fetchReminders(matching: predicate) { done.resume(returning: $0 ?? []) }
        }
        return .read(found.map { reminder in
            PhoneReminder(
                title: reminder.title ?? "",
                notes: reminder.notes ?? "",
                due: dueDay(reminder.dueDateComponents)
            )
        })
    }

    /// `YYYY-MM-DD`, or empty: a task's due is a day.
    private static func dueDay(_ due: DateComponents?) -> String {
        guard let year = due?.year, let month = due?.month, let day = due?.day else { return "" }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }
}
#endif
