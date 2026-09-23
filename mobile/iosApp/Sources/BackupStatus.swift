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
///   sentence, which `PhotosGridMachine` words, AND **"Open Settings"** — this
///   app's own page there, the one place the answer can change
///   (D-1025-S7-75). A sentence that names Settings with no way to reach it is
///   a remedy described and not offered.
/// * **"Manage selection"** — only when the grant is `limited`, and it is
///   `presentLimitedLibraryPicker`, the member editing their own selection.
///   This is the honest half of calling `LIMITED` a first-class state: saying
///   "Centraid backs up the photos you selected" while offering no way to
///   select more would be a statement with no remedy attached.
/// * **"Import now"** — a pass, when one is not already running.
///
/// **Nothing here blames the member.** Not "you denied access", not "you only
/// picked a few": every sentence says what Centraid does and what would change
/// it. The strings are the shell's copy source — `PhotosGridMachine.pausedReason`
/// for the grant and `CameraRoll` for the transfer rule — so the reducer and
/// the pass cannot tell a member two different things about one grant.
struct BackupStatus: View {
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme
    let state: PhotosGridStateView

    /// The grant, read off the same bytes `state` decodes. Only "is it
    /// denied" is asked of it here, and `PhotosGridStateView` — shared by every
    /// lane — does not answer that one.
    private var permission: Centraid_Screen_V1_MediaPermission {
        ((try? Centraid_Screen_V1_PhotosGridState(serializedBytes: shell.photosState))
            ?? .init()).permission
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(state.backupSentence)
                .centraidType("small")
                .foregroundStyle(Theme.color("text", scheme))
            if !state.pausedReason.isEmpty {
                Text(state.pausedReason)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }

            // THE VERBS ARE HOME'S LINK, not the system tint: `link` in the
            // `control` role, the way "All apps" is drawn, so the one app does
            // not speak in a blue the rulebook never emitted.
            HStack(spacing: 16) {
                if state.canAskForPhotos {
                    Button("Allow photo access") {
                        shell.send(screen: "photos.grid", event: state.permissionRequestEvent)
                    }
                }
                if permission == .denied {
                    Button("Open Settings") { openSettings() }
                        .accessibilityIdentifier("photos.backup.open-settings")
                }
                if state.isLimitedSelection {
                    Button("Manage selection") { presentLimitedPicker() }
                }
                if !state.backupIsRunning {
                    Button("Import now") { shell.backUpCameraRoll() }
                }
            }
            .centraidType("control")
            .tint(Theme.color("link", scheme))
            .buttonStyle(.borderless)
        }
        // Inset is owned by `PhotosGridView` (R-PHOTOS-2) — this banner does
        // not pad for the status bar or the navigation bar.
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Camera roll import")
    }

    /// This app's own page in Settings, where a denied grant is changed.
    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
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
