import Foundation

extension ShellModel {
    func handleOpenURL(_ url: URL) {
        guard let rooms else { return }
        Task { await rooms.open(deepLink: url) }
    }
}
