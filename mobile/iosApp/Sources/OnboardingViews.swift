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

/// THE PHONE'S ADDRESS BOOK. Read once the member taps "Import contacts" (the OS
/// asks its own permission then, never at launch), and again, with no prompt, by
/// the follower whenever the OS says the book changed and access is already
/// granted (#1127).
///
/// **One origin per `CNContainer`** (R-1127-10): an account, as iOS names it
/// ("iCloud", "Gmail"), so a whole account that leaves the phone is one question.
/// A contact is its UNIFIED contact, so `phoneId` is `local:` plus the unified
/// identifier; one linked across two containers is read once per container and
/// the shared `ContactsImport` keeps it under one origin. **A read is complete
/// unless access is limited (iOS 18) or a container would not read.**
enum PhoneContacts {
    enum Outcome {
        case denied
        case read(ContactsRead)
    }

    /// The tap: ask the OS, then read.
    static func read() async -> Outcome {
        let store = CNContactStore()
        let granted = (try? await store.requestAccess(for: .contacts)) ?? false
        guard granted else { return .denied }
        return await Task.detached(priority: .userInitiated) { .read(snapshot(store)) }.value
    }

    /// Access the member has already given, in full or in part. Never prompts.
    static var granted: Bool {
        let status = CNContactStore.authorizationStatus(for: .contacts)
        if #available(iOS 18.0, *), status == .limited { return true }
        return status == .authorized
    }

    /// The follower's read: nil when access is not already granted.
    static func readIfGranted() async -> ContactsRead? {
        guard granted else { return nil }
        let store = CNContactStore()
        return await Task.detached(priority: .utility) { snapshot(store) }.value
    }

