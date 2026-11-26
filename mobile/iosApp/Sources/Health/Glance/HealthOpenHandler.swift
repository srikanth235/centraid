import Foundation

extension ShellModel {
    func handleHealthOpenURL(_ url: URL) -> Bool {
        guard let key = HealthGlanceSnapshot.openKey(from: url), let rooms else { return false }
        Task {
            await rooms.open(key: "health/\(key)", tab: RustScreens.homeTab, root: false)
        }
        return true
    }
}
