import Foundation

/// WHAT THE CHECK PAGE DRAWS AND WHAT A TAP SENDS, as data (#1188, B13). The page reads these, and the one
/// fixture both shells are held to (`contracts/backup/check-controls.json`) reads them too, so this page and
/// the Compose one cannot drift apart: the same state shows the same selectors, in the same order, and the
/// same tap sends the same event.
enum BackupCheckControls {
    static let intro = "backup-check-intro"
    static let heading = "backup-check-heading"
    static let bar = "backup-check-bar"
    static let start = "backup-check-start"
    static let stop = "backup-check-stop"
    static let backUpNow = "backup-check-back-up-now"

    static func rowTag(_ gatewayID: String) -> String { "backup-check-row-\(gatewayID)" }

    /// The selector ids drawn for `state`, top to bottom.
    static func shown(_ state: Centraid_Core_V1_BackupCheckState) -> [String] {
        var tags = [intro]
        if !state.heading.isEmpty { tags.append(heading) }
        tags.append(contentsOf: state.rows.map { rowTag($0.gatewayID) })
        if !state.rows.isEmpty, state.running { tags.append(bar) }
        if let action = actionTag(state) { tags.append(action) }
        if !state.backUpNowLabel.isEmpty { tags.append(backUpNow) }
        return tags
    }

    /// The button's selector: Stop while a check runs, Start when one may begin, none otherwise.
    static func actionTag(_ state: Centraid_Core_V1_BackupCheckState) -> String? {
        if state.action == .none || state.actionLabel.isEmpty { return nil }
        return state.action == .stop ? stop : start
    }

    /// The event name a tap on `tag` sends.
    static func eventFor(_ tag: String) -> String? {
        switch tag {
        case start: return "start"
        case stop: return "stop"
        case backUpNow: return "back_up_now"
        default: return nil
        }
    }

    /// How a row's second line is inked.
    static func ink(_ tone: Centraid_Core_V1_BackupCheckTone) -> String {
        switch tone {
        case .bad: return "bad"
        case .ok: return "ok"
        default: return "quiet"
        }
    }
}
