import Photos
// `presentLimitedLibraryPicker(from:)` IS DECLARED IN PhotosUI, not Photos,
// even though it hangs off `PHPhotoLibrary`. Without this import the call is a
// "has no member" error on a symbol the documentation puts on that class.
import PhotosUI
import SwiftUI

/// THE CAMERA-ROLL BACKUP'S OWN SURFACE (#1025 S6, D-1025-S7-75).
///
/// Its own file, and not a `VStack` inside `PhotosGridView`, because it is the
/// other PLANE on that screen: the grid reads the vault, this reads the camera
/// roll, and they have two permissions and two failure modes. The rule the whole
/// screen keeps is that a denied photo grant changes this view and never the
/// grid — which on iOS is the difference between a member seeing the library
/// they already own and a member seeing an empty screen with a Settings link.
///
/// ## The three things a member may do, and the three they may not
///
/// * **"Allow photo access"** — only when the grant is `notAsked`. A DENIED
///   grant cannot be re-prompted by any app on iOS; the system prompt is shown
///   once per install, and a button that called `requestAuthorization` again
///   would return `.denied` without drawing anything. So denied gets the
///   sentence and Settings, which `PhotosGridMachine` already words.
/// * **"Manage selection"** — only when the grant is `limited`, and it is
///   `presentLimitedLibraryPicker`, the member editing their own selection.
///   This is the honest half of calling `LIMITED` a first-class state: saying
///   "Centraid backs up the photos you selected" while offering no way to
///   select more would be a statement with no remedy attached.
/// * **"Back up now"** — a pass, when one is not already running.
///
/// **Nothing here blames the member.** Not "you denied access", not "you only
/// picked a few": every sentence says what Centraid does and what would change
/// it. The strings are the shell's copy source — `PhotosGridMachine.pausedReason`
/// for the grant and `CameraRoll` for the transfer rule — so the reducer and
/// the pass cannot tell a member two different things about one grant.
struct BackupStatus: View {
    @ObservedObject var shell: ShellModel
    let state: PhotosGridStateView

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(state.backupSentence)
            if !state.pausedReason.isEmpty {
                Text(state.pausedReason)
            }

            HStack {
                if state.canAskForPhotos {
                    Button("Allow photo access") {
                        shell.send(screen: "photos.grid", event: state.permissionRequestEvent)
                    }
                }
                if state.isLimitedSelection {
                    Button("Manage selection") { presentLimitedPicker() }
                }
                if !state.backupIsRunning {
                    Button("Back up now") { shell.backUpCameraRoll() }
                }
            }
        }
        // DRAWN CLEAR OF THE STATUS BAR, and this is a reachability fix rather
        // than a cosmetic one (#1025 S6). `PhotosGridView`'s body is a plain
        // `VStack` with no safe-area inset, so everything at the top of that
        // screen renders UNDER the clock and the Dynamic Island — and the
        // island does not just overlap the buttons, it EATS THEIR TOUCHES. On
        // the simulator "Back up now" was visible and completely unpressable:
        // three taps in a row reached nothing at all.
        //
        // The padding is here, on this view, and not on the screen's own stack:
        // the rest of that screen is another slice's this wave, and its band row
        // has the same overlap. That is filed in this umbrella's receipt rather
        // than fixed from here.
        .safeAreaPadding(.top)
        // AND CLEAR OF THE NAVIGATION BAR, which is a SECOND overlap and not
        // the same one. `PhotosGridView` is a `NavigationStack` destination
        // whose content is never inset for the bar, so the bar's own 44 pt
        // floats over the top of this screen — and, like the Dynamic Island
        // above, it does not merely cover the buttons, it takes their taps.
        // With only the safe-area inset, "Back up now" was drawn in the clear
        // and still swallowed by the bar's hit region.
        //
        // A CONSTANT HERE IS A COMPENSATION, NOT A DESIGN. The screen should
        // inset its own content once, for its band row and this alike; that
        // file is another slice's this wave, so the defect is filed in the
        // receipt and this is what makes this surface usable meanwhile.
        .padding(.top, 44)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Camera roll backup")
    }

    /// iOS's own selection editor.
    ///
    /// It needs a `UIViewController` to present from, which SwiftUI does not
    /// hand out — so the key window's root is found rather than threaded through
    /// the view tree. Nothing is presented when there is no window (a scene that
    /// has gone to the background between the tap and here), which is a
    /// no-op and not a crash.
    private func presentLimitedPicker() {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        guard let root = scene?.keyWindow?.rootViewController else { return }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: root)
    }
}
