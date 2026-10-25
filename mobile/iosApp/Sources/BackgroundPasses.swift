#if os(iOS)
import BackgroundTasks
import Foundation
import UIKit

/// THE TWO `BGTaskScheduler` WINDOWS, AND WHAT EACH ONE RUNS (#1029 W18-1;
/// #1080, the shells).
///
/// Bytes move while the app is suspended through the background `URLSession`
/// in `BackgroundUploads.swift` (#1080 ruling 2). These windows are the other
/// half: the work that needs this process — taking a snapshot, hashing and
/// sealing into the spool, settling what the OS reported, asking the core for
/// the next `handoff` batch.
///
/// | Identifier | Request | What it runs |
/// |---|---|---|
/// | `dev.centraid.upload-pass` | `BGProcessingTaskRequest`, network AND external power | the full pass: snapshot when due, prepare, settle, then hand the next batch to the OS |
/// | `dev.centraid.sync-pass` | `BGAppRefreshTaskRequest`, seconds | a short pass whose deadline leaves it time to settle and hand off, not to prepare much |
///
/// **On power, now** (#1080). The processing window used to ask for a network
/// and no charger, because the drain carried the bytes itself and a member who
/// never charged overnight would never have been backed up. The bytes are the
/// OS's to carry now, whenever the app is suspended; what is left for this
/// window is hashing and sealing, which is the battery cost, and iOS grants a
/// processing task on power far longer windows than one off it.
///
/// ## The rules a handler here keeps
///
/// * **Register at launch, before any submit.** iOS requires every handler to be
///   installed before the app finishes launching; a registration made later is
///   itself an exception. `CentraidApp.init()` calls [register].
/// * **`setTaskCompleted` on EVERY path, including expiration, exactly once.**
///   A task that ends without it is killed and its app is penalised in
///   scheduling, which is a backup that gets rarer every time it fails.
/// * **The next window is Rust's to ask for, on every path.** A
///   `BGTaskRequest` is one-shot: a handler that does not ask for the next
///   window runs once in the life of an install, and one that asks only on
///   success stops for good the first time a laptop is off. The pass scheduler
///   sends `ScheduleWindows` at launch, at every background entry, on a rule
///   change and at the end of every pass; [schedule] performs it.
/// * **A cold background launch opens the vaults first.** iOS may launch the
///   app straight into a window with no scene; the handler touches
///   `ShellModel.shared`, which opens the core, and waits up to
///   [installWaitSeconds] for the shell to set [store].
///
/// Nothing here decides what a pass IS or which windows exist: the pass
/// scheduler in Rust (`crates/screens/src/passes`) says which windows to keep
/// scheduled (`ScheduleWindows`, performed by [schedule]) and runs the pass a
/// granted window starts (`ShellFact.window`, sent by [run]); this file maps
/// them onto BGTaskScheduler and completes the task when Rust says the pass
/// ended (`PassWindowDone`).
enum BackgroundPasses {
    /// The short window: iOS grants a `BGAppRefreshTask` seconds, not minutes.
    ///
    /// These two identifiers are the `BGTaskSchedulerPermittedIdentifiers` array
    /// in `project.yml` too: one fact in two files, and a submit of an identifier
    /// the plist does not list terminates the app.
    static let refreshIdentifier = "dev.centraid.sync-pass"

    /// The long one: minutes, on power, with a network.
    static let processingIdentifier = "dev.centraid.upload-pass"

    /// What a refresh window is told it has. iOS documents ~30 seconds and
    /// expires the task itself; this is the budget the pass plans against, and
    /// the expiration handler is the truth.
    static let refreshBudgetSeconds: TimeInterval = 25

    /// What a processing window is told it has. iOS grants minutes and decides
    /// the real figure per device and per state of charge; the pass stops at
    /// whichever arrives first, this or the expiration handler.
    static let processingBudgetSeconds: TimeInterval = 8 * 60

    /// How long a window waits for a cold launch to open the vaults and
    /// install the pass before it completes honestly without one.
    static let installWaitSeconds: TimeInterval = 20

    /// Fifteen minutes, the floor WorkManager enforces on the Android half too.
    static let earliestSeconds: TimeInterval = 15 * 60

    /// THE SCREEN STORE, SET BY THE SHELL once the core exists: the road to the pass
    /// scheduler in Rust. Nil before it; a window that opens first waits a bounded
    /// time for it.
    @MainActor static var store: ScreenStore? {
        didSet {
            guard let store else { return }
            let waiting = waiters
            waiters.removeAll()
            waiting.values.forEach { $0.resume(returning: store) }
        }
    }

    @MainActor private static var waiters: [UUID: CheckedContinuation<ScreenStore?, Never>] = [:]

    /// WHETHER THE OS TOOK EVERY WINDOW RUST LAST ASKED FOR (`BackgroundProbe`): nil
    /// before the first `ScheduleWindows`, false when Background App Refresh refused one.
    @MainActor private(set) static var registered: Bool?

