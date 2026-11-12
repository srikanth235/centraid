import Foundation

/// WHAT THE SHELL DOES WITH A `ScheduleNotifications`, AS A PURE FUNCTION (#1188, A2/A8).
///
/// Rust decides which notifications exist and which delivered ones are still wanted; this is only the
/// bookkeeping of making the OS agree, so a test reads it with no notification centre. The Android
/// shell has the same function (`NotifyPlan.reconcile`) and both are tested against ONE fixture,
/// `contracts/notify/reconcile-cases.json`.
///
/// PENDING AND DELIVERED ARE SEPARATE. A pending request leaves when it is not scheduled again. A
/// delivered notification leaves only when its id is in neither the wanted set nor `live`, so time
/// passing never removes a reminder the member has not dealt with; resolving the item does.
enum NotificationPlan {
    struct Plan: Equatable {
        var removePending: [String]
        var removeDelivered: [String]
        /// The ids to add, in the set's order: every timed one still to come.
        var schedule: [Centraid_Core_V1_PendingNotification]
        /// The immediates (receipts) not already on the screen.
        var post: [Centraid_Core_V1_PendingNotification]

        static func == (lhs: Plan, rhs: Plan) -> Bool {
            lhs.removePending == rhs.removePending && lhs.removeDelivered == rhs.removeDelivered
                && lhs.schedule.map(\.notificationID) == rhs.schedule.map(\.notificationID)
                && lhs.post.map(\.notificationID) == rhs.post.map(\.notificationID)
        }
    }

    static func reconcile(
        wanted: [Centraid_Core_V1_PendingNotification],
        live: [String],
        pending: [String],
        delivered: [String],
        nowMs: Int64
    ) -> Plan {
        // THE LAST OF A REPEATED ID WINS, as a replace by id would.
        var order: [String] = []
        var latest: [String: Centraid_Core_V1_PendingNotification] = [:]
        for item in wanted {
            if latest[item.notificationID] == nil { order.append(item.notificationID) }
            latest[item.notificationID] = item
        }
        let items = order.compactMap { latest[$0] }
        let schedule = items.filter { !$0.immediate && $0.fireAtMs > nowMs }
        let scheduled = Set(schedule.map(\.notificationID))
        let keep = Set(order).union(live)
        return Plan(
            removePending: Array(Set(pending.filter { !scheduled.contains($0) })).sorted(),
            removeDelivered: Array(Set(delivered.filter { !keep.contains($0) })).sorted(),
            schedule: schedule,
            post: items.filter { $0.immediate && !delivered.contains($0.notificationID) }
        )
    }
}
