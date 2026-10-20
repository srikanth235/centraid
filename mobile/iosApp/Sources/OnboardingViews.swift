import Contacts
import ContactsUI
import EventKit
import SwiftUI

import CentraidShared

// ONBOARDING WITHOUT SAMPLE DATA (docs/decisions.md, "Onboarding without sample
// data"): where the phone already holds an app's data, its day-one empty state
// offers a one-tap import asked at the point of use. These are the shell's
// halves: the environment door the kit's `EmptyStateView` reads, the banner the
// import draws, and the address-book read.

private struct ImportFromPhoneKey: EnvironmentKey {
    static let defaultValue: ((Centraid_Screen_V1_ImportSource) -> Void)? = nil
}

extension EnvironmentValues {
    /// An import from where the phone already holds the data, or nil.
    var importFromPhone: ((Centraid_Screen_V1_ImportSource) -> Void)? {
        get { self[ImportFromPhoneKey.self] }
        set { self[ImportFromPhoneKey.self] = newValue }
    }
}

/// THE IMPORT'S STATUS LINE (DESIGN.md: "`StatusLine` is the one feedback
/// channel … docked to the bottom of the frame … no floating overlay, no
/// auto-dismiss"): an import's progress and outcome, above the band, on Home
/// and on every app. One fragment, at most one action ("Open People", which
/// takes the member to what came in), and a close key once the work is done.
/// It never clears on a timer: the close key, the action or the member's next
/// move puts it away (`ShellModel.importLineMoved`).
struct ShellBanner: View {
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            if !shell.importNotice.isEmpty {
                VStack(spacing: 0) {
                    KitHairline()
                    ProgressStatusLine(
                        sentence: shell.importNotice,
                        actionLabel: shell.importing ? "" : PhoneImport.shared.openLabel(app: shell.importOpens),
                        onAct: { shell.openImported() },
                        closeLabel: shell.importing ? "" : KitWords.shared.DISMISS,
                        onClose: { shell.dismissImportNotice() },
                        identifier: "import"
                    )
                }
                .background(Theme.color("bg", scheme))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("import-banner")
                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            }
        }
        // ENTRY AND SETTLE AT 280MS, a change of words at 140 (DESIGN.md's one motion grammar).
        .animation(reduceMotion ? nil : .easeOut(duration: 0.28), value: shell.importNotice.isEmpty)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: shell.importNotice)
    }
}

/// THE IMPORT LINE ON A PUSHED PAGE: handed to `AppPlace`, which draws it above
/// its band; a page with no `AppPlace` (a row's page, an editor) gets it docked
/// at its own foot instead, so it is in the same place everywhere.
struct ShellLineHost: ViewModifier {
    @ObservedObject var shell: ShellModel
    @State private var placeDraws = false

    func body(content: Content) -> some View {
        content
            .environment(\.shellStatusLine, AnyView(ShellBanner(shell: shell)))
            .onPreferenceChange(PlaceDrawsShellLine.self) { placeDraws = $0 }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !placeDraws { ShellBanner(shell: shell) }
            }
    }
}

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

    /// LIMITED ACCESS (iOS 18): the member shared only the contacts they
    /// picked, so asking again draws no prompt and reads only those. The
    /// import then offers iOS's own picker (`ContactAccessPicker`) to share
    /// more, and imports what it hands back ([read(identifiers:)]).
    static var limited: Bool {
        if #available(iOS 18.0, *) {
            return CNContactStore.authorizationStatus(for: .contacts) == .limited
        }
        return false
    }

    /// The contacts the picker just shared, by identifier.
    static func read(identifiers: [String]) async -> [PhoneContact] {
        guard !identifiers.isEmpty else { return [] }
        let store = CNContactStore()
        return await Task.detached(priority: .userInitiated) {
            enumerate(store, predicate: CNContact.predicateForContacts(withIdentifiers: identifiers))
        }.value
    }

    private static func enumerate(_ store: CNContactStore, predicate: NSPredicate? = nil) -> [PhoneContact] {
        let keys: [CNKeyDescriptor] = [
            CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
            CNContactBirthdayKey as CNKeyDescriptor,
        ]
        var found: [PhoneContact] = []
        let request = CNContactFetchRequest(keysToFetch: keys)
        request.predicate = predicate
        try? store.enumerateContacts(with: request) { contact, _ in
            let name = CNContactFormatter.string(from: contact, style: .fullName) ?? contact.organizationName
            found.append(
                PhoneContact(
                    name: name,
                    phones: contact.phoneNumbers.map { $0.value.stringValue },
                    emails: contact.emailAddresses.map { $0.value as String },
                    birthday: monthDay(contact.birthday),
                    // R-1127-10: a device-scoped id says so; lane C swaps in the best the OS has.
                    phoneId: "local:" + contact.identifier,
                    origin: "",
                    originLabel: ""
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
                    moved: master != nil && event.isDetached,
                    phoneId: "local:" + (event.eventIdentifier ?? event.calendarItemIdentifier),
                    origin: "",
                    originLabel: ""
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
                moved: master != nil && event.isDetached,
                phoneId: "local:" + (event.eventIdentifier ?? event.calendarItemIdentifier),
                origin: "",
                originLabel: ""
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
                    id: "local:" + id,
                    rrule: rrule(rules[0]),
                    start: civil(start, zone, "yyyy-MM-dd"),
                    end: civil(max(end.addingTimeInterval(-1), start), zone, "yyyy-MM-dd")
                )
            } else {
                series = PhoneSeries(
                    id: "local:" + id,
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

/// IOS'S OWN CONTACT PICKER (`ContactAccessPicker`, iOS 18), raised when People's
/// import meets limited access: the member shares more contacts in the
/// system's sheet, and the identifiers it hands back are imported. Before
/// iOS 18 there is no limited access, so there is nothing to raise.
struct ContactAccessPickerHost: ViewModifier {
    @ObservedObject var shell: ShellModel

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.contactAccessPicker(isPresented: $shell.contactAccessPickerShown) { identifiers in
                shell.contactsShared(identifiers)
            }
        } else {
            content
        }
    }
}
