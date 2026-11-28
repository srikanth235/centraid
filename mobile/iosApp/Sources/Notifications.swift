import os

/// DEBUG-only mechanical startup phases. No notification IDs, words, keys or
/// payload/error descriptions are accepted by this diagnostic boundary.
enum NotificationStartupTrace {
    enum Phase: String, Sendable {
        case callbackEntered
        case callbackCompleted
        case shellModelTouchStarted
        case shellModelTouched
        case shellModelInitStarted
        case coreOpenStarted
        case coreOpenCompleted
        case coreAttachStarted
        case coreAttachCompleted
        case snapshotStarted
        case snapshotCompleted
        case storeWaitStarted
        case storeWaitCompleted
        case storePublished
        case answerWaitRegistered
        case notificationFactStarted
        case notificationFactCompleted
        case notificationScheduleStarted
        case notificationScheduleCompleted
        case matchingAnswerPerformed
        case answerReturned
        case callbackExpired
    }

    #if DEBUG
    private static let logger = Logger(subsystem: "dev.centraid.Centraid", category: "NotificationStartup")
    #endif

    nonisolated static func mark(_ phase: Phase, count: Int = 0, succeeded: Bool = true) {
        #if DEBUG
        logger.notice("phase=\(phase.rawValue, privacy: .public) count=\(count, privacy: .public) success=\(succeeded, privacy: .public)")
        #endif
    }
}

#if os(iOS)
import Foundation
import UserNotifications

enum Notifications {
    private static let idKey = "notification_id"
    private static let fingerprintKey = "notification_source_fingerprint"
    private static let entityIDKey = "notification_entity_id"
    private static let dateIDKey = "notification_date_id"
    private static let fieldIDKey = "notification_field_id"
    private static let channelIDKey = "notification_channel_id"
    private static let openURLKey = "notification_open_url"
    private static let immediatesKey = "centraid.notification.immediates"
    static let pendingCap: UInt32 = 64
    static let doneActionID = "done"
    static let snoozeActionID = "snooze"
    static let taskCategoryID = "alert.task"
    static let eventCategoryID = "alert.event"
    static let personCategoryID = "alert.person"
    static let lockerItemCategoryID = "alert.locker_item"

    /// Perform `ScheduleNotifications` and say what the OS said.
    @MainActor static func schedule(_ schedule: Centraid_Core_V1_ScheduleNotifications) async -> Centraid_Core_V1_NotificationsScheduled {
        let center = UNUserNotificationCenter.current()
        var answer = Centraid_Core_V1_NotificationsScheduled()

        // PERMISSION IS ASKED ONLY WHEN IT IS FIRST NEEDED (`askPermission`), never otherwise.
        var status = await center.notificationSettings().authorizationStatus
        if status == .notDetermined, schedule.askPermission {
            let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            status = granted ? .authorized : .denied
        }
        switch status {
        case .notDetermined:
            // NOT ASKED, AND NOT ASKED NOW: schedule nothing, say nothing.
            answer.permission = .notAsked
            answer.held = 0
            return answer
        case .denied:
            // A QUIET STATE: nothing of ours stays in the OS, and nothing is said.
            center.removeAllPendingNotificationRequests()
            center.removeAllDeliveredNotifications()
            answer.permission = .denied
            answer.held = 0
            return answer
        default:
            answer.permission = .granted
        }

        center.setNotificationCategories(Set(notificationCategories(from: schedule.categories)))

        // Diff against the actual OS inventory, preserving the upstream pending/live plan.
        let now = Date()
        let delivered = await center.deliveredNotifications()
        let deliveredIDs = Set(delivered.map { $0.request.identifier })
        let plan = NotificationPlan.reconcile(
            wanted: schedule.all,
            live: schedule.liveIds,
            pending: await center.pendingNotificationRequests().map(\.identifier),
            delivered: Array(deliveredIDs),
            nowMs: Int64(now.timeIntervalSince1970 * 1000),
            retainDelivered: schedule.retainDelivered,
            cancelDeliveredIDs: schedule.cancelDeliveredIds
        )
        if !plan.removePending.isEmpty {
            center.removePendingNotificationRequests(withIdentifiers: plan.removePending)
        }
        let removeDelivered = Array(Set(plan.removeDelivered + schedule.cancelDeliveredIds)).sorted()
        if !removeDelivered.isEmpty {
            center.removeDeliveredNotifications(withIdentifiers: removeDelivered)
        }

        // Only IDs are remembered: dismissing an Undo receipt must not resurrect it on
        // refresh or restart. A failed post remains eligible for a later reconciliation.
        let previousImmediates = Set(UserDefaults.standard.stringArray(forKey: immediatesKey) ?? [])
        let currentImmediates = Set(schedule.all.filter(\.immediate).map(\.notificationID))
        var heldImmediates = NotificationPlan.rememberedImmediates(
            current: currentImmediates, previous: previousImmediates, delivered: deliveredIDs
        )
        for item in plan.schedule + plan.post {
            if item.immediate, heldImmediates.contains(item.notificationID) { continue }
            guard let request = request(item, now: now) else { continue }
            do {
                try await center.add(request)
                if item.immediate { heldImmediates.insert(item.notificationID) }
            } catch {
                // A failed post was never delivered: allow a subsequent reconciliation to retry.
            }
        }
        UserDefaults.standard.set(heldImmediates.sorted(), forKey: immediatesKey)
        answer.held = UInt32(await center.pendingNotificationRequests().count)
        answer.delivered = await center.deliveredNotifications().map { notification in
            .with {
                $0.notificationID = notification.request.identifier
                $0.sourceFingerprint = notification.request.content.userInfo[fingerprintKey] as? String ?? ""
            }
        }
        return answer
    }

