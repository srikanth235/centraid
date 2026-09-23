import Foundation
import SwiftProtobuf
import SwiftUI

/// The shelf of near-duplicate clusters, in SwiftUI (#1029, photos port).
///
/// A list of DECISIONS, not of photographs. Each row is one cluster and the row
/// is a way in to `photos.duplicate`, where the member sees the copies side by
/// side and picks the one that survives. Nothing on this screen deletes
/// anything: v0's shelf carried a selection bar with Trash on it
/// (`DuplicatesShelf.tsx:132-150`), so a member could bulk-trash copies from a
/// list that never showed them which copy was the biggest, the sharpest or the
/// one already in an album. The verb lives on the screen that shows the
/// differences.
struct DuplicatesView: View {
    @Environment(\.colorScheme) private var scheme

    /// The encoded `DuplicatesState` the bridge published.
    ///
    /// Bytes and not an object, for `PhotosBridge`'s reason: one schema, one
    /// fixture, no Objective-C bridging layer between the two shells.
    let data: Data

    /// One encoded `DuplicatesEvent`, back to the bridge.
    ///
    /// **THIS SCREEN SENDS NOTHING, AND THE PROPERTY STAYS.** `DuplicatesEvent`'s
    /// six arms are `Opened`, `NextPageRequested` and the four the runtime
    /// raises. `Opened` belongs to `ShellModel.opened(_:)` — one place tells a
    /// screen it is on screen, or a push issues two first reads — and there is
    /// no next page to request, because a continued page over the nullable
    /// `cluster_id` is refused by the door. A shelf of decisions with no verb
    /// of its own is the design, not an omission.
    let send: (Data) -> Void

    /// OPEN ONE CLUSTER, AS NAVIGATION AND NOT AS AN EVENT.
    ///
    /// `DuplicatesEvent` has no "cluster tapped" arm, and that is right: this
    /// screen's state does not change when a member walks into a cluster, so a
    /// reducer that was told would have nothing to do with the news. The shell
    /// owns the route; this hands it the id.
    var onOpenCluster: (String) -> Void = { _ in }

