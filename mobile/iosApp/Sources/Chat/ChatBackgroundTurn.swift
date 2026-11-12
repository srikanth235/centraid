import UIKit

/// A TURN THAT IS RUNNING WHEN THE APP GOES AWAY FINISHES IN THE TIME THE SYSTEM ALLOWS (#1188 C10),
/// or is stopped, which keeps the words it had and says "Stopped". The system's own grace is asked
/// for while a turn streams; when it runs out, the turn is stopped here instead of being killed
/// with the answer lost.
@MainActor
final class ChatBackgroundTurn {
    private var task: UIBackgroundTaskIdentifier = .invalid

    /// A turn started: ask the system for time. `onExpiry` stops the turn when the time is up.
    func begin(onExpiry: @escaping () -> Void) {
        guard task == .invalid else { return }
        task = UIApplication.shared.beginBackgroundTask(withName: "chat-turn") { [weak self] in
            onExpiry()
            self?.end()
        }
    }

    /// The turn ended (an answer, a stop, a failure): give the time back.
    func end() {
        guard task != .invalid else { return }
        UIApplication.shared.endBackgroundTask(task)
        task = .invalid
    }
}
