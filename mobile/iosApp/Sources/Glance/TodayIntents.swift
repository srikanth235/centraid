import AppIntents
import Foundation

struct WhatsNextIntent: AppIntent {
    static let title: LocalizedStringResource = "What's next"
    static let openAppWhenRun: Bool = false

    init() {}

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let spoken: String
        if let snapshot = TodayGlanceSnapshot.load() {
            if let first = snapshot.lines.first {
                spoken = first.text
            } else if !snapshot.summary.isEmpty {
                spoken = snapshot.summary
            } else {
                spoken = "Open Centraid to see your day."
            }
        } else {
            spoken = "Open Centraid to see your day."
        }
        return .result(dialog: IntentDialog(stringLiteral: spoken))
    }
}
