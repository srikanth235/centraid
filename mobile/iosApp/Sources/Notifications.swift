#if os(iOS)
import Foundation
import UserNotifications

/// THE NOTIFICATION PERFORMER (#1173, Agenda wave 1c): make the operating system hold exactly the
/// set Rust sent, and hand back what the member pressed.
///
/// Rust decides WHICH notifications exist, WHEN each fires and WHAT each says (`agenda.notify`);
/// this file only performs `ScheduleNotifications` and answers it under its `effect_id`
/// (`NotificationsScheduled`), and sends a tap or a button back as
/// `ShellFact.notificationAnswered`. It decides nothing and holds no word: the titles, bodies and
/// button labels all arrive from Rust.
///
/// THE SET IS DECLARATIVE: `all` is everything wanted pending. Whatever the OS holds (pending or
/// already delivered) that is not in it is removed; each item in it is added, and adding an
/// identifier that is already pending replaces it.
enum Notifications {
    /// The key the notification's id travels under in `userInfo`, besides the request identifier.
    private static let idKey = "notification_id"

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

        center.setNotificationCategories(Set(schedule.categories.map(category)))

        // THE DIFF: remove every id not wanted, pending and delivered alike.
        let wanted = Set(schedule.all.map(\.notificationID))
        let pending = await center.pendingNotificationRequests().map(\.identifier)
        let delivered = await center.deliveredNotifications().map { $0.request.identifier }
        let stale = Set(pending + delivered).subtracting(wanted)
        if !stale.isEmpty {
            center.removePendingNotificationRequests(withIdentifiers: Array(stale))
            center.removeDeliveredNotifications(withIdentifiers: Array(stale))
        }

        let now = Date()
        for item in schedule.all {
            guard let request = request(item, now: now) else { continue }
            try? await center.add(request)
        }
        answer.held = UInt32(await center.pendingNotificationRequests().count)
        return answer
    }

    private static func category(_ category: Centraid_Core_V1_NotificationCategory) -> UNNotificationCategory {
        // THE ACTION'S IDENTIFIER IS THE VERB'S NUMBER, sent back unchanged. No `.foreground`:
        // Done, Snooze, Tomorrow and Undo run in the background; the tap is the default action.
        let actions = category.actions.map { action in
            UNNotificationAction(identifier: String(action.verb.rawValue), title: action.label, options: [])
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
        content.userInfo = [idKey: item.notificationID]

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
    @MainActor static func answered(id: String, action: String) async {
        let verb: Centraid_Core_V1_NotificationVerb?
        if action == UNNotificationDefaultActionIdentifier {
            verb = .open
        } else {
            verb = Int(action).flatMap { Centraid_Core_V1_NotificationVerb(rawValue: $0) }
        }
        guard let verb else { return }
        _ = ShellModel.shared
        guard let store = await BackgroundPasses.installed(within: BackgroundPasses.installWaitSeconds) else { return }
        await store.answerNotification(id: id, verb: verb)
    }
}

/// THE CENTRE'S DELEGATE, SET AT LAUNCH (`CentraidAppDelegate`): it must exist before launch
/// finishes, or a notification that launched the app is never delivered.
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate, Sendable {
    static let shared = NotificationDelegate()

    /// A notification that fires while the app is in front still shows, with its sound.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    /// A button or a tap. The response is not Sendable: its two strings are what crosses.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let id = response.notification.request.identifier
        let action = response.actionIdentifier
        await Notifications.answered(id: id, action: action)
    }
}
#endif
