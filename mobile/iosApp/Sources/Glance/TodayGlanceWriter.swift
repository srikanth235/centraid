import Foundation
import WidgetKit

enum TodayGlanceWriter {
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

    static func keep(_ document: Data) throws {
        guard let directory = TodayGlanceSnapshot.containerURL() else { throw Failure.noContainer }
        var file = directory.appendingPathComponent(TodayGlanceSnapshot.fileName)
        do {
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
        WidgetCenter.shared.reloadAllTimelines()
    }

    @MainActor
    static func sync(rooms: RoomStore) async {
        guard let raw = await rooms.deviceGet(TodayGlanceSnapshot.deviceKey),
              let data = raw.data(using: .utf8)
        else { return }
        try? keep(data)
    }
}
