import Foundation
import WidgetKit

/// KEEPS HEALTH'S WIDGET SNAPSHOT (#1185): the app's half of `Effect.health_glance`.
///
/// Rust builds the JSON document and names the file; this writes it, byte for byte,
/// to the App Group container the widget extension reads, and asks WidgetKit to
/// reload the Health widget. It decides nothing and parses nothing. A version it
/// does not know, or a file name that is not a plain name, fails the effect.
enum HealthGlanceWriter {
    enum Failure: Error, CustomStringConvertible {
        case version(UInt32)
        case badFile(String)
        case noContainer
        case write(String)

        var description: String {
            switch self {
            case let .version(found): return "the widget draws another snapshot version (\(found))"
            case let .badFile(name): return "the snapshot's file name is not a plain name: \(name)"
            case .noContainer: return "the App Group container is not available"
            case let .write(reason): return "the snapshot could not be written: \(reason)"
            }
        }
    }

    /// Write the document atomically, readable from first unlock, then reload the
    /// Health widget's timelines. Throws, so the effect answers `EffectFailed`.
    static func keep(_ glance: Centraid_Core_V1_HealthGlance) throws {
        guard glance.version == UInt32(HealthGlanceSnapshot.supportedVersion) else {
            throw Failure.version(glance.version)
        }
        let name = glance.file
        guard !name.isEmpty, !name.contains("/"), name != ".", name != ".." else {
            throw Failure.badFile(name)
        }
        guard let directory = AgendaGlanceSnapshot.containerURL() else { throw Failure.noContainer }
        do {
            try glance.document.write(
                to: directory.appendingPathComponent(name),
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
        } catch {
            throw Failure.write(String(describing: error))
        }
        WidgetCenter.shared.reloadTimelines(ofKind: HealthGlanceSnapshot.widgetKind)
    }
}
