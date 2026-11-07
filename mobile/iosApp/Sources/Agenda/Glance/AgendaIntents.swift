import AppIntents
import Foundation

/// AGENDA FROM SIRI, SHORTCUTS AND THE WIDGETS' GALLERY (#1173, wave 3).
///
/// Both intents are named by the generated `Design/AgendaShortcuts.swift`
/// (`AddReminderIntent`, `WhatsNextIntent`); the words come from the generated
/// `GlanceWords`, finished by Rust, and none is typed here.
///
/// `static let` and not `static var`: the protocol asks for a getter, and a
/// mutable static is not concurrency-safe under Swift 6.
///
/// NOTE FOR A MAC RUN: AppIntents' metadata extraction prefers literal titles. A
/// title read from `GlanceWords` is a constant string at run time; if Xcode warns
/// that the metadata could not be extracted, or Shortcuts does not list the
/// intent, that is the cause and the owner decides how the catalogue should emit
/// the title (the same question the shortcut phrases already answered by being
/// generated as literals).

/// "Add a reminder": opens the app on Agenda's Reminders with the quick-add bar
/// holding what the member said. NOTHING IS WRITTEN HERE: the core answers the
/// fact with a route, and the member taps Add.
struct AddReminderIntent: AppIntent {
    static let title = LocalizedStringResource(stringLiteral: GlanceWords.INTENT_ADD_TITLE)
    static let openAppWhenRun: Bool = true

    @Parameter(title: LocalizedStringResource(stringLiteral: GlanceWords.INTENT_ADD_TITLE_PARAMETER))
    var reminder: String?

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult {
        var add = Centraid_Core_V1_AgendaIntentAdd()
        add.title = reminder ?? ""
        var intent = Centraid_Core_V1_AgendaIntent()
        intent.kind = .add(add)
        // THE RUNNING STORE, OR THE ONE ABOUT TO BE: the intent may run in a process the
        // intent itself launched, before the core is open. `ShellModel.shared` queues the
        // fact until the store has started.
        ShellModel.shared.reportWhenReady(.agendaIntent(intent))
        return .result()
    }
}

/// "What's next": Siri speaks the sentence Rust wrote into the snapshot. It reads
/// the App Group file only; the app is not opened and the vault is never touched.
struct WhatsNextIntent: AppIntent {
    static let title = LocalizedStringResource(stringLiteral: GlanceWords.INTENT_NEXT_TITLE)
    static let openAppWhenRun: Bool = false

    init() {}

    /// No snapshot at all (the app has not written one, or the file is not a
    /// version-1 document): there is no sentence of Rust's to speak, and this file
    /// holds no words, so the intent fails and the system says its own.
    enum Unavailable: Error {
        case noSnapshot
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let snapshot = AgendaGlanceSnapshot.load() else { throw Unavailable.noSnapshot }
        let sentence = snapshot.notice(now: Date()) ?? snapshot.siri.nextSentence
        guard !sentence.isEmpty else { throw Unavailable.noSnapshot }
        return .result(dialog: IntentDialog(stringLiteral: sentence))
    }
}
