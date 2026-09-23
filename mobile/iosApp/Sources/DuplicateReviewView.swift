import Foundation
import SwiftProtobuf
import SwiftUI

/// ONE CLUSTER, AND THE DECISION THAT DELETES A MEMBER'S PHOTOGRAPHS
/// (#1029, photos port).
///
/// Three things this screen is arranged to keep apart, because getting any of
/// them wrong costs somebody their photographs:
///
/// 1. **NOTHING IS PICKED UNTIL THE MEMBER PICKS IT.** No row is ticked when
///    this opens, and the control that trashes the rest is disabled and SAYS
///    it is disabled until one is. A default here is the product choosing
///    which of a member's photographs to delete.
/// 2. **THE SUGGESTION IS A HINT ON A ROW, NEVER A TICKED BOX.** It is drawn as
///    a line of text beside the row it is about, in the soft colour, with its
///    reason — visibly a remark and not a state. The tick is the member's and
///    nothing else may draw one.
/// 3. **TRASH IS NOT PURGE.** The copies go where the member can get them back,
///    and the confirmation line says so. There is no permanent option on this
///    screen and its absence is the design, not an omission.
struct DuplicateReviewView: View {
    @Environment(\.colorScheme) private var scheme

    /// The encoded `DuplicateReviewState` the bridge published.
    let data: Data

    /// One encoded `DuplicateReviewEvent`, back to the bridge.
    let send: (Data) -> Void

    private var state: DuplicateReviewStateView { DuplicateReviewStateView(data: data) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                switch state.content {
                case .loading:
                    ProgressView()
                case let .failure(sentence, remedy):
                    ScreenFailureView(sentence: sentence, remedy: remedy)
                case let .data(cluster):
                    if cluster.members.isEmpty {
                        // NOT A FAILURE. An empty cluster is a real answer —
                        // the copies were trashed here or somewhere else — and
                        // the read that says so was refused by nobody.
                        ScreenEmptyView(
                            sentence: "There are no copies left in this set.",
                            remedy: "Anything trashed here is still in the trash."
                        )
                    } else {
                        header(cluster)
                        ForEach(cluster.members, id: \.assetID) { member in
                            DuplicateMemberRow(
                                member: member,
                                isKept: state.keepAssetIdentifier == member.assetID,
                                suggestionReason: cluster.suggestedKeepAssetID == member.assetID
                                    ? cluster.suggestionReason
                                    : ""
                            ) {
                                send(state.keepEvent(assetIdentifier: member.assetID))
                            }
                        }
                        resolve(cluster)
                    }
                }
                // A REFUSED RESOLVE SAYS SO, BESIDE THE LIST AND NEVER INSTEAD
                // OF IT.
                //
                // `write_failure` is its OWN field and not the `content`
                // oneof's `failure`: that slot is the READ's, and a denied
                // write put there would replace the copies with an error, so a
                // member whose resolve was refused would lose the list they
                // were resolving from. `NoteDraft.save_failure` is the same
                // field for the same reason.
                //
                // Silence here is the worst outcome this screen has — a
                // resolve is one command per copy, and some can commit while
                // others are refused. A member told nothing is left believing
                // a set was resolved while copies of their photograph are
                // still in it. The list has been re-read by the time this
                // appears, so the sentence sits over what is ACTUALLY still
                // there.
                //
                // OUTSIDE the switch, so it survives the case where the
                // re-read comes back with nothing left to show: a refusal that
                // only rendered beside members would vanish exactly when the
                // list it explains did.
                if let refusal = state.writeFailure {
                    ScreenFailureView(sentence: refusal.sentence, remedy: refusal.remedy)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentMargins(.horizontal, CentraidGeometry.pageMargin, for: .scrollContent)
        .navigationTitle("Duplicates")
    }

    @ViewBuilder
    private func header(_ cluster: Centraid_Screen_V1_DuplicateReviewData) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Pick the copy to keep.").centraidType("body")
            Text("The others go to the trash, where you can still get them back.")
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
            // WHAT WAS CHECKED, AND WHAT WAS NOT — SAID OUT LOUD EITHER WAY.
            //
            // `member_placed` answers "is this copy in an album", and until
            // `DuplicateReviewLeg` lands it is false on every row for want of
            // an answer rather than because there is one. **False is not a safe
            // default on a screen that deletes photographs** — silence would
            // let this screen quietly tell a member every copy is a stray,
            // about a photograph that may be in three albums — so
            // `placements_checked` is what decides which sentence appears, and
            // one of them always does.
            //
            // The favourite half is deliberately named as unchecked: a star is
            // a `core_tag` on the flags scheme's `starred` concept (#916), two
            // further reads, and a screen that said "checked" while meaning
            // "albums only" would be making the narrower claim in the broader
            // words.
            Label {
                Text(
                    cluster.placementsChecked
                        ? "Centraid checked which of these are in an album. "
                            + "Favourites are not checked here."
                        : "Centraid has not been able to check whether these are in an "
                            + "album or favourited."
                )
                .centraidType("small")
                .foregroundStyle(Theme.color("textSoft", scheme))
            } icon: {
                CentraidIconView(iconKey: "info", tint: Theme.color("textSoft", scheme))
            }
        }
    }

    /// The verb, and the sentence that says why it is not available yet.
    ///
    /// **A DISABLED CONTROL WITH NO EXPLANATION IS A BROKEN CONTROL.** The
    /// member has not picked a copy, which is the whole reason this cannot run,
    /// and a greyed button on its own is indistinguishable from an app that has
    /// stopped working.
    @ViewBuilder
    private func resolve(_ cluster: Centraid_Screen_V1_DuplicateReviewData) -> some View {
        let kept = state.keepAssetIdentifier
        // THE COUNT IS ONLY SAID ONCE THERE IS ONE. With nothing picked there
        // is no "other", and "Trash the other 0 copies" is a sentence about a
        // number the member has not produced yet.
        let doomed = kept.isEmpty ? 0 : cluster.members.count - 1
        VStack(alignment: .leading, spacing: 4) {
            Button {
                send(state.resolveEvent)
            } label: {
                Label {
                    Text(resolveLabel(doomed: doomed, picked: !kept.isEmpty))
                } icon: {
                    CentraidIconView(iconKey: "trash", tint: Theme.color("danger", scheme))
                }
            }
            .disabled(kept.isEmpty)
            .accessibilityIdentifier("photos.duplicate.resolve")
            if kept.isEmpty {
                Text("Choose the copy to keep first — nothing is trashed until you do.")
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
        }
        .padding(.top, 8)
    }

    /// The verb, worded for what the member has actually done.
    ///
    /// Nothing picked means there is no "other" yet, so the label carries no
    /// number — "Trash the other 0 copies" is a sentence about a figure the
    /// member has not produced.
    private func resolveLabel(doomed: Int, picked: Bool) -> String {
        guard picked else { return "Trash the other copies" }
        return doomed == 1 ? "Trash the other copy" : "Trash the other \(doomed) copies"
    }
}

