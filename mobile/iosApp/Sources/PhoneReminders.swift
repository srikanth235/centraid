import EventKit
import Foundation

/// EventKit data only: Rust converts priorities, merges source identities and
/// decides what the import means. Completed reminders are an explicit option.
enum PhoneReminders {
    static func snapshot(_ read: Centraid_Core_V1_RemindersRead) async -> Centraid_Core_V1_EffectResult.OneOf_Outcome {
        let store = EKEventStore()
        if read.askPermission {
            guard (try? await store.requestFullAccessToReminders()) ?? false else { return .failed(denied()) }
        } else if EKEventStore.authorizationStatus(for: .reminder) != .fullAccess {
            return .failed(denied())
        }
        let predicate = read.includeCompleted
            ? store.predicateForReminders(in: nil)
            : store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        let reminders: [Centraid_Core_V1_PhoneReminder] = await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { found in
                // EventKit retains its model objects. Read them on the callback's
                // executor and transfer only immutable protobuf values.
                let reminders = (found ?? []).filter { read.includeCompleted || !$0.isCompleted }.map { reminder in
                    var phone = Centraid_Core_V1_PhoneReminder()
                    phone.title = reminder.title ?? ""
                    phone.notes = reminder.notes ?? ""
                    phone.due = day(of: reminder.dueDateComponents)
                    let components = reminder.dueDateComponents
                    if let hour = components?.hour, let minute = components?.minute {
                        phone.time = String(format: "%02d:%02d:%02d", hour, minute, components?.second ?? 0)
                    }
                    phone.zone = components?.timeZone?.identifier ?? TimeZone.current.identifier
                    let external = reminder.calendarItemExternalIdentifier ?? ""
                    phone.phoneID = external.isEmpty ? "local:" + reminder.calendarItemIdentifier : "uid:" + external
                    phone.listKey = reminder.calendar.calendarIdentifier
                    phone.listTitle = reminder.calendar.title
                    phone.priority = UInt32(max(0, reminder.priority))
                    phone.rule = reminder.recurrenceRules?.first.map(PhoneCalendar.rrule) ?? ""
                    phone.url = reminder.url?.absoluteString ?? ""
                    phone.completed = reminder.isCompleted
                    if let completed = reminder.completionDate {
                        phone.completedAt = ISO8601DateFormatter().string(from: completed)
                    }
                    let due = components.flatMap { (components: DateComponents) -> Date? in
                        var calendar = components.calendar ?? Calendar(identifier: .gregorian)
                        calendar.timeZone = components.timeZone ?? TimeZone.current
                        return calendar.date(from: components)
                    }
                    for alarm in reminder.alarms ?? [] {
                        if alarm.structuredLocation != nil {
                            phone.unsupportedAlarms += 1
                        } else if let absolute = alarm.absoluteDate, let due {
                            if let minutes = Int32(exactly: (due.timeIntervalSince(absolute) / 60).rounded()) { phone.alarmsBeforeMin.append(minutes) }
                            else { phone.unsupportedAlarms += 1 }
                        } else if alarm.absoluteDate == nil,
                                  let minutes = Int32(exactly: (-alarm.relativeOffset / 60).rounded()) {
                            phone.alarmsBeforeMin.append(minutes)
                        } else { phone.unsupportedAlarms += 1 }
                    }
                    return phone
                }
                continuation.resume(returning: reminders)
            }
        }
        var snapshot = Centraid_Core_V1_RemindersSnapshot()
        snapshot.reminders = reminders
        snapshot.deviceID = PhoneCalendar.deviceID
        snapshot.nativeHierarchyUnavailable = true
        return .remindersSnapshot(snapshot)
    }

    /// `YYYY-MM-DD` of a due date's own calendar day, or empty when it names none.
    private static func day(of components: DateComponents?) -> String {
        guard let components, let year = components.year, let month = components.month, let day = components.day
        else { return "" }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    private static func denied() -> Centraid_Core_V1_EffectFailed {
        var failed = Centraid_Core_V1_EffectFailed()
        failed.reason = "reminders access not given"
        failed.denied = true
        return failed
    }
}
