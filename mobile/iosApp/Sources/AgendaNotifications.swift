#if os(iOS)
import Foundation
import SwiftProtobuf
import UserNotifications

/// Executes Rust's notification plan. A protected, atomic device journal keeps
/// actions until Rust acknowledges them, including a background relaunch.
@MainActor
final class AgendaNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = AgendaNotifications()
    var onAction: ((Centraid_Core_V1_AgendaNotificationAction) -> Void)?

    private let center = UNUserNotificationCenter.current()
    private var journal: Centraid_Core_V1_AgendaNotificationJournal?
    private static let prefix = "agenda:"
    private static let done = "agenda.done"
    private static let hour = "agenda.hour"
    private static let tomorrow = "agenda.tomorrow"

    func install() { center.delegate = self }

    private func file() throws -> URL {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("Notifications", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var excluded = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
        return directory.appendingPathComponent("agenda.pb")
    }

    private func read() throws -> Centraid_Core_V1_AgendaNotificationJournal {
        if let journal { return journal }
        let path = try file()
        let loaded: Centraid_Core_V1_AgendaNotificationJournal
        if FileManager.default.fileExists(atPath: path.path) {
            loaded = try .init(serializedBytes: Data(contentsOf: path))
        } else {
            loaded = .init()
        }
        journal = loaded
        return loaded
    }

    private func write(_ next: Centraid_Core_V1_AgendaNotificationJournal) throws {
        try next.serializedData().write(to: file(), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        journal = next
    }

    // A future period must not replace an already-due OS request that is still
    // being delivered. The stable action identity remains in userInfo.
    private static func identifier(_ vault: String, _ alert: String, _ fireAt: Int64) -> String { "\(prefix)\(vault):\(alert):\(fireAt)" }

    func sync(_ asked: Centraid_Core_V1_AgendaNotificationSync) async throws -> Centraid_Core_V1_AgendaNotificationState {
        var stored = try read()
        if !asked.loadOnly {
            stored.plan = asked
            stored.pending.removeAll { asked.acknowledge.contains($0.actionID) }
            try write(stored)
            let done = UNNotificationAction(identifier: Self.done, title: asked.doneLabel, options: [.authenticationRequired])
            let hour = UNNotificationAction(identifier: Self.hour, title: asked.hourLabel, options: [.authenticationRequired])
            let tomorrow = UNNotificationAction(identifier: Self.tomorrow, title: asked.tomorrowLabel, options: [.authenticationRequired])
            center.setNotificationCategories([
                UNNotificationCategory(identifier: "centraid.reminder", actions: [done, hour, tomorrow], intentIdentifiers: []),
                UNNotificationCategory(identifier: "centraid.calendar-alert", actions: [hour, tomorrow], intentIdentifiers: []),
            ])
            var settings = await center.notificationSettings()
            if asked.askPermission, settings.authorizationStatus == .notDetermined {
                _ = try await center.requestAuthorization(options: [.alert, .sound, .badge])
                settings = await center.notificationSettings()
            }
            let wanted = Set(asked.alerts.map { Self.identifier(asked.vaultID, $0.id, $0.fireAtMs) })
            let pending = await center.pendingNotificationRequests()
            let now = Int64(Date().timeIntervalSince1970 * 1_000)
            center.removePendingNotificationRequests(withIdentifiers: pending.compactMap { request in
                guard request.identifier.hasPrefix(Self.prefix), !wanted.contains(request.identifier) else { return nil }
                let info = request.content.userInfo
                // A due request may already be on its way to delivery. Keep it
                // unless its source changed or a newer snooze supersedes it.
                let fireAt = (info["fire_ms"] as? NSNumber)?.int64Value
                let dueAndCurrent = fireAt.map { $0 <= now } == true && Self.mayPresent(asked,
                    vault: info["vault"] as? String ?? "", alert: info["alert"] as? String ?? "",
                    entity: info["entity"] as? String ?? "", source: info["source"] as? String ?? "",
                    fireAt: fireAt, now: now)
                return dueAndCurrent ? nil : request.identifier
            })
            let delivered = await center.deliveredNotifications()
            center.removeDeliveredNotifications(withIdentifiers: delivered.compactMap { notification in
                let request = notification.request
                guard request.identifier.hasPrefix(Self.prefix) else { return nil }
                let info = request.content.userInfo
                let current = Self.mayPresent(asked, vault: info["vault"] as? String ?? "", alert: info["alert"] as? String ?? "", entity: info["entity"] as? String ?? "", source: info["source"] as? String ?? "", fireAt: (info["fire_ms"] as? NSNumber)?.int64Value, now: Int64(Date().timeIntervalSince1970 * 1_000))
                return current ? nil : request.identifier
            })
            if Self.allowed(settings.authorizationStatus) {
                for alert in asked.alerts {
                    let interval = Double(alert.fireAtMs) / 1_000 - Date().timeIntervalSince1970
                    guard interval > 0 else { continue }
                    let content = UNMutableNotificationContent()
                    content.title = alert.title
                    content.body = alert.body
                    content.sound = .default
                    content.categoryIdentifier = alert.task ? "centraid.reminder" : "centraid.calendar-alert"
                    content.threadIdentifier = asked.channelLabel
                    content.userInfo = ["vault": asked.vaultID, "alert": alert.id, "entity": alert.entityID, "source": alert.sourceStamp, "fire_ms": alert.fireAtMs]
                    try await center.add(UNNotificationRequest(identifier: Self.identifier(asked.vaultID, alert.id, alert.fireAtMs), content: content,
                        trigger: UNTimeIntervalNotificationTrigger(timeInterval: max(1, interval), repeats: false)))
                }
            }
        }
        // An action can arrive while the OS was answering an async call above.
        let current = try read()
        let settings = await center.notificationSettings()
        var state = Centraid_Core_V1_AgendaNotificationState()
        state.vaultID = current.plan.vaultID
        state.snoozed = current.plan.snoozed
        state.pending = current.pending
        state.allowed = Self.allowed(settings.authorizationStatus)
        return state
    }

    private static func allowed(_ status: UNAuthorizationStatus) -> Bool {
        status == .authorized || status == .provisional || status == .ephemeral
    }

    private static func isCurrent(_ plan: Centraid_Core_V1_AgendaNotificationSync, vault: String, entity: String, source: String) -> Bool {
        !vault.isEmpty && plan.vaultID == vault && plan.sources.contains { $0.entityID == entity && $0.sourceStamp == source }
    }

    static func mayPresent(_ plan: Centraid_Core_V1_AgendaNotificationSync, vault: String, alert: String, entity: String, source: String, fireAt: Int64?, now: Int64) -> Bool {
        isCurrent(plan, vault: vault, entity: entity, source: source) && !plan.snoozed.contains {
            $0.id == alert && $0.fireAtMs > now && $0.fireAtMs != fireAt
        }
    }

    private func record(vault: String, alert: String, entity: String, source: String, requestID: String, kind: Centraid_Core_V1_AgendaNotificationAction.Kind) throws -> String? {
        var stored = try read()
        guard !alert.isEmpty, Self.isCurrent(stored.plan, vault: vault, entity: entity, source: source) else { return nil }
        var action = Centraid_Core_V1_AgendaNotificationAction()
        action.actionID = UUID().uuidString
        action.vaultID = vault
        action.alertID = alert
        action.entityID = entity
        action.sourceStamp = source
        action.kind = kind
        action.atMs = Int64(Date().timeIntervalSince1970 * 1_000)
        stored.pending.append(action)
        try write(stored)
        center.removeDeliveredNotifications(withIdentifiers: [requestID])
        onAction?(action)
        // On a notification launch there may be no SwiftUI scene to open it.
        _ = ShellModel.shared
        return action.actionID
    }

    private func deliver(vault: String, alert: String, entity: String, source: String, requestID: String, kind: Centraid_Core_V1_AgendaNotificationAction.Kind) async {
        let grace = ForegroundGrace(name: "agenda-notification-action")
        defer { grace.end() }
        do {
            guard let id = try record(vault: vault, alert: alert, entity: entity, source: source, requestID: requestID, kind: kind) else { return }
            // Await acknowledgement under the platform's grace. Expiration or
            // termination leaves the saved action for the next session.
            for _ in 0..<80 {
                let pending = try read().pending.contains(where: { $0.actionID == id })
                if !pending { return }
                try await Task.sleep(for: .milliseconds(100))
            }
        } catch {
            NSLog("Agenda notification action could not be applied: %@", String(describing: type(of: error)))
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let vault = info["vault"] as? String, let alert = info["alert"] as? String,
              let entity = info["entity"] as? String, let source = info["source"] as? String else { return }
        let kind: Centraid_Core_V1_AgendaNotificationAction.Kind
        switch response.actionIdentifier {
        case "agenda.done": kind = .done
        case "agenda.hour": kind = .hour
        case "agenda.tomorrow": kind = .tomorrow
        default: return
        }
        let requestID = response.notification.request.identifier
        await Self.shared.deliver(vault: vault, alert: alert, entity: entity, source: source, requestID: requestID, kind: kind)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let info = notification.request.content.userInfo
        guard let vault = info["vault"] as? String, let alert = info["alert"] as? String, let entity = info["entity"] as? String, let source = info["source"] as? String else { return [] }
        let fireAt = (info["fire_ms"] as? NSNumber)?.int64Value
        let active = await MainActor.run {
            guard let plan = try? Self.shared.read().plan else { return false }
            return Self.mayPresent(plan, vault: vault, alert: alert, entity: entity, source: source, fireAt: fireAt, now: Int64(Date().timeIntervalSince1970 * 1_000))
        }
        return active ? [.banner, .list, .sound] : []
    }
}
#endif