    static func allowsDone(forCategoryID categoryID: String) -> Bool {
        switch categoryID {
        case eventCategoryID, personCategoryID, lockerItemCategoryID:
            return false
        default:
            return true
        }
    }

    static func actionIdentifier(for verb: Centraid_Core_V1_NotificationVerb) -> String {
        switch verb {
        case .done: return doneActionID
        case .snoozeHour: return snoozeActionID
        default: return String(verb.rawValue)
        }
    }

    static func verb(forActionIdentifier identifier: String) -> Centraid_Core_V1_NotificationVerb? {
        if identifier == UNNotificationDefaultActionIdentifier {
            return .open
        }
        if identifier == doneActionID {
            return .done
        }
        if identifier == snoozeActionID {
            return .snoozeHour
        }
        return Int(identifier).flatMap { Centraid_Core_V1_NotificationVerb(rawValue: $0) }
    }

    static func notificationCategories(
        from categories: [Centraid_Core_V1_NotificationCategory]
    ) -> [UNNotificationCategory] {
        var byID: [String: UNNotificationCategory] = [:]
        var doneTitle = KitWords.DONE
        var snoozeTitle = "Snooze"

        for item in categories {
            for action in item.actions {
                if action.verb == .done, !action.label.isEmpty { doneTitle = action.label }
                if action.verb == .snoozeHour, !action.label.isEmpty { snoozeTitle = action.label }
            }
            byID[item.categoryID] = category(item)
        }

        let defaultSpecs: [(String, [UNNotificationAction])] = [
            (
                taskCategoryID,
                [
                    UNNotificationAction(identifier: doneActionID, title: doneTitle, options: []),
                    UNNotificationAction(identifier: snoozeActionID, title: snoozeTitle, options: []),
                ]
            ),
            (eventCategoryID, [UNNotificationAction(identifier: snoozeActionID, title: snoozeTitle, options: [])]),
            (personCategoryID, [UNNotificationAction(identifier: snoozeActionID, title: snoozeTitle, options: [])]),
            (lockerItemCategoryID, [UNNotificationAction(identifier: snoozeActionID, title: snoozeTitle, options: [])]),
        ]

        for (id, actions) in defaultSpecs where byID[id] == nil {
            byID[id] = UNNotificationCategory(identifier: id, actions: actions, intentIdentifiers: [], options: [])
        }
        return byID.values.sorted { $0.identifier < $1.identifier }
    }

    private static func category(_ category: Centraid_Core_V1_NotificationCategory) -> UNNotificationCategory {
        // No `.foreground` and no `.authenticationRequired`: actions run in the background from the
        // lock screen without unlocking (#1188, NA4), and every write is reversible via Undo.
        // Only task alerts allow Done (app-plane.md §9).
        let canDone = allowsDone(forCategoryID: category.categoryID)
        let actions = category.actions
            .filter { canDone || $0.verb != .done }
            .map { action in
                UNNotificationAction(
                    identifier: actionIdentifier(for: action.verb),
                    title: action.label,
                    options: []
                )
            }
        return UNNotificationCategory(identifier: category.categoryID, actions: actions, intentIdentifiers: [], options: [])
    }

