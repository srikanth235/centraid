import EventKit
import Foundation

/// THE PHONE'S OPEN REMINDERS, READ FOR THE CORE (#1135, `imports.made`): the
/// `RemindersRead` effect answered with a `RemindersSnapshot`. Only OPEN
/// reminders are handed over, a completed one never; Rust makes each a task and
/// folds a duplicate. Full access is asked only when the effect says the made
/// vault's prompt may ask, never at launch.
enum PhoneReminders {
    static func snapshot(_ read: Centraid_Core_V1_RemindersRead) async -> Centraid_Core_V1_EffectResult.OneOf_Outcome {
        let store = EKEventStore()
        if read.askPermission {
            guard (try? await store.requestFullAccessToReminders()) ?? false else { return .failed(denied()) }
        } else if EKEventStore.authorizationStatus(for: .reminder) != .fullAccess {
            return .failed(denied())
        }
        // COMPLETED ONES ONLY WHEN THE MEMBER ASKED FOR THEM (`include_completed`).
        let predicate = read.includeCompleted
            ? store.predicateForReminders(in: nil)
            : store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        let reminders: [Centraid_Core_V1_PhoneReminder] = await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { found in
                // EventKit retains its model objects. Read them on the callback's
                // executor and transfer only immutable protobuf values.
                let reminders = (found ?? [])
                    .filter { read.includeCompleted || !$0.isCompleted }
                    .map { phone($0) }
                continuation.resume(returning: reminders)
            }
        }
        var snapshot = Centraid_Core_V1_RemindersSnapshot()
        snapshot.reminders = reminders
        return .remindersSnapshot(snapshot)
    }

    /// EVERY FIELD A REMINDER CARRIES, read as the OS holds it. Rust maps priority, folds a
    /// duplicate and words nothing; `priority` is EventKit's raw 0..9. EventKit has no public
    /// flag, so `flagged` is left unset (the core then states nothing of the star, rather than "not flagged"). A subtask's parent is not exposed either: `parent_id`
    /// stays empty.
    private static func phone(_ reminder: EKReminder) -> Centraid_Core_V1_PhoneReminder {
        var phone = Centraid_Core_V1_PhoneReminder()
        // THE DURABLE IDS THAT LET THE VAULT FOLLOW THE STORE (#1185): the external identifier
        // survives a sync, the item identifier is the fallback; the list is its calendar's id.
        let external = reminder.calendarItemExternalIdentifier ?? ""
        phone.phoneID = external.isEmpty ? reminder.calendarItemIdentifier : external
        phone.listID = reminder.calendar?.calendarIdentifier ?? ""
        phone.title = reminder.title ?? ""
        phone.notes = reminder.notes ?? ""
        let due = reminder.dueDateComponents
        phone.due = day(of: due)
        if let due, let hour = due.hour {
            phone.dueTime = String(format: "%02d:%02d:%02d", hour, due.minute ?? 0, due.second ?? 0)
            phone.tz = due.timeZone?.identifier ?? ""
        }
        phone.priority = Int32(reminder.priority)
        if let rule = reminder.recurrenceRules?.first { phone.rrule = PhoneCalendar.rrule(rule) }
        if let minutes = minutesBefore(reminder, due: due) { phone.alarmMinutesBefore = minutes }
        phone.listTitle = reminder.calendar?.title ?? ""
        phone.listColor = PhoneCalendar.hex(reminder.calendar?.cgColor)
        phone.url = reminder.url?.absoluteString ?? ""
        phone.completed = reminder.isCompleted
        if reminder.isCompleted, let when = reminder.completionDate {
            phone.completedAt = PhoneCalendar.civil(when, TimeZone(identifier: "UTC") ?? .current, "yyyy-MM-dd'T'HH:mm:ss'Z'")
        }
        return phone
    }

    /// The first alarm as whole minutes before the due time: a relative one is its offset
    /// negated, an absolute one is the due time minus the alarm's date. One after the due time
    /// is none.
    private static func minutesBefore(_ reminder: EKReminder, due: DateComponents?) -> UInt32? {
        guard let alarm = reminder.alarms?.first else { return nil }
        let seconds: TimeInterval
        if let absolute = alarm.absoluteDate {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = due?.timeZone ?? .current
            guard let due, let dueDate = calendar.date(from: due) else { return nil }
            seconds = dueDate.timeIntervalSince(absolute)
        } else {
            seconds = -alarm.relativeOffset
        }
        guard seconds >= 0 else { return nil }
        return UInt32((seconds / 60).rounded())
    }

    /// `YYYY-MM-DD` of a due date's own calendar day, or empty when it names none.
    private static func day(of components: DateComponents?) -> String {
        guard let components, let year = components.year, let month = components.month, let day = components.day
        else { return "" }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    private static func denied() -> Centraid_Core_V1_EffectFailed {
        var failed = Centraid_Core_V1_EffectFailed()
        failed.reason = EffectReason.denied
        failed.denied = true
        return failed
    }
}
