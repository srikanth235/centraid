import UIKit

/// THE SWIPE IN FROM THE LEADING EDGE GOES BACK ON EVERY PUSHED PAGE (#1202).
///
/// Every page draws its own back chevron and hides the system's (`navigationBarBackButtonHidden`),
/// and UIKit turns the interactive pop gesture off with the system button: Settings, a task, a
/// note, a person, an earlier version each ignored a swipe back. The gesture's delegate is the
/// navigation controller itself, which lets it begin whenever there is a page to go back to.
/// An app root (one page on the stack) answers false, so its own `EdgeSwipeHome` stays the only
/// edge gesture there.
extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        Self.popMayBegin(depth: viewControllers.count)
    }

    /// Whether the edge swipe may start: only with a page beneath this one.
    static func popMayBegin(depth: Int) -> Bool { depth > 1 }
}
