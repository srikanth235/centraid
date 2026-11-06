import AppIntents

/// Available in Shortcuts and Siri. New Reminder opens the editable draft so a
/// dictated date is visible before the member adds it to the vault.
// Metadata declarations are generated into Design/AgendaIntentMetadata.swift:
// Apple's extractor requires literals there, while the Rust catalogue owns copy.
extension OpenCalendarIntent {
    func perform() async throws -> some IntentResult {
        await MainActor.run { AgendaEntrypoint.request(.agendaCalendar) }
        return .result()
    }
}

extension OpenRemindersIntent {
    func perform() async throws -> some IntentResult {
        await MainActor.run { AgendaEntrypoint.request(.agendaReminders) }
        return .result()
    }
}

extension NewReminderIntent {
    func perform() async throws -> some IntentResult {
        let title = reminderTitle
        await MainActor.run { AgendaEntrypoint.request(.agendaNewReminder, title: title) }
        return .result()
    }
}
