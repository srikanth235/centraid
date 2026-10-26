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
        let predicate = store.predicateForIncompleteReminders(
            withDueDateStarting: nil, ending: nil, calendars: nil
        )
        let reminders: [EKReminder] = await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { continuation.resume(returning: $0 ?? []) }
        }
        var snapshot = Centraid_Core_V1_RemindersSnapshot()
        snapshot.reminders = reminders.filter { !$0.isCompleted }.map { reminder in
            var phone = Centraid_Core_V1_PhoneReminder()
            phone.title = reminder.title ?? ""
            phone.notes = reminder.notes ?? ""
            phone.due = day(of: reminder.dueDateComponents)
            return phone
        }
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
