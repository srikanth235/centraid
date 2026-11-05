import AppIntents

/// Available in Shortcuts and Siri. New Reminder opens the editable draft so a
/// dictated date is visible before the member adds it to the vault.
struct OpenCalendarIntent: AppIntent {
    static let title = LocalizedStringResource(stringLiteral: KitWords.AGENDA_OPEN_CALENDAR)
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        await MainActor.run { AgendaEntrypoint.request(.agendaCalendar) }
        return .result()
    }
}

struct OpenRemindersIntent: AppIntent {
    static let title = LocalizedStringResource(stringLiteral: KitWords.AGENDA_OPEN_REMINDERS)
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        await MainActor.run { AgendaEntrypoint.request(.agendaReminders) }
        return .result()
    }
}

struct NewReminderIntent: AppIntent {
    static let title = LocalizedStringResource(stringLiteral: KitWords.AGENDA_NEW_REMINDER)
    static let openAppWhenRun = true
    @Parameter(title: LocalizedStringResource(stringLiteral: KitWords.AGENDA_REMINDER_TITLE))
    var reminderTitle: String

    func perform() async throws -> some IntentResult {
        let title = reminderTitle
        await MainActor.run { AgendaEntrypoint.request(.agendaNewReminder, title: title) }
        return .result()
    }
}