    /// Install both handlers. **Called once, at launch, before any submit.**
    static func register() {
        register(identifier: refreshIdentifier, budget: refreshBudgetSeconds)
        register(identifier: processingIdentifier, budget: processingBudgetSeconds)
    }

    /// Keep exactly the windows Rust asked for scheduled (`ScheduleWindows`), and answer which
    /// the OS took. A window that requires charging is a processing request (network and
    /// power); the others are app-refresh requests; a one-off has no earliest date.
    @MainActor static func schedule(_ windows: [Centraid_Core_V1_Window]) -> Centraid_Core_V1_WindowsScheduled {
        var answer = Centraid_Core_V1_WindowsScheduled()
        var refusals: [String] = []
        for window in windows {
            let identifier = window.requiresCharging || window.periodMinutes == 0
                ? processingIdentifier : refreshIdentifier
            if let refusal = submit(identifier: identifier, oneOff: window.periodMinutes == 0) {
                answer.refused.append(window.name)
                refusals.append("\(window.name): \(refusal)")
            } else {
                answer.taken.append(window.name)
            }
        }
        answer.refusal = refusals.joined(separator: "; ")
        registered = answer.refused.isEmpty
        return answer
    }

    private static func register(identifier: String, budget: TimeInterval) {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            run(task, identifier: identifier, budget: budget)
        }
    }

    private static func run(_ task: BGTask, identifier: String, budget: TimeInterval) {
        let completion = TaskCompletion(task)
        // The window's name, as Rust scheduled it: the processing request is the night shift.
        let name = identifier == processingIdentifier ? "centraid-night-shift" : "centraid-sync-pass"
        let work = Task { @MainActor in
            // A COLD BACKGROUND LAUNCH HAS NO SESSION YET: opening it is
            // `ShellModel`'s, and the store is set when the core exists.
            _ = ShellModel.shared
            guard let store = await installed(within: installWaitSeconds) else {
                // NOT A FAILURE TO CLAIM AS SUCCESS. `false` is the honest
                // answer: no pass ran in this window.
                completion.finish(false)
                return
            }
            // RUST RUNS THE PASS AND ASKS FOR THE NEXT WINDOW (`ScheduleWindows`) on every path.
            let drained = await store.windowGranted(name, budgetMs: UInt64(budget * 1000))
            completion.finish(drained)
        }
        // EXPIRATION IS iOS TAKING THE WINDOW BACK. Cancelling stops the pass
        // at its next part boundary — the spool never loses a sealed part, so
        // the next window resumes where this one stopped — and
        // `setTaskCompleted` is owed on this path too.
        task.expirationHandler = {
            work.cancel()
            Task { @MainActor in store?.windowExpired(name) }
            completion.finish(false)
        }
    }

    /// The store, now or within [seconds], or nil.
    @MainActor private static func installed(within seconds: TimeInterval) async -> ScreenStore? {
        if let store { return store }
        let ticket = UUID()
        return await withCheckedContinuation { continuation in
            waiters[ticket] = continuation
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
                MainActor.assumeIsolated {
                    waiters.removeValue(forKey: ticket)?.resume(returning: nil)
                }
            }
        }
    }

    /// Submit one window; the refusal's words, or nil when iOS took it.
    ///
    /// The request classes are not interchangeable: a refresh identifier takes a
    /// `BGAppRefreshTaskRequest` and a processing identifier takes a
    /// `BGProcessingTaskRequest`, and submitting the wrong class for an
    /// identifier is another exception.
    private static func submit(identifier: String, oneOff: Bool) -> String? {
        let request: BGTaskRequest
        if identifier == processingIdentifier {
            let processing = BGProcessingTaskRequest(identifier: identifier)
            processing.requiresNetworkConnectivity = true
            // ON POWER (#1080): see the header.
            processing.requiresExternalPower = true
            request = processing
        } else {
            request = BGAppRefreshTaskRequest(identifier: identifier)
        }
        // A ONE-OFF (a capture or an import) has no earliest date: iOS may run it as soon as it likes.
        if !oneOff { request.earliestBeginDate = Date(timeIntervalSinceNow: earliestSeconds) }
        // A REFUSAL IS NOT A CRASH. `submit` throws when Background App Refresh
        // is off, and that is a setting, not a bug: the member is told through
        // the registration Rust words (`WindowsScheduled`).
        do {
            try BGTaskScheduler.shared.submit(request)
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}

/// `setTaskCompleted`, EXACTLY ONCE. The pass's answer and the expiration can
/// both arrive, from two threads, and the second must be a no-op.
private final class TaskCompletion: @unchecked Sendable {
    private let task: BGTask
    private let lock = NSLock()
    private var done = false

    init(_ task: BGTask) {
        self.task = task
    }

    func finish(_ success: Bool) {
        lock.lock()
        defer { lock.unlock() }
        guard !done else { return }
        done = true
        task.setTaskCompleted(success: success)
    }
}

#endif
