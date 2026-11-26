import Foundation
import WidgetKit

enum HealthGlanceWriter {
    enum Failure: Error, CustomStringConvertible {
        case badFile(String)
        case noContainer
        case write(String)

        var description: String {
            switch self {
            case let .badFile(name): return "the snapshot's file name is not a plain name: \(name)"
            case .noContainer: return "the App Group container is not available"
            case let .write(reason): return "the snapshot could not be written: \(reason)"
            }
        }
    }

    static func keep(document: Data, fileName: String = HealthGlanceSnapshot.fileName) throws {
        guard !fileName.isEmpty, !fileName.contains("/"), fileName != ".", fileName != ".." else {
            throw Failure.badFile(fileName)
        }
        guard let directory = TodayGlanceSnapshot.containerURL() else { throw Failure.noContainer }
        do {
            var file = directory.appendingPathComponent(fileName)
            try document.write(
                to: file,
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try file.setResourceValues(values)
        } catch {
            throw Failure.write(String(describing: error))
        }
        WidgetCenter.shared.reloadTimelines(ofKind: HealthGlanceSnapshot.widgetKind)
    }
}