    /// LIMITED ACCESS (iOS 18): the member shared only the contacts they
    /// picked, so asking again draws no prompt and reads only those. The
    /// import then offers iOS's own picker (`ContactAccessPicker`) to share
    /// more, and reads again.
    static var limited: Bool {
        if #available(iOS 18.0, *) {
            return CNContactStore.authorizationStatus(for: .contacts) == .limited
        }
        return false
    }

    /// Every container present (empty ones too, so one with no contact is not
    /// taken for gone) and the contacts in each.
    static func snapshot(_ store: CNContactStore) -> ContactsRead {
        var complete = !limited
        var containers: [CNContainer] = []
        do {
            containers = try store.containers(matching: nil)
        } catch {
            complete = false
        }
        var origins: [PhoneOriginRef] = []
        var found: [PhoneContact] = []
        for container in containers.sorted(by: { $0.identifier < $1.identifier }) {
            let origin = ContactsImport.shared.container(id: container.identifier, name: container.name)
            origins.append(origin)
            let predicate = CNContact.predicateForContactsInContainer(withIdentifier: container.identifier)
            if !enumerate(store, predicate: predicate, origin: origin, into: &found) { complete = false }
        }
        return ContactsRead(contacts: found, origins: origins, complete: complete)
    }

    /// False when the container would not read: the read is then incomplete.
    private static func enumerate(
        _ store: CNContactStore,
        predicate: NSPredicate,
        origin: PhoneOriginRef,
        into found: inout [PhoneContact]
    ) -> Bool {
        let keys: [CNKeyDescriptor] = [
            CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
            CNContactBirthdayKey as CNKeyDescriptor,
        ]
        let request = CNContactFetchRequest(keysToFetch: keys)
        request.predicate = predicate
        do {
            try store.enumerateContacts(with: request) { contact, _ in
                let name = CNContactFormatter.string(from: contact, style: .fullName) ?? contact.organizationName
                found.append(
                    PhoneContact(
                        name: name,
                        phones: contact.phoneNumbers.map { $0.value.stringValue },
                        emails: contact.emailAddresses.map { $0.value as String },
                        birthday: monthDay(contact.birthday),
                        // R-1127-10: the unified identifier means something on this device only.
                        phoneId: "local:" + contact.identifier,
                        origin: origin.id,
                        originLabel: origin.label
                    )
                )
            }
            return true
        } catch {
            return false
        }
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
    /// EventKit posts `EKEventStoreChanged` only for a store that exists, so one
    /// is held for the life of the process. Making it asks for nothing.
    static let watcher = EKEventStore()

    enum Outcome {
        case denied
        case read(CalendarRead)
    }

    /// The tap: ask the OS for full access, then read.
    static func read() async -> Outcome {
        let store = EKEventStore()
        let granted = (try? await store.requestFullAccessToEvents()) ?? false
        guard granted else { return .denied }
        return await Task.detached(priority: .userInitiated) { .read(snapshot(store)) }.value
    }

    /// Full access the member has already given. Never prompts.
    static var granted: Bool {
        EKEventStore.authorizationStatus(for: .event) == .fullAccess
    }

    /// The follower's read: nil when full access is not already granted.
    static func readIfGranted() async -> CalendarRead? {
        guard granted else { return nil }
        let store = EKEventStore()
        return await Task.detached(priority: .utility) { snapshot(store) }.value
    }

    /// **Complete only with full access** (R-1127-10), which is the only access this reads under.
    static func snapshot(_ store: EKEventStore) -> CalendarRead {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        // ONLY CALENDARS THE MEMBER WRITES TO: a subscribed holiday calendar
        // is nobody's own events, and the Birthdays calendar would copy what
        // Contacts → People already brought in. Each is an origin, empty or not.
        let own = store.calendars(for: .event)
            .filter(\.allowsContentModifications)
            .sorted { $0.calendarIdentifier < $1.calendarIdentifier }
        let origins = own.map(origin)
        return CalendarRead(
            events: events(store, own, now),
            origins: origins,
            complete: granted,
            deviceTz: TimeZone.current.identifier,
            now: now
        )
    }

    /// `calendar:<identifier>`, labelled "{source}: {calendar}" by the shared importer.
    private static func origin(_ calendar: EKCalendar) -> PhoneOriginRef {
        CalendarImport.shared.calendar(
            id: calendar.calendarIdentifier,
            sourceTitle: calendar.source?.title ?? "",
            calendarTitle: calendar.title
        )
    }

    /// `uid:` plus the iCal UID the provider fills, else `local:` plus an id that means something on this device only.
    private static func phoneId(_ item: EKCalendarItem, fallback: String) -> String {
        if let uid = item.calendarItemExternalIdentifier, !uid.isEmpty { return "uid:" + uid }
        return "local:" + fallback
    }

    private static func events(_ store: EKEventStore, _ own: [EKCalendar], _ now: Int64) -> [PhoneEvent] {
        let window = CalendarImport.shared
        guard !own.isEmpty else { return [] }
        let predicate = store.predicateForEvents(
            withStart: Date(timeIntervalSince1970: TimeInterval(window.windowStart(now: now)) / 1000),
            end: Date(timeIntervalSince1970: TimeInterval(window.windowEnd(now: now)) / 1000),
            calendars: own
        )
        var masters: [String: Master?] = [:]
        // Read in calendar order, so an invitation held by two calendars is kept under the same one every pass.
        let found = store.events(matching: predicate)
            .sorted { ($0.calendar?.calendarIdentifier ?? "") < ($1.calendar?.calendarIdentifier ?? "") }
        return found.compactMap { (event: EKEvent) -> PhoneEvent? in
            guard let start = event.startDate, let end = event.endDate else { return nil }
            let calendar = event.calendar.map(origin)
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
                    phoneId: phoneId(event, fallback: event.eventIdentifier ?? event.calendarItemIdentifier),
                    origin: calendar?.id ?? "",
                    originLabel: calendar?.label ?? ""
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
                phoneId: phoneId(event, fallback: event.eventIdentifier ?? event.calendarItemIdentifier),
                origin: calendar?.id ?? "",
                originLabel: calendar?.label ?? ""
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
                    id: phoneId(first, fallback: id),
                    rrule: rrule(rules[0]),
                    start: civil(start, zone, "yyyy-MM-dd"),
                    end: civil(max(end.addingTimeInterval(-1), start), zone, "yyyy-MM-dd")
                )
            } else {
                series = PhoneSeries(
                    id: phoneId(first, fallback: id),
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

/// THE FOLLOWER'S ADDRESS-BOOK READER (#1127): read off the main thread, only
/// over access the member already gave. nil is "not granted", and the pass ends.
final class ContactsFollowReader: NSObject, ContactsReader {
    // (Kotlin/Native gives this protocol's parameter a trailing underscore; CalendarReader's has none.)
    func read(deliver_: @escaping (ContactsRead?) -> Void) {
        Task.detached(priority: .utility) { deliver_(await PhoneContacts.readIfGranted()) }
    }
}

/// THE FOLLOWER'S CALENDAR READER, the same over full calendar access.
final class CalendarFollowReader: NSObject, CalendarReader {
    func read(deliver: @escaping (CalendarRead?) -> Void) {
        Task.detached(priority: .utility) { deliver(await PhoneCalendar.readIfGranted()) }
    }
}

/// THE QUESTION A HELD ACCOUNT OR CALENDAR LEAVES (R-1127-9), in the kit's
/// `ConfirmSheet` (DESIGN.md: a destructive confirm is never an alert). The
/// shared question chose every word and built the confirm: Move to trash is
/// its destructive verb, and KEEP, THE DEFAULT, is the sheet's cancel and what
/// a swipe away means.
struct PhoneFollowQuestionHost: ViewModifier {
    @ObservedObject var shell: ShellModel

    /// One sheet per question: a second question is a new sheet, not the first one's words swapped.
    private struct Asked: Identifiable {
        let question: PhoneFollowQuestion
        var id: String { question.originId }
    }

    func body(content: Content) -> some View {
        content.sheet(item: Binding(
            get: { shell.followQuestion.map(Asked.init) },
            set: { if $0 == nil, shell.followQuestion != nil { shell.answerFollowQuestion(keep: true) } }
        )) { asked in
            ConfirmSheet(
                (try? Centraid_Screen_V1_Confirm(serializedBytes: asked.question.confirmBytes.data)) ?? .init(),
                cancelLabel: asked.question.keepLabel,
                onConfirm: { shell.answerFollowQuestion(keep: false) },
                onDismiss: { shell.answerFollowQuestion(keep: true) }
            )
        }
    }
}
