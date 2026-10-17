import Photos
// `presentLimitedLibraryPicker(from:)` IS DECLARED IN PhotosUI, not Photos,
// even though it hangs off `PHPhotoLibrary`. Without this import the call is a
// "has no member" error on a symbol the documentation puts on that class.
import PhotosUI
import SwiftUI

import CentraidShared

/// THE CAMERA-ROLL IMPORT'S OWN SURFACE (#1025 S6, D-1025-S7-75).
///
/// **An import, not the backup** (#1080). It brings the camera roll into this
/// vault and says so; where the backup to a gateway stands is Home's backup
/// line and the Backup screen (`BackupViews.swift`), read from
/// `backup_status`, and nothing here claims a gateway holds anything.
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
///   "Centraid imports the photos you selected" while offering no way to
///   select more would be a statement with no remedy attached.
/// * **"Import now"** — a pass, offered only over an EMPTY library the grant
///   can fill and with none already running. Over photographs, More's camera
///   roll sheet is the deliberate place to run one again.
///
/// **It speaks only when there is something to say or do** — a remedy, an
/// import moving, a wait — and which of those it is, and every word, is
/// `PhotosGridMachine`'s `import_banner`. Done or idle over a full library
/// draws nothing.
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

    /// THE BANNER, AS THE MACHINE DECIDED IT (`PhotosGridMachine.importBanner`):
    /// unset when there is nothing to say or do, so a library with photographs
    /// and an import that is done draws no line at all, and "Import now" is
    /// offered only over an empty library. This view decides none of it.
    private var banner: Centraid_Screen_V1_PhotosImportBanner? {
        let grid = (try? Centraid_Screen_V1_PhotosGridState(serializedBytes: shell.photosState)) ?? .init()
        return grid.hasImportBanner ? grid.importBanner : nil
    }

    var body: some View {
        if let banner {
            VStack(alignment: .leading, spacing: 4) {
                if !banner.sentence.isEmpty {
                    Text(banner.sentence)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("text", scheme))
                }
                if !banner.reason.isEmpty {
                    Text(banner.reason)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                }

                // THE VERBS ARE THE KIT'S LINK: `link` ink, 44 target, so the one
                // app does not speak in a blue the rulebook never emitted.
                HStack(spacing: 16) {
                    switch banner.remedy {
                    case .ask:
                        KitLink(label: banner.allowLabel) {
                            shell.send(screen: PhotosScreens.grid, event: state.permissionRequestEvent)
                        }
                    case .settings:
                        KitLink(label: banner.settingsLabel, identifier: "photos.backup.open-settings") { openSettings() }
                    case .manageSelection:
                        KitLink(label: banner.manageLabel) { presentLimitedPicker() }
                    case .unspecified, .UNRECOGNIZED:
                        EmptyView()
                    }
                    if banner.importNow {
                        KitLink(label: banner.importNowLabel, identifier: "photos.backup.import-now") {
                            shell.backUpCameraRoll()
                        }
                    }
                }
            }
            // Inset is owned by `PhotosGridView` (R-PHOTOS-2) — this banner does
            // not pad for the status bar or the navigation bar.
            .accessibilityElement(children: .contain)
            .accessibilityLabel(PhotosCopy.shared.PHOTOS_CAMERA_ROLL)
        }
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