    private var state: DuplicatesStateView { DuplicatesStateView(data: data) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                switch state.content {
                case .loading:
                    ProgressView()
                case let .failure(sentence, remedy):
                    ScreenFailureView(sentence: sentence, remedy: remedy)
                case let .data(shelf):
                    if shelf.clusters.isEmpty {
                        // THE SAME EMPTY LIST, ONE BOOLEAN APART, AND ONLY ONE
                        // OF THEM MAY SAY "NONE".
                        //
                        // `photos-duplicates/scan-incomplete` and
                        // `photos-duplicates/scanned-and-clean` differ by
                        // exactly this flag, and a screen that only checked
                        // `clusters.isEmpty` draws both the same and is wrong
                        // about one of them: "No duplicates" over a pass that
                        // has not finished is a claim the vault has not earned,
                        // and a member who reads it stops looking.
                        if shelf.scanComplete {
                            ScreenEmptyView(
                                sentence: "No near-identical photographs in your library.",
                                remedy: "Centraid has looked through everything on this device."
                            )
                        } else {
                            ScreenEmptyView(
                                sentence: "Centraid has not finished looking for near-identical "
                                    + "photographs.",
                                remedy: "That is not the same as there being none — "
                                    + "nothing here has been ruled out yet."
                            )
                        }
                    } else {
                        Text(state.lede)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                        // WHAT THE WORK IS WORTH, WHEN THE READ CAN SAY IT.
                        //
                        // **The PHRASE and never the number.** A size is the
                        // vault's to spell — `format_byte_size` is `pub` in
                        // `crates/vault/src/page.rs` precisely so there is one
                        // of it, after a launcher row and a drive row
                        // disagreed about the same file — so this draws what
                        // arrived and composes nothing. Empty means UNKNOWN
                        // and not "0 bytes", which is why the absence draws no
                        // line at all rather than a zero.
                        //
                        // `total_capped` decides the wording: the door has no
                        // `COUNT(*)`, so a figure off a page that filled is a
                        // floor, and `DuplicatesReads` marks the total capped
                        // while it cannot measure it at all.
                        if !shelf.totalReclaimablePhrase.isEmpty {
                            Text(
                                shelf.totalCapped
                                    ? "At least \(shelf.totalReclaimablePhrase) to reclaim."
                                    : "\(shelf.totalReclaimablePhrase) to reclaim."
                            )
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                        }
                        if !shelf.scanComplete {
                            // THE SAME CAVEAT ABOVE A SHELF THAT DOES HAVE
                            // ROWS. A member who resolves everything here has
                            // not finished with their duplicates, and a screen
                            // that went quiet once it had something to show
                            // would only be honest while it was empty.
                            Label {
                                Text("Centraid is still looking; more sets may appear.")
                                    .centraidType("small")
                                    .foregroundStyle(Theme.color("textSoft", scheme))
                            } icon: {
                                CentraidIconView(
                                    iconKey: "info",
                                    tint: Theme.color("textSoft", scheme)
                                )
                            }
                        }
                        ForEach(shelf.clusters, id: \.clusterID) { cluster in
                            Button {
                                onOpenCluster(cluster.clusterID)
                            } label: {
                                DuplicateClusterRow(cluster: cluster)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("photos.duplicates.\(cluster.clusterID)")
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentMargins(.horizontal, CentraidGeometry.pageMargin, for: .scrollContent)
        .navigationTitle("Duplicates")
        // NO `.onAppear { opened }` HERE, and that is the house pattern:
        // `ShellModel.opened(_:)` is the ONE place a screen is told it is on
        // screen, because a view that opened itself as well would issue two
        // first reads for one push. [DuplicatesStateView.openedEvent] is what
        // that hand-off sends, and `DuplicatesBridge.opened()` is the Kotlin
        // side of it.
    }
}

/// ONE CLUSTER, AS A ROW.
///
/// The count and nothing else, because the count is the only fact this read can
/// state. `reclaimable_bytes` is the number the contract says the shelf is
/// ordered by, and `DuplicatesReads` cannot fill it —
/// `core_content_item.byte_size` is a second table and this door has one. So
/// the row draws NOTHING for zero rather than "0 bytes", and it does not
/// compute a phrase from a byte count either: **a size is formatted by the
/// vault, which knows the member's locale, and never in a view** — which is
/// what `PageQuery.with_document_size`'s own note says, in the words it was
/// written in after a launcher row and a drive row disagreed about how big one
/// file was.
private struct DuplicateClusterRow: View {
    @Environment(\.colorScheme) private var scheme
    let cluster: Centraid_Screen_V1_DuplicateCluster

    var body: some View {
        HStack(spacing: 10) {
            // ONE OF THE COPIES, SO THE ROW IS ABOUT A PHOTOGRAPH.
            //
            // `cover_thumbnail_path` is absent whenever the read could not
            // resolve one — `DuplicatesReads` cannot resolve any, because
            // `media_asset_phash` carries no `content_id` for the door's
            // thumbnail column to correlate on — and the `dupe` mark stands in.
            // It is a FALLBACK and not a placeholder box: a grey square would
            // say "this photograph failed to load" about a photograph nobody
            // asked for.
            if cluster.hasCoverThumbnailPath, !cluster.coverThumbnailPath.isEmpty {
                ContentImage(path: cluster.coverThumbnailPath)
                    .frame(width: 44, height: 44)
                    .clipped()
                    .accessibilityHidden(true)
            } else {
                CentraidIconView(iconKey: "dupe", tint: Theme.color("text", scheme), size: 20)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(headline).centraidType("bodyStrong")
                Text(subhead)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
            Spacer(minLength: 8)
            CentraidIconView(
                iconKey: "ChevronRight",
                tint: Theme.color("textSoft", scheme)
            )
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(headline). \(subhead)")
    }

    /// THE COUNT, AND "AT LEAST" WHENEVER IT IS A FLOOR.
    ///
    /// The door has no `COUNT(*)`, so a count off a page that filled is a
    /// floor — which `HomeState.ThingCount.capped` says the same way, and
    /// `HomeView` spells as "at least N things". This view honours the FLAG and
    /// does not assume: `DuplicatesReads` happens to avoid the cap rather than
    /// report it — a cluster the page edge cut is dropped whole rather than
    /// counted short — so today the flag is false and this says "4 copies" and
    /// means four. A view that hard-coded that would be a view that lies the
    /// day the read learns to walk.
    private var headline: String {
        let noun = cluster.memberCount == 1 ? "copy" : "near-identical copies"
        return cluster.memberCountCapped
            ? "At least \(cluster.memberCount) \(noun)"
            : "\(cluster.memberCount) \(noun)"
    }

    /// WHAT THIS ONE CARD WOULD GIVE BACK, or the invitation when nothing can
    /// say.
    ///
    /// The PHRASE and never the number, for the reason the shelf's total gives:
    /// a size is the vault's to spell and this composes nothing. An empty
    /// phrase is UNKNOWN — not "0 bytes" — so the row falls back to the line
    /// that is true whatever the size is.
    ///
    /// **`member_count_capped` IS THE RIGHT FLAG FOR A BYTE FLOOR HERE**, and
    /// it is not a conflation: a card has no `reclaimable_capped` of its own
    /// because it does not need one. The figure is summed over the members the
    /// read saw, so a count that is a floor makes the sum a floor by the same
    /// arithmetic and in the same rows.
    private var subhead: String {
        guard !cluster.reclaimablePhrase.isEmpty else { return "Pick the one to keep." }
        return cluster.memberCountCapped
            ? "At least \(cluster.reclaimablePhrase) to reclaim."
            : "\(cluster.reclaimablePhrase) to reclaim."
    }
}

/// The decoder between `DuplicatesState`'s bytes and the view above.
///
/// Its own struct in its own file rather than an addition to `StateViews.swift`:
/// that file is shared by every screen and a port that appended to it would
/// have every lane editing one file. The three-state read law survives the
/// language boundary as `ScreenContent`'s three cases — Swift's `Optional`
/// would collapse two of the three, exactly as Kotlin's nullable would.
struct DuplicatesStateView {
    let data: Data

    private var state: Centraid_Screen_V1_DuplicatesState {
        (try? Centraid_Screen_V1_DuplicatesState(serializedBytes: data)) ?? .init()
    }

    var content: ScreenContent<Centraid_Screen_V1_DuplicatesData> {
        switch state.content {
        case let .failure(failure):
            return .failure(failure.sentence, failure.remedy)
        case let .data(shelf):
            return .data(shelf)
        // `loading`, and the `nil` a message with no content set decodes to,
        // are the SAME screen — a state that has not read yet. Collapsing them
        // into an empty shelf is the fourth state the read law forbids, and on
        // THIS screen it would read as "you have no duplicates".
        case let .loading(loading):
            return .loading(loading.firstLoad)
        case .none:
            return .loading(true)
        }
    }

    /// How many sets there are to work through.
    ///
    /// It counts CLUSTERS and not photographs: the unit of work on this shelf
    /// is a decision, and "84 duplicate photos" would be a number a member
    /// cannot act on one of.
    var lede: String {
        let count = state.data.clusters.count
        return count == 1
            ? "1 set of near-identical photographs."
            : "\(count) sets of near-identical photographs."
    }

    var openedEvent: Data {
        var event = Centraid_Screen_V1_DuplicatesEvent()
        event.opened = .init()
        return Self.encoded(event)
    }

    /// The bytes that cross back into `CentraidShared`.
    ///
    /// A serialisation that throws yields EMPTY bytes rather than a crash, and
    /// the shared module decodes those as a message with no `kind` set, which
    /// every reducer's `else` branch answers with `Step(state)` — a tap that
    /// does nothing rather than a shell that dies on one.
    static func encoded(_ event: Centraid_Screen_V1_DuplicatesEvent) -> Data {
        (try? event.serializedData()) ?? Data()
    }
}
