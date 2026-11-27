import Foundation

extension ShellModel {
    func handleOpenURL(_ url: URL) {
        if let target = TodayGlanceSnapshot.parseOpenURL(url), let rooms {
            Task {
                await rooms.open(key: "\(target.kind)/\(target.id)", tab: RustScreens.homeTab, root: false)
            }
            return
        }
        _ = handleHealthOpenURL(url)
    }
}
