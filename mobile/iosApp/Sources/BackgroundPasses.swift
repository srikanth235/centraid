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
/// * **Resubmit at the start, at the end, and at every background entry.** A
///   `BGTaskRequest` is one-shot: a handler that does not ask for the next
///   window runs once in the life of an install, and one that asks only on
///   success stops for good the first time a laptop is off. The scene phase
///   calls [resubmitAll] on `.background` (#1080).
/// * **A cold background launch opens the vaults first.** iOS may launch the
///   app straight into a window with no scene; the handler touches
///   `ShellModel.shared`, which opens the core, and waits up to
///   [installWaitSeconds] for the shell to install [pass].
///
/// Nothing here decides what a pass IS — [pass] is installed by the shell, for
/// the same reason `SyncPass.install` exists on the Android half: the pass is
/// `commonMain`'s and a copy spelled in a platform file is a second answer.
enum BackgroundPasses {
    typealias Pass = @MainActor (TimeInterval) async -> Bool

    /// The short window: iOS grants a `BGAppRefreshTask` seconds, not minutes.
    ///
    /// These two identifiers are `IosBackgroundTasks.PERMITTED_IDENTIFIERS` in
    /// `mobile/shared/src/iosMain/.../PlatformServices.ios.kt` and the
    /// `BGTaskSchedulerPermittedIdentifiers` array in `project.yml`. One fact in
    /// three files; `BackgroundIdentifierSpec` compares all three.
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

    /// Fifteen minutes, the same floor `IosBackgroundTasks.EARLIEST_SECONDS`
    /// uses and the same one WorkManager enforces on the Android half.
    static let earliestSeconds: TimeInterval = 15 * 60

    /// THE PASS, INSTALLED BY THE SHELL once the session exists.
    ///
    /// Takes the deadline this window has in seconds and answers whether every
    /// held vault's spool was emptied — which is what `setTaskCompleted`
    /// takes. Nil before the shell has installed one.
    @MainActor static var pass: Pass? {
        didSet {
            guard let pass else { return }
            let waiting = waiters
            waiters.removeAll()
            waiting.values.forEach { $0.resume(returning: pass) }
        }
    }

    @MainActor private static var waiters: [UUID: CheckedContinuation<Pass?, Never>] = [:]

    /// Install both handlers. **Called once, at launch, before any submit.**
    static func register() {
        register(identifier: refreshIdentifier, budget: refreshBudgetSeconds)
        register(identifier: processingIdentifier, budget: processingBudgetSeconds)
    }

    /// Ask for the next window of BOTH kinds. The scene phase calls this on
    /// every `.background` (#1080), so leaving the app is what arms the night.
    static func resubmitAll() {
        resubmit(identifier: refreshIdentifier)
        resubmit(identifier: processingIdentifier)
    }

    private static func register(identifier: String, budget: TimeInterval) {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            run(task, identifier: identifier, budget: budget)
        }
    }

    private static func run(_ task: BGTask, identifier: String, budget: TimeInterval) {
        // THE NEXT WINDOW IS ASKED FOR FIRST as well as last. A pass that
        // crashes or is expired mid-pass has still asked, so the failure costs
        // one window rather than every window after it.
        resubmit(identifier: identifier)
        let completion = TaskCompletion(task)
        let work = Task { @MainActor in
            // A COLD BACKGROUND LAUNCH HAS NO SESSION YET: opening it is
            // `ShellModel`'s, and the pass is installed when it exists.
            _ = ShellModel.shared
            guard let pass = await installed(within: installWaitSeconds) else {
                // NOT A FAILURE TO CLAIM AS SUCCESS. `false` is the honest
                // answer: no pass ran in this window.
                completion.finish(false)
                return
            }
            let drained = await pass(budget)
            resubmit(identifier: identifier)
            completion.finish(drained)
        }
        // EXPIRATION IS iOS TAKING THE WINDOW BACK. Cancelling stops the pass
        // at its next part boundary — the spool never loses a sealed part, so
        // the next window resumes where this one stopped — and
        // `setTaskCompleted` is owed on this path too.
        task.expirationHandler = {
            work.cancel()
            completion.finish(false)
        }
    }

    /// The installed pass, now or within [seconds], or nil.
    @MainActor private static func installed(within seconds: TimeInterval) async -> Pass? {
        if let pass { return pass }
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

    /// Ask for the next window of the same kind.
    ///
    /// The request classes are not interchangeable: a refresh identifier takes a
    /// `BGAppRefreshTaskRequest` and a processing identifier takes a
    /// `BGProcessingTaskRequest`, and submitting the wrong class for an
    /// identifier is another exception.
    private static func resubmit(identifier: String) {
        let request: BGTaskRequest
        if identifier == processingIdentifier {
            let processing = BGProcessingTaskRequest(identifier: identifier)
            processing.requiresNetworkConnectivity = true
            // ON POWER (#1080): see the header. The same answer
            // `IosBackgroundTasks` submits at launch; the two must agree.
            processing.requiresExternalPower = true
            request = processing
        } else {
            request = BGAppRefreshTaskRequest(identifier: identifier)
        }
        request.earliestBeginDate = Date(timeIntervalSinceNow: earliestSeconds)
        // A REFUSAL IS NOT A CRASH. `submit` throws when Background App Refresh
        // is off, and that is a setting, not a bug: the member is already told
        // about it through `BackgroundTasks.Registration`.
        try? BGTaskScheduler.shared.submit(request)
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
