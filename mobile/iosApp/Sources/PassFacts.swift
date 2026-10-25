#if os(iOS)
import Foundation
import Network
import UIKit

/// THE LINK AND THE CHARGER, REPORTED (#1135, `passes`): what the radio and the battery say,
/// at launch and on every change, as `ShellFact.link`. The shell guesses nothing: a reading
/// the platform would not give is sent as unknown, and Rust reads it as the expensive answer
/// (metered, not charging). What the link is worth — a pass, the rule's windows — is Rust's.
@MainActor
final class LinkReporter {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "dev.centraid.link")
    private weak var store: ScreenStore?
    private var path: NWPath?
    private var observers: [NSObjectProtocol] = []

    /// Start reporting to `store`. Idempotent.
    func start(_ store: ScreenStore) {
        guard self.store == nil else { return }
        self.store = store
        UIDevice.current.isBatteryMonitoringEnabled = true
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                self?.path = path
                self?.report()
            }
        }
        monitor.start(queue: queue)
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIDevice.batteryStateDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.report() }
            },
        ]
        report()
    }

    /// THE LINK NOW, for the camera roll's `LinkRead`: online and metered as the platform said,
    /// and `platform_refused` before it said anything. Which original may cross it is Rust's.
    var reading: Centraid_Core_V1_LinkReading {
        var reading = Centraid_Core_V1_LinkReading()
        if let path {
            reading.online = path.status == .satisfied
            reading.metered = path.isExpensive || path.isConstrained
        } else {
            reading.platformRefused = true
        }
        return reading
    }

    /// One reading of the link and the charger, as the platform gave it.
    private func report() {
        var link = Centraid_Core_V1_LinkChanged()
        if let path {
            link.online = path.status == .satisfied
            // CELLULAR, A PERSONAL HOTSPOT AND LOW DATA MODE all cost the member: expensive or constrained.
            link.metered = path.isExpensive || path.isConstrained
            link.meteredKnown = true
        }
        switch UIDevice.current.batteryState {
        case .charging, .full:
            link.charging = true
            link.chargingKnown = true
        case .unplugged:
            link.charging = false
            link.chargingKnown = true
        default:
            link.chargingKnown = false
        }
        store?.report(.link(link))
    }
}
#endif
