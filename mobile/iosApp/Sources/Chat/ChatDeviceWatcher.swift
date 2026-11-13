import Foundation
import Network

extension Notification.Name {
    /// The network the phone is on changed.
    static let chatNetworkChanged = Notification.Name("centraid.chat.networkChanged")
}

/// WHAT THE PHONE IS LIKE FOR THE DOWNLOAD RULES (#1188): the network it is on (Wi-Fi, mobile data,
/// none) and the space it has free. Told to Rust as `ChatEvent.DeviceFacts`, which decides what the
/// download step offers; the downloader reads the same network to hold a transfer to Wi-Fi.
final class ChatDeviceWatcher: @unchecked Sendable {
    static let shared = ChatDeviceWatcher()

    typealias Network = Centraid_Core_V1_ChatEvent.DeviceFacts.Network

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

    /// Bytes the phone can still keep for something the member asked for; 0 when it cannot say.
    var freeBytes: UInt64 {
        let values = try? URL(fileURLWithPath: NSHomeDirectory())
            .resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return UInt64(max(values?.volumeAvailableCapacityForImportantUsage ?? 0, 0))
    }
}