/// ONE COPY, WITH WHAT DISTINGUISHES IT FROM ITS SIBLINGS.
///
/// The tick is the MEMBER'S pick and the hint is the suggestion, and they are
/// drawn by two different things on purpose: the tick comes from
/// `PhotoCellSquare`'s own `isSelected` overlay — the one cell renderer every
/// Photos surface uses — and the hint is a line of soft text under the facts.
/// A suggestion that borrowed the tick would be a pre-ticked box, and a
/// pre-ticked box on this screen is the product deciding what to delete.
private struct DuplicateMemberRow: View {
    @Environment(\.colorScheme) private var scheme
    let member: Centraid_Screen_V1_DuplicateMember
    let isKept: Bool
    /// Empty unless this row is the suggested one. See the type note above.
    let suggestionReason: String
    let onPick: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            // ONE CELL RENDERER, SHARED WITH EVERY OTHER PHOTOS SURFACE
            // (`PhotoCells.swift`). It takes a `PhotoCell`, so the member is
            // lowered into one — see `cell`.
            PhotoCellSquare(
                cell: cell,
                // WHICH OF THE TWO EMPTY-CELL SENTENCES THIS SCREEN CAN STAND
                // BEHIND. `thumbnail_pack_absent` is a fact about the byte
                // store and `DuplicateReviewData` does not carry one, so false
                // is the conservative answer: the member reads "no longer on
                // this device" rather than being told a pack is missing that
                // may be sitting there. `PhotosReads` makes the same call.
                packAbsent: false,
                isSelected: isKept
            )
            .frame(width: 72, height: 72)
            VStack(alignment: .leading, spacing: 2) {
                Text(dimensions).centraidType("bodyStrong")
                Text(captured)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                // SOMEBODY FILED THIS COPY, AND DELETING IT IS A DIFFERENT ACT.
                //
                // Drawn only when it is TRUE. False is the answer AND the
                // absence of one — `placements_checked` on the data is what
                // tells those apart, and the header says which — so a "not in
                // any album" line here would be the screen answering a question
                // it may not have asked.
                if member.memberPlaced {
                    Label {
                        Text("In an album")
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                    } icon: {
                        CentraidIconView(
                            iconKey: "album",
                            tint: Theme.color("textSoft", scheme)
                        )
                    }
                }
                if !suggestionReason.isEmpty {
                    Label {
                        Text(suggestionReason)
                            .centraidType("small")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                    } icon: {
                        CentraidIconView(
                            iconKey: "info",
                            tint: Theme.color("textSoft", scheme)
                        )
                    }
                }
            }
            Spacer(minLength: 8)
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: onPick)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            [
                dimensions,
                captured,
                member.memberPlaced ? "In an album" : "",
                suggestionReason,
                isKept ? "Keeping this copy" : "",
            ].filter { !$0.isEmpty }.joined(separator: ". ")
        )
        .accessibilityIdentifier("photos.duplicate.member.\(member.assetID)")
    }

    /// The square this screen draws, out of the member it was given.
    ///
    /// A LOWERING AND NOT A SECOND CELL TYPE. `PhotoCellsGrid` and
    /// `PhotoCellSquare` are the one renderer for every surface that draws
    /// photographs, and they take the wire's `PhotoCell`; a bespoke square here
    /// would be the fifth place the held derivation is spelled, which is how v0
    /// ended up with four that disagreed. Only what a square draws is carried
    /// over — the facts beside it are this row's job.
    private var cell: Centraid_Screen_V1_PhotoCell {
        var cell = Centraid_Screen_V1_PhotoCell()
        cell.assetID = member.assetID
        if member.hasThumbnailPath { cell.thumbnailPath = member.thumbnailPath }
        cell.capturedAt = member.capturedAt
        cell.held = member.held
        return cell
    }

    /// The pixel size, or nothing.
    ///
    /// `width` and `height` are nullable in the DDL and arrive as zero when the
    /// vault does not know them, and "0 × 0" reads as a broken file rather than
    /// as a missing fact.
    ///
    /// **THE BYTE SIZE IS NOT HERE, AND IT IS THE FACT A MEMBER MOST WANTS.**
    /// `DuplicateMember.byte_size` is `core_content_item.byte_size`, a second
    /// table this door cannot reach, so it arrives zero — and a view does not
    /// invent a phrase from a byte count either, which is what
    /// `PageQuery.with_document_size`'s own note refuses. Named in this lane's
    /// report.
    private var dimensions: String {
        let pixels = member.width > 0 && member.height > 0
            ? "\(member.width) × \(member.height)"
            : ""
        // THE PHRASE AND NEVER THE NUMBER, and the two facts joined only when
        // both are there. `byte_phrase` is empty while the size is unknown —
        // which is not "0 bytes" — and nothing here composes one from
        // `byte_size`, because a size is the vault's to spell.
        let size = member.bytePhrase
        return [pixels, size].filter { !$0.isEmpty }.joined(separator: " · ")
            .ifEmptyUse("This copy")
    }

    private var captured: String {
        member.capturedAt.isEmpty ? "No capture time on this copy" : member.capturedAt
    }
}

