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

/// THE PHONE'S CALENDARS, read once the member tapped "Import calendar": a week
/// back to two months on, each occurrence of a series one event. iOS 17's full
/// access is asked at the tap, never at launch.
enum PhoneCalendar {
    enum Outcome {
        case denied
        case read([PhoneEvent])
    }

    static func read() async -> Outcome {
        let store = EKEventStore()
        let granted = (try? await store.requestFullAccessToEvents()) ?? false
        guard granted else { return .denied }
        return await Task.detached(priority: .userInitiated) { .read(events(store)) }.value
    }

    private static func events(_ store: EKEventStore) -> [PhoneEvent] {
        let day: TimeInterval = 86_400
        let now = Date()
        // ONLY CALENDARS THE MEMBER WRITES TO: a subscribed holiday calendar
        // is nobody's own events, and the Birthdays calendar would copy what
        // Contacts → People already brought in.
        let own = store.calendars(for: .event).filter(\.allowsContentModifications)
        guard !own.isEmpty else { return [] }
        let window = store.predicateForEvents(
            withStart: now.addingTimeInterval(-7 * day),
            end: now.addingTimeInterval(62 * day),
            calendars: own
        )
        return store.events(matching: window).compactMap { event in
            guard let start = event.startDate, let end = event.endDate else { return nil }
            let zone = event.timeZone ?? TimeZone.current
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
                    free: event.availability == .free
                )
            }
            return PhoneEvent(
                title: event.title ?? "",
                notes: event.notes ?? "",
                allDay: false,
                start: civil(start, zone, "yyyy-MM-dd'T'HH:mm:ss"),
                end: civil(end, zone, "yyyy-MM-dd'T'HH:mm:ss"),
                tz: event.timeZone?.identifier ?? "",
                free: event.availability == .free
            )
        }
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
