#if os(iOS)
import UIKit

/// THE TWO LAUNCH-TIME DUTIES A SwiftUI `App` CANNOT PERFORM ITSELF (#1080).
///
/// `handleEventsForBackgroundURLSession` exists only on the application
/// delegate. When the background uploads finish while Centraid is suspended or
/// gone, iOS relaunches it into the background, calls this with a completion
/// handler, and delivers the finished tasks to whichever session is recreated
/// under the same identifier. The handler is iOS's to get back once the
/// events are settled — `UploadSettlement` holds it and calls it after the
/// core has settled and chained the next batch, or after its cap.
///
/// It is also the earliest moment to RECONNECT the session at an ordinary
/// launch, which is what delivers tasks that finished while the app was not
/// running and lets `pending()` count what the OS is still holding.
@MainActor
final class CentraidAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        BackgroundUploader.shared.reconnect()
        return true
    }

    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        // ANOTHER SESSION'S EVENTS ARE NOT OURS TO HOLD. There is one session
        // (`BackgroundUploader.identifier`); anything else is answered at once.
        guard identifier == BackgroundUploader.identifier else {
            completionHandler()
            return
        }
        UploadSettlement.shared.awaitingFinish(completionHandler)
        BackgroundUploader.shared.reconnect()
        // THE VAULTS OPEN NOW, not when a scene connects: a background
        // relaunch may never connect one, and the settles need the core.
        _ = ShellModel.shared
    }
}
#endif