/// The decoder between `DuplicateReviewState`'s bytes and the view above.
///
/// Its own struct in its own file rather than an addition to `StateViews.swift`:
/// that file is shared by every screen and a port that appended to it would
/// have every lane editing one file.
struct DuplicateReviewStateView {
    let data: Data

    private var state: Centraid_Screen_V1_DuplicateReviewState {
        (try? Centraid_Screen_V1_DuplicateReviewState(serializedBytes: data)) ?? .init()
    }

    var content: ScreenContent<Centraid_Screen_V1_DuplicateReviewData> {
        switch state.content {
        case let .failure(failure):
            return .failure(failure.sentence, failure.remedy)
        case let .data(cluster):
            return .data(cluster)
        case let .loading(loading):
            return .loading(loading.firstLoad)
        case .none:
            return .loading(true)
        }
    }

    /// WHICH COPY THE MEMBER CHOSE, and empty until they have.
    ///
    /// Read straight off the state and never derived from the suggestion: the
    /// two are different facts and this is the one the Trash control is allowed
    /// to act on.
    var keepAssetIdentifier: String { state.keepAssetID }

    /// THE LAST RESOLVE'S REFUSAL, as a sentence and its remedy, or nil.
    ///
    /// A separate reading from [content] on purpose: a write that was refused
    /// has not changed what the read said, so this is drawn BESIDE the copies
    /// and never in place of them. `hasWriteFailure` rather than an emptiness
    /// check, because absence and an empty sentence are different answers and
    /// only one of them means "nothing was refused".
    var writeFailure: (sentence: String, remedy: String)? {
        guard state.hasWriteFailure else { return nil }
        return (state.writeFailure.sentence, state.writeFailure.remedy)
    }

    func keepEvent(assetIdentifier: String) -> Data {
        var event = Centraid_Screen_V1_DuplicateReviewEvent()
        event.keep = .with { $0.assetID = assetIdentifier }
        return Self.encoded(event)
    }

    /// Trash every copy but the kept one.
    ///
    /// The view disables the control until a copy is picked, and the reducer
    /// refuses the event anyway if one arrives without a pick
    /// (`DuplicateReviewMachine.resolve`). Two guards for one mistake, because
    /// the mistake is a member's photographs.
    var resolveEvent: Data {
        var event = Centraid_Screen_V1_DuplicateReviewEvent()
        event.resolve = .init()
        return Self.encoded(event)
    }

    /// The bytes that cross back into `CentraidShared`.
    ///
    /// A serialisation that throws yields EMPTY bytes rather than a crash, and
    /// the shared module decodes those as a message with no `kind` set, which
    /// every reducer's `else` branch answers with `Step(state)` — a tap that
    /// does nothing rather than a shell that dies on one.
    static func encoded(_ event: Centraid_Screen_V1_DuplicateReviewEvent) -> Data {
        (try? event.serializedData()) ?? Data()
    }
}


private extension String {
    /// A fallback for a joined line that came out empty.
    ///
    /// A row whose pixel size and byte size are both unknown still has to say
    /// something: a blank strong line over a capture time reads as a broken
    /// row rather than as a photograph nobody measured.
    func ifEmptyUse(_ fallback: String) -> String { isEmpty ? fallback : self }
}
