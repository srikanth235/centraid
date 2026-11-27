import Foundation
import Network

extension Notification.Name {
    /// The network the phone is on changed.
    static let chatNetworkChanged = Notification.Name("centraid.chat.networkChanged")
}

/// THE NETWORK THE PHONE IS ON (Wi-Fi, mobile data, none), which the downloader reads to hold a
/// transfer to Wi-Fi.
final class ChatDeviceWatcher: @unchecked Sendable {
    static let shared = ChatDeviceWatcher()

    enum Network { case unspecified, offline, cellular, wifi }

    private let monitor = NWPathMonitor()
    private let lock = NSLock()
    private var current: Network = .unspecified

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let kind: Network
            if path.status != .satisfied {
                kind = .offline
            } else if path.usesInterfaceType(.cellular) || path.isExpensive {
                kind = .cellular
            } else {
                kind = .wifi
            }
            self?.lock.lock()
            self?.current = kind
            self?.lock.unlock()
            DispatchQueue.main.async { NotificationCenter.default.post(name: .chatNetworkChanged, object: nil) }
        }
        monitor.start(queue: DispatchQueue(label: "dev.centraid.chat.network"))
    }

    var network: Network {
        lock.lock()
        defer { lock.unlock() }
        return current
    }
}
