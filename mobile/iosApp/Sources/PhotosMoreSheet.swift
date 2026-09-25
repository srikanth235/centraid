import SwiftUI

/// THE MORE SHEET, AND THE BACKUP DETAIL BEHIND IT.
///
/// `more` is a sheet and never a destination — the band caps at five and the
/// type system says so, because `SHEET_MORE` is a `PhotosGridState.Sheet` and
/// there is no `Destination` value it could be. Until now the `···` control
/// reduced correctly and drew nothing: `moreSheetEvent` moved the state and
/// neither shell read `state.sheet`, so it was a button that did nothing a
/// member could see.
///
/// **ONE ROW.** v0's sheet carries only what Collections does not — a row for a
/// shelf Collections already shows would be two doors, one hidden — and its
/// foot names what is actually behind this door
/// (`photos-band.ts`: "The rest of Photos is in Collections."). Tile size
/// belongs to the Library's own header menu and photo access to the grid's
/// slot; neither is here.
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
    @Environment(\.colorScheme) private var scheme
    @ObservedObject var shell: ShellModel
    let state: PhotosGridStateView

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        shell.send(screen: "photos.grid", event: state.sheetEvent(.backupDetail))
                    } label: {
                        Label {
                            // A ROW THAT OPENS A PAGE READS AS TEXT, not as the
                            // system tint: the rulebook emits no such blue.
                            Text("Camera roll").centraidType("body")
                                .foregroundStyle(Theme.color("text", scheme))
                        } icon: {
                            CentraidIconView(iconKey: "Archive", tint: Theme.color("text", scheme))
                        }
                    }
                } footer: {
                    // ONE CLAUSE ONLY. It said "Everything Photos can show."
                    // over one row, and Photos has a dozen other surfaces —
                    // People, Places, Memories, Duplicates, Trash, Archive,
                    // Favorites, Albums — every one of them reached from
                    // Collections, so the claim was false as printed.
                    Text("The rest of Photos is in Collections.").centraidType("small")
                }
                // "FREE UP SPACE" — A STATEMENT, NOT A BUTTON (`KeepOriginals.kt`).
                // v0's row deleted originals whose copy elsewhere was proved;
                // the laptop's backup does not hold originals yet, so every
                // one here is the only copy, and the row says so with the
                // count and the size rather than offering a verb that could
                // only destroy a photograph.
                Section {
                    FreeUpSpaceRow(freeUp: state.freeUp)
                } footer: {
                    if !state.freeUp.reason.isEmpty {
                        Text(state.freeUp.reason).centraidType("small")
                    }
                }
            }
            .navigationTitle("More in Photos")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        shell.send(screen: "photos.grid", event: state.sheetEvent(.none))
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

/// THE ROW ITSELF: a title and the census's own line, spoken as one.
private struct FreeUpSpaceRow: View {
    @Environment(\.colorScheme) private var scheme
    let freeUp: Centraid_Screen_V1_FreeUpSpace

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text("Free up space").centraidType("body")
                Text(freeUp.meta)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
        } icon: {
            CentraidIconView(iconKey: "Gauge", tint: Theme.color("text", scheme))
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("photos.more.freeUp")
    }
}

extension PhotosGridStateView {
    /// The More sheet's "Free up space" row, as the census last found it.
    /// Decoded here rather than in `StateViews.swift` so this sheet's one
    /// field does not grow the shared state view.
    var freeUp: Centraid_Screen_V1_FreeUpSpace {
        ((try? Centraid_Screen_V1_PhotosGridState(serializedBytes: data)) ?? .init()).freeUp
    }
}

/// WHAT THIS DEVICE'S CAMERA-ROLL PASS IS DOING, IN FULL.
///
/// The banner on the grid says the phase in one sentence, because that is what
/// a member glancing at their library needs. This says the rest — how many, how
/// many bytes, over which transport, and why it is not moving — which is the
/// screen someone opens when the one sentence is not enough.
///
/// **`transport` is reported and never claimed.** Which transport the product
/// ships is decided by the overnight experiment in
/// `mobile/maestro/ios-transfer-experiment.md`, and until that has run this is
/// what a diagnostics surface reports rather than a sentence in a document.
struct PhotosBackupDetailSheet: View {
    @ObservedObject var shell: ShellModel
    @Environment(\.colorScheme) private var scheme
    let state: PhotosGridStateView

    var body: some View {
        NavigationStack {
            List {
                Section("This device") {
                    LabeledContent("Status", value: state.backupSentence)
                    if !state.pausedReason.isEmpty {
                        // WHY IT IS NOT MOVING, and never inferred from a
                        // radio: the pass asks the platform for the real
                        // answer.
                        LabeledContent("Paused", value: state.pausedReason)
                    }
                    LabeledContent("Transport", value: state.backupTransport)
                }
                Section {
                    Button("Import now") { shell.backUpCameraRoll() }
                        .centraidType("control")
                        .tint(Theme.color("link", scheme))
                        .disabled(state.backupIsRunning)
                } footer: {
                    Text(
                        state.backupIsRunning
                            ? "A pass is already running."
                            : "Centraid also imports on its own, on Wi-Fi and on a charger."
                    )
                    .centraidType("small")
                }
            }
            .navigationTitle("Camera roll")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        shell.send(screen: "photos.grid", event: state.sheetEvent(.none))
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }
}
