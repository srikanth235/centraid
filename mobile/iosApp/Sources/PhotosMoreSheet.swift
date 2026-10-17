import SwiftUI

import CentraidShared

/// THE MORE SHEET, AND THE BACKUP DETAIL BEHIND IT.
///
/// `more` is a sheet and never a destination — the band caps at five and the
/// type system says so, because `SHEET_MORE` is a `PhotosGridState.Sheet` and
/// there is no `Destination` value it could be. Until now the `···` control
/// reduced correctly and drew nothing: `moreSheetEvent` moved the state and
/// neither shell read `state.sheet`, so it was a button that did nothing a
/// member could see.
///
/// **What Collections does not carry.** v0's sheet holds no row for a shelf
/// Collections already shows — that would be two doors, one hidden — and its
/// foot names what is actually behind this door
/// (`photos-band.ts`: "The rest of Photos is in Collections."). The tile size
/// is here since the header lost its menu (R-CHROME-3); never Search, never
/// the filter, and photo access stays in the grid's slot.
///
/// **WHERE THE BACKUP ROW LANDS IS NOT WHERE v0 SENT IT.** v0 deep-linked to a
/// FRAME screen, `Settings → BackupHealth`, and kept a link rather than a copy
/// because the policy it edits governs Docs' scans and Notes' attachments too.
/// There is no frame Settings in this shell — `Destination.Settings` is
/// declared and nothing renders it — so a row that pushed one would be a row
/// that goes nowhere. It opens `SHEET_BACKUP_DETAIL` instead, which the state
/// already declares, and which reports this device's own pass rather than
/// editing a policy that has no screen yet. The deep link comes back when the
/// frame screen does.
struct PhotosMoreSheet: View {
    @ObservedObject var shell: ShellModel
    let state: PhotosGridStateView

    var body: some View {
        // ONE CLAUSE ONLY in the foot. It said "Everything Photos can show."
        // over one row, and Photos has a dozen other surfaces — Places,
        // Memories, Duplicates, Trash, Archive, Favorites, Albums — every one of
        // them reached from Collections, so the claim was false as printed.
        OptionSheet(title: PhotosCopy.shared.PHOTOS_MORE_TITLE, status: PhotosCopy.shared.PHOTOS_MORE_FOOT) {
            SheetRow(iconKey: "Archive", label: PhotosCopy.shared.PHOTOS_CAMERA_ROLL, identifier: "photos.more.cameraRoll") {
                shell.send(screen: PhotosScreens.grid, event: state.sheetEvent(.backupDetail))
            }
            // THE TILE SIZE, A CHOICE AND NOT A HEADER MENU (R-CHROME-3): only
            // where a size acts on something on screen, which the machine says.
            if state.chrome.tileSizeOffered {
                SheetRow(iconKey: "Grid", label: state.chrome.tileSizeLabel, identifier: "photos.more.tileSize") {
                    shell.send(screen: PhotosScreens.grid, event: state.sheetEvent(.tileSize))
                }
            }
            // "FREE UP SPACE" — A STATEMENT, NOT A BUTTON (`KeepOriginals.kt`).
            // v0's row deleted originals whose copy elsewhere was proved.
            // An original is evictable only once a gateway has
            // acknowledged it (#1080 ruling 6), and the census that says
            // which is the machine's, so the row draws what `free_up`
            // says — the count, the size and why — and offers no verb.
            FreeUpSpaceRow(freeUp: state.freeUp)
        }
    }
}

/// THE ROW ITSELF: a title and the census's own line, spoken as one.
private struct FreeUpSpaceRow: View {
    @Environment(\.colorScheme) private var scheme
    let freeUp: Centraid_Screen_V1_FreeUpSpace

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            CentraidIconView(iconKey: "Gauge", tint: Theme.color("text", scheme), size: 18)
                .frame(width: 24, height: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(PhotosCopy.shared.PHOTOS_FREE_UP_TITLE)
                    .centraidType("body")
                    .foregroundStyle(Theme.color("text", scheme))
                Text(freeUp.meta)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                if !freeUp.reason.isEmpty {
                    Text(freeUp.reason)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                }
                // WHAT A PHOTO DELETED FOR GOOD COSTS THE BACKUP DEVICE
                // (#1080 F5), said once, with the row it is true beside.
                if freeUp.offered {
                    Text(PhotosCopy.shared.PHOTOS_FREE_UP_RETENTION_BODY)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("photos.more.freeUp")
    }
}

extension PhotosGridStateView {
    /// The root's words (`PhotosGridChrome`) — the More sheet reads "Tile
    /// size" and whether it is offered here.
    var chrome: Centraid_Screen_V1_PhotosGridChrome {
        ((try? Centraid_Screen_V1_PhotosGridState(serializedBytes: data)) ?? .init()).chrome
    }

    /// The More sheet's "Free up space" row, as the census last found it.
    /// Decoded here rather than in `StateViews.swift` so this sheet's one
    /// field does not grow the shared state view.
    var freeUp: Centraid_Screen_V1_FreeUpSpace {
        ((try? Centraid_Screen_V1_PhotosGridState(serializedBytes: data)) ?? .init()).freeUp
    }
}

/// WHAT THIS DEVICE'S CAMERA-ROLL IMPORT IS DOING, IN FULL.
///
/// The banner on the grid says the phase in one sentence, because that is what
/// a member glancing at their library needs. This says the rest — how many,
/// and why it is not moving — which is the screen someone opens when the one
/// sentence is not enough.
///
/// **An IMPORT, and only that** (#1080). It brings the camera roll into this
/// vault; it says nothing about a gateway, and it carries no transport row:
/// where a backup stands is the Backup screen's, read from `backup_status`,
/// and a gateway's copy is never claimed here.
struct PhotosBackupDetailSheet: View {
    @ObservedObject var shell: ShellModel
    let state: PhotosGridStateView

    var body: some View {
        SheetRoom(
            title: PhotosCopy.shared.PHOTOS_CAMERA_ROLL,
            status: state.backupIsRunning
                ? PhotosCopy.shared.PHOTOS_IMPORT_RUNNING
                : PhotosCopy.shared.PHOTOS_IMPORT_AUTO,
            // AN IMPORT ALREADY RUNNING HAS NOTHING TO START, so the ink button is
            // drawn greyed, not hidden.
            primary: SheetPrimary(label: PhotosCopy.shared.PHOTOS_IMPORT_NOW, enabled: !state.backupIsRunning) {
                shell.backUpCameraRoll()
            }
        ) {
            VStack(spacing: 0) {
                FieldRow(key: "Status", value: state.backupSentence)
                if !state.pausedReason.isEmpty {
                    // WHY IT IS NOT MOVING, and never inferred from a
                    // radio: the pass asks the platform for the real
                    // answer.
                    FieldRow(key: "Paused", value: state.pausedReason)
                }
            }
        }
    }
}
