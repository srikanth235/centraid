import AppIntents
import Foundation

/// AGENDA FROM SIRI, SHORTCUTS AND THE WIDGETS' GALLERY (#1173, wave 3).
///
/// Both intents are named by the generated `Design/AgendaShortcuts.swift`
/// (`AddReminderIntent`, `WhatsNextIntent`); the words are the catalogue's, finished by Rust (the titles
/// repeat it as literals, see below); the spoken answer is read from `GlanceWords`.
///
/// `static let` and not `static var`: the protocol asks for a getter, and a
/// mutable static is not concurrency-safe under Swift 6.
///
/// THE TITLES ARE STRING LITERALS, because AppIntents' metadata extraction
/// refuses `LocalizedStringResource(stringLiteral: <constant>)` (a compile error
/// in the `appintentsmetadataprocessor` step). They repeat the catalogue's
/// `intent_add_title`, `intent_add_title_parameter` and `intent_next_title`, and
/// the xtask test `the_intent_titles_are_the_catalogues_words` fails if they
/// drift from `GlanceWords`.

/// "Add a reminder": opens the app on Agenda's Reminders with the quick-add bar
/// holding what the member said. NOTHING IS WRITTEN HERE: the core answers the
/// fact with a route, and the member taps Add.
struct AddReminderIntent: AppIntent {
    static let title: LocalizedStringResource = "Add a reminder"
    static let openAppWhenRun: Bool = true

    @Parameter(title: "Reminder")
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
    static let title: LocalizedStringResource = "What's next"
    static let openAppWhenRun: Bool = false

    init() {}

    /// No snapshot at all (the app has not written one, or the file is not a
    /// version-1 document): the answer is the catalogue's own "open Centraid"
    /// sentence, spoken as a dialog and not thrown as a generic error.
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let spoken = AgendaGlanceSnapshot.load().flatMap { snapshot -> String? in
            let sentence = snapshot.notice(now: Date()) ?? snapshot.siri.nextSentence
            return sentence.isEmpty ? nil : sentence
        } ?? GlanceWords.INTENT_NEXT_UNAVAILABLE
        return .result(dialog: IntentDialog(stringLiteral: spoken))
    }
}