    /// One notification as a request, or nil when it is already past (and not a receipt).
    private static func request(_ item: Centraid_Core_V1_PendingNotification, now: Date) -> UNNotificationRequest? {
        let content = UNMutableNotificationContent()
        content.title = item.title
        content.body = item.body
        content.categoryIdentifier = item.categoryID
        content.threadIdentifier = item.threadID
        content.sound = .default
        content.userInfo = [
            idKey: item.notificationID,
            fingerprintKey: item.sourceFingerprint,
            entityIDKey: item.entityID,
            dateIDKey: item.dateID,
            fieldIDKey: item.fieldID,
            channelIDKey: item.channelID,
            openURLKey: item.openURL,
        ]

        var trigger: UNNotificationTrigger?
        if !item.immediate {
            // `fireAtMs` IS THE TEST FOR "ALREADY PAST"; the calendar trigger is built from the
            // wall clock and the zone Rust named, so a zone change cannot move it.
            let fires = Date(timeIntervalSince1970: Double(item.fireAtMs) / 1000)
            guard fires > now, var parts = components(item.fireLocal) else { return nil }
            parts.timeZone = TimeZone(identifier: item.zone)
            trigger = UNCalendarNotificationTrigger(dateMatching: parts, repeats: false)
        }
        return UNNotificationRequest(identifier: item.notificationID, content: content, trigger: trigger)
    }

    /// `yyyy-MM-dd'T'HH:mm` as calendar components, or nil when it is not that.
    private static func components(_ local: String) -> DateComponents? {
        let halves = local.split(separator: "T", omittingEmptySubsequences: false)
        guard halves.count == 2 else { return nil }
        let date = halves[0].split(separator: "-").compactMap { Int($0) }
        let time = halves[1].split(separator: ":").compactMap { Int($0) }
        guard date.count == 3, time.count == 2 else { return nil }
        var parts = DateComponents()
        parts.year = date[0]
        parts.month = date[1]
        parts.day = date[2]
        parts.hour = time[0]
        parts.minute = time[1]
        return parts
    }

    /// WHAT THE MEMBER PRESSED, TO RUST: the id exactly as received, the verb as the number it
    /// arrived as. A tap on the notification itself is the default action and means open.
    /// A COLD LAUNCH FROM A NOTIFICATION has no store yet: opening the vaults is `ShellModel`'s
    /// (touched here), and the answer waits a bounded time for the store, as a background window does.
    @MainActor static func answered(
        id: String,
        action: String,
        entityID: String = "",
        dateID: String = "",
        fieldID: String = "",
        openURL: String = ""
    ) async {
        guard let verb = verb(forActionIdentifier: action) else { return }
        if verb == .open, !openURL.isEmpty, let url = URL(string: openURL) {
            ShellModel.shared.handleOpenURL(url)
            return
        }
        let press = NotificationOutbox.add(
            notificationID: id,
            verb: verb.rawValue,
            entityID: entityID,
            dateID: dateID,
            fieldID: fieldID
        )
        NotificationStartupTrace.mark(.shellModelTouchStarted)
        _ = ShellModel.shared
        NotificationStartupTrace.mark(.shellModelTouched)
        NotificationStartupTrace.mark(.storeWaitStarted)
        guard let store = await BackgroundPasses.installed(within: BackgroundPasses.installWaitSeconds) else {
            NotificationStartupTrace.mark(.storeWaitCompleted, succeeded: false)
            return
        }
        NotificationStartupTrace.mark(.storeWaitCompleted)
        if !entityID.isEmpty, let proto = press.proto() {
            await sendPresses([proto], core: store.notifyCore)
        }
        let matched = await store.answerNotification(id: id, verb: verb, pressID: press.pressID)
        NotificationStartupTrace.mark(.answerReturned, succeeded: matched)
        if matched { NotificationOutbox.remove(press.pressID) }
    }

    @MainActor static func launch(core: any ScreenCore) async {
        var launched = Centraid_Core_V1_NotifyLaunched()
        launched.pendingCap = pendingCap
        launched.zone = TimeZone.current.identifier
        launched.locale = Locale.current.identifier
        var notifyReq = Centraid_Core_V1_NotifyRequest()
        notifyReq.kind = .launched(launched)
        await applyNotify(notifyReq, core: core)
    }

