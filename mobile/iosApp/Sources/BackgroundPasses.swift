#if os(iOS)
import BackgroundTasks
import Foundation

/// THE HANDLERS `BGTaskScheduler` NEEDS, AND NOTHING ELSE (#1029 W18-1).
///
/// The scope amendment of 2026-09-21 ("Superseded — Background upload") is that
/// the phone drains its spool over iroh **in the foreground and inside the
/// `BGProcessingTask` window iOS grants**. There is no transfer while the app is
/// suspended. That makes the two things in this file load-bearing rather than
/// plumbing, and before it neither existed:
///
/// 1. **Nothing registered a handler for either identifier.**
///    `grep -rn 'forTaskWithIdentifier' mobile/iosApp/Sources` was empty, so
///    `IosBackgroundTasks.register()` submitted two task requests that iOS had
///    no launch handler for. A submit with no registered handler raises
///    `NSInternalInconsistencyException`: the app does not fail the task, it
///    **terminates**. Even a granted window had nothing to run.
/// 2. **`dev.centraid.upload-pass` was not declared in `project.yml`**, which is
///    the source `Resources/Info.plist` is generated from. Same exception, same
///    termination, on the first submit of a generated build.
///
/// ## The three rules a handler here keeps
///
/// * **Register at launch, before any submit.** iOS requires every handler to be
///   installed before `application(_:didFinishLaunchingWithOptions:)` returns;
///   a registration made later is itself an exception. `CentraidApp.init()` is
///   this app's launch, so [register] is called there and
///   `IosBackgroundTasks.register()` — which submits — runs after it.
/// * **`setTaskCompleted` on EVERY path, including expiration.** A task that
///   ends without it is killed and its app is penalised in scheduling, which is
///   a backup that gets rarer every time it fails.
/// * **Re-submit on completion.** A `BGTaskRequest` is one-shot. A handler that
///   does not schedule the next window runs exactly once in the life of an
///   install, which reads to a member as "it worked the first day".
///
/// Nothing here decides what a pass IS — [pass] is installed by the shell, for
/// the same reason `SyncPass.install` exists on the Android half: the pass is
/// `commonMain`'s and a copy spelled in a platform file is a second answer.
enum BackgroundPasses {

    /// The short window: iOS grants a `BGAppRefreshTask` seconds, not minutes.
    ///
    /// These two identifiers are `IosBackgroundTasks.PERMITTED_IDENTIFIERS` in
    /// `mobile/shared/src/iosMain/.../PlatformServices.ios.kt` and the
    /// `BGTaskSchedulerPermittedIdentifiers` array in `project.yml`. One fact in
    /// three files; `BackgroundIdentifierSpec` compares all three.
    static let refreshIdentifier = "dev.centraid.sync-pass"

    /// The long one, for draining a generation. `BGProcessingTask` is what iOS
    /// gives work that needs minutes.
    static let processingIdentifier = "dev.centraid.upload-pass"

    /// What a refresh window is told it has. iOS documents ~30 seconds and
    /// expires the task itself; this is the budget the pass plans against, and
    /// the expiration handler is the truth.
    static let refreshBudgetSeconds: TimeInterval = 25

    /// What a processing window is told it has. iOS grants minutes and decides
    /// the real figure per device and per state of charge; the pass stops at
    /// whichever arrives first, this or the expiration handler.
    static let processingBudgetSeconds: TimeInterval = 8 * 60

    /// THE DRAIN PASS, INSTALLED BY THE SHELL.
    ///
    /// Takes the deadline this window has in seconds and answers whether the
    /// spool was emptied. Nil before the shell has installed one — an app that
    /// has not finished launching has nothing to drain — and a window that finds
    /// it nil completes honestly rather than claiming a pass ran.
    static var pass: ((TimeInterval) async -> Bool)?

    /// Install both handlers. **Called once, at launch, before any submit.**
    static func register() {
        register(identifier: refreshIdentifier, budget: refreshBudgetSeconds)
        register(identifier: processingIdentifier, budget: processingBudgetSeconds)
    }

    private static func register(identifier: String, budget: TimeInterval) {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            run(task, identifier: identifier, budget: budget)
        }
    }

    private static func run(_ task: BGTask, identifier: String, budget: TimeInterval) {
        // THE NEXT WINDOW IS ASKED FOR FIRST, not last. A pass that crashes or
        // is expired mid-drain has still asked, so the failure costs one window
        // rather than every window after it.
        resubmit(identifier: identifier)
        guard let pass else {
            // NOT A FAILURE. `success: true` here would be a claim that a drain
            // happened; `false` is the honest answer and iOS reads it as work
            // that did not finish, which is exactly what it was.
            task.setTaskCompleted(success: false)
            return
        }
        let work = Task {
            let drained = await pass(budget)
            task.setTaskCompleted(success: drained)
        }
        // EXPIRATION IS iOS TAKING THE WINDOW BACK. Cancelling the work is what
        // stops the drain mid-object — the spool never loses a sealed object, so
        // the next window resumes from where this one stopped — and
        // `setTaskCompleted` is owed on this path too.
        task.expirationHandler = {
            work.cancel()
            task.setTaskCompleted(success: false)
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
            // A NETWORK, NOT A CHARGER. A member who never charges overnight is
            // the member most likely to lose a phone.
            processing.requiresNetworkConnectivity = true
            processing.requiresExternalPower = false
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

    /// Fifteen minutes, the same floor `IosBackgroundTasks.EARLIEST_SECONDS`
    /// uses and the same one WorkManager enforces on the Android half.
    private static let earliestSeconds: TimeInterval = 15 * 60
}

#endif
