import Foundation
import SwiftUI
import SwiftProtobuf

/// FACE REVIEW, IN SWIFTUI (#1029, photos port, lane L5).
///
/// ONE QUESTION AT A TIME. "Is this Ada?", three answers, and the next one —
/// which is the shape of the job rather than the shape of the data. v0 drew a
/// page of strangers with tick boxes and nobody finishes that; a member answers
/// faces the way they answer a doorbell.
///
/// `cursor` past the end is the WORKED-THROUGH screen, which is a real screen
/// and a congratulation, not an empty state apologising for having nothing to
/// show.
struct FaceReviewView: View {
    @Environment(\.colorScheme) private var scheme

    /// The encoded `FaceReviewState` the shared bridge published.
    let data: Data
    /// One encoded `FaceReviewEvent`, back to the same bridge.
    let onEvent: (Data) -> Void

    @State private var typedName = ""

    private var state: FaceReviewStateView { FaceReviewStateView(data: data) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                switch state.content {
                case .loading:
                    ProgressView()

                case let .denied(denied):
                    DeniedGate(denied)
                case let .failure(sentence, remedy):
                    ScreenFailureView(sentence: sentence, remedy: remedy)

                case let .data(screen):
                    if let candidate = state.current {
                        question(candidate, screen: screen)
                    } else if state.recognitionEnabled {
                        // THE QUEUE IS WORKED THROUGH. A real screen, and the
                        // outcome this queue exists to reach.
                        ScreenEmptyView(
                            sentence: "No faces waiting.",
                            remedy: "Centraid asks again when it finds someone new."
                        )
                    } else {
                        // A DIFFERENT EMPTY SCREEN WITH A DIFFERENT NEXT MOVE.
                        // A queue cannot fill while the plane is off, and
                        // congratulating a member on finishing a job that never
                        // started is the defect `PhotosPeopleData.EmptyReason`
                        // exists to prevent next door. The flag is only ever
                        // read after the policy leg answered — see the bridge.
                        ScreenEmptyView(
                            sentence: "Face recognition is off.",
                            remedy: "Turn it on in Settings and Centraid starts finding faces."
                        )
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentMargins(.horizontal, CentraidGeometry.pageMargin, for: .scrollContent)
        .navigationTitle("Faces")
    }

    @ViewBuilder
    private func question(
        _ candidate: Centraid_Screen_V1_FaceCandidate,
        screen: Centraid_Screen_V1_FaceReviewData
    ) -> some View {
        Text(state.position).centraidType("small")
            .foregroundStyle(Theme.color("textSoft", scheme))

        FaceCrop(candidate: candidate)

        // THE GUESS, AND HOW SURE IT IS — IN WORDS.
        //
        // Never a percentage: "87%" asks a member to calibrate a number they
        // have no scale for, and the decision in front of them is binary. The
        // words come from `FaceReviewMachine.confidenceWord`, so both shells
        // draw one table and not two.
        Text(state.prompt(for: candidate)).centraidType("body")

        // THE ANSWER THAT DID NOT TAKE, OVER THE QUESTION IT WAS ABOUT.
        //
        // The cursor has not moved — the member is still on the face they
        // answered — so this sentence sits with it and they can answer again.
        // Before `write_failure` existed the refusal was silent, and a member
        // who had answered a question would have had it dropped with no way to
        // know.
        if let sentence = state.writeFailure {
            Text(sentence)
                .centraidType("small")
                .foregroundStyle(Theme.color("danger", scheme))
                .accessibilityIdentifier("photos.faces.write-failure")
        }

        if state.naming {
            namePicker(candidate, screen: screen)
        } else {
            answers(candidate)
        }
    }

    /// THE THREE ANSWERS, AND THE ONE THAT IS NOT AN ANSWER.
    ///
    /// This IS someone; this is NOT the person proposed; keep this face and
    /// leave it unnamed. #712 added the third — "reviewed, deliberately left
    /// unnamed" — and without it a rejection had to be a DELETE, which left the
    /// enricher free to propose the same stranger again for ever.
    ///
    /// **SKIP WRITES NOTHING** (v0's `triageSkip`): the face goes to the back
    /// of the queue and is asked again once the member has been through the
    /// rest. It was a dismissal, which retired for good a face the member had
    /// only postponed.
    @ViewBuilder
    private func answers(_ candidate: Centraid_Screen_V1_FaceCandidate) -> some View {
        // THE PROPOSAL IS A ONE-TAP YES ONLY WHEN THERE IS ONE. A model with no
        // guess offers no shortcut rather than a button that means nothing.
        if !candidate.proposedPartyID.isEmpty, !candidate.proposedName.isEmpty {
            Button {
                onEvent(
                    FaceReviewStateView.confirmEvent(
                        region: candidate.regionID,
                        party: candidate.proposedPartyID
                    )
                )
            } label: {
                Label {
                    Text("Yes, this is \(candidate.proposedName)")
                } icon: {
                    CentraidIconView(iconKey: "CheckCircle", tint: Theme.color("text", scheme))
                }
            }
            .accessibilityIdentifier("photos.faces.confirm")
        }

        Button {
            typedName = ""
            onEvent(FaceReviewStateView.namingEvent(true))
        } label: {
            Label {
                Text(candidate.proposedName.isEmpty ? "Say who this is" : "Someone else")
            } icon: {
                CentraidIconView(iconKey: "UserPlus", tint: Theme.color("text", scheme))
            }
        }
        .accessibilityIdentifier("photos.faces.name")

        Button {
            onEvent(FaceReviewStateView.rejectEvent(region: candidate.regionID))
        } label: {
            Label {
                Text("Not this person")
            } icon: {
                CentraidIconView(iconKey: "XCircle", tint: Theme.color("text", scheme))
            }
        }
        .accessibilityIdentifier("photos.faces.reject")

        Button {
            onEvent(FaceReviewStateView.dismissEvent(region: candidate.regionID))
        } label: {
            Label {
                Text("Keep unnamed")
            } icon: {
                CentraidIconView(iconKey: "EyeOff", tint: Theme.color("text", scheme))
            }
        }
        .accessibilityIdentifier("photos.faces.dismiss")

        Button {
            onEvent(FaceReviewStateView.skipEvent(region: candidate.regionID))
        } label: {
            Label {
                Text("Skip for now")
            } icon: {
                CentraidIconView(iconKey: "Skip", tint: Theme.color("text", scheme))
            }
        }
        .accessibilityIdentifier("photos.faces.skip")
    }

    /// WHO IS THIS? The roster came with the page, so nothing is read here.
    ///
    /// **A NAME THE VAULT HAS NEVER HEARD IS TWO WRITES AND ONE TAP** (see
    /// `FaceReviewMachine`): "Add" creates the person, and the confirm follows
    /// the moment the vault hands back the new id. The picker stays open over
    /// the same face until then, with the typed name on it, so a create that
    /// fails loses nothing; v0 spent the other side of that trade and dropped
    /// the member's answer.
    @ViewBuilder
    private func namePicker(
        _ candidate: Centraid_Screen_V1_FaceCandidate,
        screen: Centraid_Screen_V1_FaceReviewData
    ) -> some View {
        HStack {
            TextField("New name", text: $typedName)
                .accessibilityIdentifier("photos.faces.new-name")
            Button("Add") {
                let trimmed = typedName.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return }
                onEvent(
                    FaceReviewStateView.confirmEvent(region: candidate.regionID, newName: trimmed)
                )
            }
        }

        ForEach(screen.knownPeople, id: \.partyID) { person in
            Button {
                onEvent(
                    FaceReviewStateView.confirmEvent(
                        region: candidate.regionID,
                        party: person.partyID
                    )
                )
            } label: {
                HStack(spacing: 8) {
                    CentraidIconView(iconKey: "person", tint: Theme.color("text", scheme))
                    Text(person.displayName).centraidType("body")
                    Spacer()
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("photos.faces.person.\(person.partyID)")
        }

        Button("Cancel") { onEvent(FaceReviewStateView.namingEvent(false)) }
    }
}

/// THE FACE, AS A BOX OVER THE ASSET'S OWN THUMBNAIL.
///
/// There is no per-face derivative in the vault and inventing one would be a
/// second copy of every photograph, so the crop is drawn rather than stored:
/// the box is FRACTIONS of the image, which is what lets it be drawn over
/// whatever size this view rendered at. Pixels would be wrong the moment the
/// thumbnail is not the original's size, which it never is.
///
/// **`thumbnail_path` IS ABSENT ON THIS BUILD.** The queue reads
/// `media_face_region` and `with_held_thumbnail` needs a `content_id` on the
/// table it is asked of — this one has none, and asking would be refused at
/// prepare rather than answered with an empty path. So the ground is a sentence
/// and the member is told what they are missing, rather than being shown an
/// empty rectangle with a box on it.
private struct FaceCrop: View {
    @Environment(\.colorScheme) private var scheme
    let candidate: Centraid_Screen_V1_FaceCandidate

    private var path: String? {
        candidate.hasThumbnailPath && !candidate.thumbnailPath.isEmpty
            ? candidate.thumbnailPath
            : nil
    }

    /// A BOX OF ZERO SIZE IS NO BOX. The read answers `(0,0,0,0)` for a bbox it
    /// could not read as fractions — a malformed one, or one stored in pixels,
    /// which cannot be converted without the asset's own width and height. The
    /// whole photograph is then drawn with no rectangle, which is a visible
    /// degradation rather than a confident rectangle in the wrong place.
    private var hasBox: Bool { candidate.boxWidth > 0 && candidate.boxHeight > 0 }

    var body: some View {
        GeometryReader { frame in
            ZStack(alignment: .topLeading) {
                if let path {
                    ContentImage(path: path)
                } else {
                    Text("This photograph is not on this device.")
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                        .padding(8)
                }
                if hasBox {
                    Rectangle()
                        .strokeBorder(Theme.color("accent", scheme), lineWidth: 2)
                        // CGFloat AND NOT Double. The box rides the wire as a
                        // `double` because a fraction is a fraction; SwiftUI's
                        // geometry is `CGFloat`, and Swift will not multiply the
                        // two — which is the compiler catching, for once, the
                        // unit confusion this field exists to prevent.
                        .frame(
                            width: frame.size.width * CGFloat(candidate.boxWidth),
                            height: frame.size.height * CGFloat(candidate.boxHeight)
                        )
                        .offset(
                            x: frame.size.width * CGFloat(candidate.boxX),
                            y: frame.size.height * CGFloat(candidate.boxY)
                        )
                }
            }
            .frame(width: frame.size.width, height: frame.size.height)
            .clipped()
        }
        .aspectRatio(1, contentMode: .fit)
        .frame(maxWidth: .infinity)
        .accessibilityLabel("A face in one of your photographs")
    }
}

/// The decoder, in this file rather than in the shared `StateViews.swift`.
struct FaceReviewStateView {
    let data: Data

    private var state: Centraid_Screen_V1_FaceReviewState {
        (try? Centraid_Screen_V1_FaceReviewState(serializedBytes: data)) ?? .init()
    }

    var content: ScreenContent<Centraid_Screen_V1_FaceReviewData> {
        switch state.content {
        case let .failure(failure):
            return .failure(failure.sentence, failure.remedy)
        case let .data(data):
            return .data(data)
        case let .loading(loading):
            return .loading(loading.firstLoad)
        case .none:
            return .loading(true)
        }
    }

    var naming: Bool { state.naming }

    /// Whether the recognition plane is on at all. Written by the bridge's
    /// policy leg, which refuses the screen rather than guessing — so `false`
    /// here means the vault said off, never "nobody asked".
    var recognitionEnabled: Bool { state.recognitionEnabled }

    /// The sentence a refused answer left, or nil.
    var writeFailure: String? {
        state.hasWriteFailure ? state.writeFailure.sentence : nil
    }

    /// The question the cursor is on, or nil when the queue is worked through.
    var current: Centraid_Screen_V1_FaceCandidate? {
        guard case let .data(data) = state.content else { return nil }
        let cursor = Int(state.cursor)
        guard cursor >= 0, cursor < data.candidates.count else { return nil }
        return data.candidates[cursor]
    }

    /// WHERE THE MEMBER IS, so a queue feels finite.
    ///
    /// The denominator is what THIS PAGE holds and the wording says so when
    /// there is more behind it: the read door has no `COUNT(*)`, so "3 of 60"
    /// over a page with a cursor behind it would be a total nobody counted.
    var position: String {
        guard case let .data(data) = state.content else { return "" }
        let shown = Int(state.cursor) + 1
        let total = data.candidates.count
        return data.hasNextCursor
            ? "\(shown) of at least \(total)"
            : "\(shown) of \(total)"
    }

    /// THE PROMPT, WITH THE MODEL'S CERTAINTY IN WORDS.
    ///
    /// The bands are `FaceReviewMachine.confidenceWord`'s and are not restated
    /// here — a second table is a second answer. An empty word means the row
    /// did not say how sure it was (`confidence` is NULL-able), and the prompt
    /// then simply asks.
    func prompt(for candidate: Centraid_Screen_V1_FaceCandidate) -> String {
        guard !candidate.proposedName.isEmpty else { return "Who is this?" }
        let word = confidenceWord(candidate.confidence)
        return word.isEmpty
            ? "Is this \(candidate.proposedName)?"
            : "This is \(word) \(candidate.proposedName)."
    }

    /// Mirrors `FaceReviewMachine.confidenceWord`; see its table for the bands
    /// and why the bottom one says nothing. Kept in step by hand, which is what
    /// a shared state message buys — the arrangement is per platform, the
    /// meaning is not.
    private func confidenceWord(_ confidence: Double) -> String {
        if confidence >= 0.90 { return "almost certainly" }
        if confidence >= 0.70 { return "probably" }
        if confidence >= 0.45 { return "possibly" }
        return ""
    }

    static func confirmEvent(region: String, party: String = "", newName: String = "") -> Data {
        var event = Centraid_Screen_V1_FaceReviewEvent()
        event.confirmed = .with {
            $0.regionID = region
            $0.partyID = party
            $0.newName = newName
        }
        return (try? event.serializedData()) ?? Data()
    }

    static func rejectEvent(region: String) -> Data {
        var event = Centraid_Screen_V1_FaceReviewEvent()
        event.rejected = .with { $0.regionID = region }
        return (try? event.serializedData()) ?? Data()
    }

    static func skipEvent(region: String) -> Data {
        var event = Centraid_Screen_V1_FaceReviewEvent()
        event.skipped = .with { $0.regionID = region }
        return (try? event.serializedData()) ?? Data()
    }

    static func dismissEvent(region: String) -> Data {
        var event = Centraid_Screen_V1_FaceReviewEvent()
        event.dismissed = .with { $0.regionID = region }
        return (try? event.serializedData()) ?? Data()
    }

    static func namingEvent(_ naming: Bool) -> Data {
        var event = Centraid_Screen_V1_FaceReviewEvent()
        event.naming = .with { $0.naming = naming }
        return (try? event.serializedData()) ?? Data()
    }

    static func openedEvent() -> Data {
        var event = Centraid_Screen_V1_FaceReviewEvent()
        event.opened = .init()
        return (try? event.serializedData()) ?? Data()
    }
}