    @MainActor static func askPermission(core: any ScreenCore) async {
        var notifyReq = Centraid_Core_V1_NotifyRequest()
        notifyReq.kind = .askPermission(Centraid_Core_V1_NotifyAskPermission())
        await applyNotify(notifyReq, core: core)
    }

    @MainActor static func sendPresses(_ items: [Centraid_Core_V1_NotifyPress], core: any ScreenCore) async {
        guard !items.isEmpty else { return }
        var presses = Centraid_Core_V1_NotifyPresses()
        presses.items = items
        var notifyReq = Centraid_Core_V1_NotifyRequest()
        notifyReq.kind = .presses(presses)
        await applyNotify(notifyReq, core: core)
    }

    @MainActor static func applyScheduleAndReport(_ set: Centraid_Core_V1_ScheduleNotifications, core: any ScreenCore) async {
        let scheduled = await schedule(set)
        var notifyReq = Centraid_Core_V1_NotifyRequest()
        notifyReq.kind = .scheduled(scheduled)
        var request = Centraid_Core_V1_Request()
        request.kind = .notify(notifyReq)
        _ = try? await core.call(request)
    }

    @MainActor private static func applyNotify(_ notifyReq: Centraid_Core_V1_NotifyRequest, core: any ScreenCore) async {
        var request = Centraid_Core_V1_Request()
        request.kind = .notify(notifyReq)
        guard let response = try? await core.call(request),
              case .notify(let answer)? = response.kind
        else { return }
        for result in answer.results {
            switch result.outcome {
            case .applied, .already, .expired:
                NotificationOutbox.remove(result.id)
            case .refused, .unspecified, .UNRECOGNIZED:
                break
            }
        }
        if answer.hasSchedule {
            await applyScheduleAndReport(answer.schedule, core: core)
        }
    }

    @MainActor static func drain(_ store: ScreenStore) async {
        let pending = NotificationOutbox.pending()
        let protoPresses = pending.filter { !$0.entityID.isEmpty }.compactMap { $0.proto() }
        if !protoPresses.isEmpty {
            await sendPresses(protoPresses, core: store.notifyCore)
        }
        for press in NotificationOutbox.pending() {
            guard let verb = Centraid_Core_V1_NotificationVerb(rawValue: press.verb) else {
                NotificationOutbox.remove(press.pressID)
                continue
            }
            if await store.answerNotification(id: press.notificationID, verb: verb, pressID: press.pressID) {
                NotificationOutbox.remove(press.pressID)
            }
        }
    }
}

/// THE CENTRE'S DELEGATE, SET AT LAUNCH (`CentraidAppDelegate`): it must exist before launch
/// finishes, or a notification that launched the app is never delivered.
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate, Sendable {
    static let shared = NotificationDelegate()

    /// A notification that fires while the app is in front still shows, with its sound.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping @Sendable (UNNotificationPresentationOptions) -> Void
    ) {
        NotificationHandoff.perform(answer: {}) {
            completionHandler([.banner, .list, .sound])
        }
    }

    /// A button or a tap. The response is not Sendable: only its two strings cross.
    /// Use the explicit callback: the async delegate bridge can complete on a cooperative
    /// executor after an await, while UIKit's foreground response completion requires main.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping @Sendable () -> Void
    ) {
        NotificationStartupTrace.mark(.callbackEntered)
        let id = response.notification.request.identifier
        let action = response.actionIdentifier
        let userInfo = response.notification.request.content.userInfo
        let entityID = userInfo["notification_entity_id"] as? String ?? ""
        let dateID = userInfo["notification_date_id"] as? String ?? ""
        let fieldID = userInfo["notification_field_id"] as? String ?? ""
        let openURL = userInfo["notification_open_url"] as? String ?? ""
        NotificationHandoff.perform(answer: {
            await Notifications.answered(
                id: id,
                action: action,
                entityID: entityID,
                dateID: dateID,
                fieldID: fieldID,
                openURL: openURL
            )
        }, completion: {
            NotificationStartupTrace.mark(.callbackCompleted)
            completionHandler()
        })
    }
}
/// Keep the OS callback alive through the answer and complete on main even after suspension.
/// The delegate can be called from a background queue; no notification object crosses it.
enum NotificationHandoff {
    @discardableResult
    static func perform(
        answer: @escaping @MainActor @Sendable () async -> Void,
        completion: @escaping @Sendable () -> Void
    ) -> Task<Void, Never> {
        Task { @MainActor in
            await answer()
            completion()
        }
    }
}
#endif
