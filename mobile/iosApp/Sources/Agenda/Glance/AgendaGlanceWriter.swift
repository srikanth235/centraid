import Foundation
import WidgetKit

/// KEEPS AGENDA'S WIDGET SNAPSHOT (#1173, wave 3): the app's half of
/// `Effect.agenda_glance`.
///
/// Rust builds the JSON document and asks; this writes it, byte for byte, to the
/// App Group container the widget extension and Siri read, and asks WidgetKit to
/// reload. It decides nothing and parses nothing.
///
/// THE VERSION IS NOT CHECKED HERE. The document is Rust's and the readers
/// (`AgendaGlanceSnapshot.decode`) treat a version they do not know as
/// unavailable, so writing an unknown one is safe and is the honest record of what
/// Rust said; refusing it here would leave an older snapshot that looks healthy.
enum AgendaGlanceWriter {
    enum Failure: Error, CustomStringConvertible {
        case noContainer
        case write(String)

        var description: String {
            switch self {
            case .noContainer: return "the App Group container is not available"
            case let .write(reason): return "the snapshot could not be written: \(reason)"
            }
        }
    }

    /// Write the document atomically, readable from first unlock (a widget on a
    /// locked phone must still draw), then reload every widget timeline. Throws,
    /// so the effect answers `EffectFailed`; a failure is never swallowed.
    static func keep(_ glance: Centraid_Core_V1_AgendaGlance) throws {
        guard let directory = AgendaGlanceSnapshot.containerURL() else { throw Failure.noContainer }
        let file = directory.appendingPathComponent(AgendaGlanceSnapshot.fileName)
        do {
            try glance.document.write(
                to: file,
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
        } catch {
            throw Failure.write(String(describing: error))
        }
        WidgetCenter.shared.reloadAllTimelines()
    }
}
