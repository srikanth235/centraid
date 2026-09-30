package dev.centraid.android.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.screen.v1.FaceCandidate
import centraid.screen.v1.FaceReviewData
import centraid.screen.v1.FaceReviewEvent
import centraid.screen.v1.FaceReviewState
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ContentImage
import dev.centraid.android.kit.ScreenEmpty
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.shared.apps.photos.FaceReviewMachine

/**
 * FACE REVIEW — a QUEUE of questions, worked one at a time (#1029, photos port,
 * lane L5).
 *
 * "Is this Ada?", three answers, and the next one. v0 drew a page of strangers
 * with tick boxes and nobody finishes that; a member answers faces the way they
 * answer a doorbell.
 *
 * `cursor` past the end is the WORKED-THROUGH screen, which is a real screen
 * and a congratulation — not an empty state apologising for having nothing to
 * show.
 *
 * The SwiftUI twin is `mobile/iosApp/Sources/FaceReviewView.swift`.
 */
@Composable
public fun FaceReviewScreen(
    state: FaceReviewState,
    onEvent: (FaceReviewEvent) -> Unit,
) {
    // A WIRE PROPERTY IS CROSS-MODULE PUBLIC API, so Kotlin will not smart-cast
    // it after a null check.
    val loading = state.loading
    val failure = state.failure
    val data = state.data_
    // SCROLLABLE, LIKE THE SWIFTUI TWIN. A square crop plus four answers plus a
    // roster is taller than a phone, and a column that cannot scroll puts the
    // last answer under the bezel — which is R-PHOTOS-2's finding on the grid,
    // where nineteen photographs sat in a view that could not reach them.
    Column(
        modifier = Modifier
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        when {
            loading != null -> CircularProgressIndicator()

            failure != null -> ScreenFailure(failure.sentence, failure.remedy)

            data != null -> {
                val candidate = FaceReviewMachine.current(state)
                if (candidate == null) {
                    // TWO EMPTY SCREENS WITH TWO NEXT MOVES. A queue cannot
                    // fill while the plane is off, and congratulating a member
                    // on finishing a job that never started is the defect
                    // `PhotosPeopleData.EmptyReason` exists to prevent next
                    // door. `recognition_enabled` is only ever read after the
                    // bridge's policy leg answered — it refuses the screen
                    // rather than guessing — so `false` means the vault said
                    // off, never "nobody asked".
                    if (state.recognition_enabled) {
                        ScreenEmpty(
                            sentence = "No faces waiting.",
                            remedy = "Centraid asks again when it finds someone new.",
                        )
                    } else {
                        ScreenEmpty(
                            sentence = "Face recognition is off.",
                            remedy = "Turn it on in Settings and Centraid starts finding faces.",
                        )
                    }
                } else {
                    Question(state, data, candidate, onEvent)
                }
            }
        }
    }
}

@Composable
private fun Question(
    state: FaceReviewState,
    data: FaceReviewData,
    candidate: FaceCandidate,
    onEvent: (FaceReviewEvent) -> Unit,
) {
    Text(
        text = position(state, data),
        style = centraidType("small"),
        color = centraidColor("textSoft"),
    )
    FaceCrop(candidate)
    // THE GUESS, AND HOW SURE IT IS — IN WORDS. Never a percentage: "87%" asks
    // a member to calibrate a number they have no scale for, and the decision
    // in front of them is binary. The word is the shared machine's, so both
    // shells draw one table and not two.
    Text(text = prompt(candidate), style = centraidType("body"), color = centraidColor("text"))
    // THE ANSWER THAT DID NOT TAKE, OVER THE QUESTION IT WAS ABOUT.
    //
    // The cursor has not moved — the member is still on the face they answered
    // — so the sentence sits with it and they can answer again. Before
    // `write_failure` existed the refusal was silent, and a member who had
    // answered a question would have had it dropped with no way to know.
    val writeFailure = state.write_failure
    if (writeFailure != null) {
        Text(
            text = writeFailure.sentence,
            style = centraidType("small"),
            color = centraidColor("danger"),
        )
    }
    if (state.naming) {
        NamePicker(data, candidate, onEvent)
    } else {
        Answers(candidate, onEvent)
    }
}

/**
 * THE THREE ANSWERS, AND THE ONE THAT IS NOT AN ANSWER.
 *
 * This IS someone; this is NOT the person proposed; keep this face and leave
 * it unnamed. #712 added the third — "reviewed, deliberately left unnamed" —
 * and without it a rejection had to be a DELETE, which left the enricher free
 * to propose the same stranger again for ever.
 *
 * **SKIP WRITES NOTHING** (v0's `triageSkip`): the face goes to the back of the
 * queue and is asked again once the member has been through the rest. It was a
 * dismissal, which retired for good a face the member had only postponed.
 */
@Composable
private fun Answers(candidate: FaceCandidate, onEvent: (FaceReviewEvent) -> Unit) {
    // THE PROPOSAL IS A ONE-TAP YES ONLY WHEN THERE IS ONE. A model with no
    // guess offers no shortcut rather than a button that means nothing.
    if (candidate.proposed_party_id.isNotEmpty() && candidate.proposed_name.isNotEmpty()) {
        AnswerButton("CheckCircle", "Yes, this is ${candidate.proposed_name}") {
            onEvent(
                FaceReviewEvent(
                    confirmed = FaceReviewEvent.Confirmed(
                        region_id = candidate.region_id,
                        party_id = candidate.proposed_party_id,
                    ),
                ),
            )
        }
    }
    AnswerButton(
        "UserPlus",
        if (candidate.proposed_name.isEmpty()) "Say who this is" else "Someone else",
    ) {
        onEvent(FaceReviewEvent(naming = FaceReviewEvent.NamingChanged(naming = true)))
    }
    AnswerButton("XCircle", "Not this person") {
        onEvent(
            FaceReviewEvent(rejected = FaceReviewEvent.Rejected(region_id = candidate.region_id)),
        )
    }
    AnswerButton("EyeOff", "Keep unnamed") {
        onEvent(
            FaceReviewEvent(dismissed = FaceReviewEvent.Dismissed(region_id = candidate.region_id)),
        )
    }
    AnswerButton("Skip", "Skip for now") {
        onEvent(
            FaceReviewEvent(skipped = FaceReviewEvent.Skipped(region_id = candidate.region_id)),
        )
    }
}

@Composable
private fun AnswerButton(iconKey: String, label: String, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CentraidIcon(iconKey = iconKey, tint = centraidColor("text"), size = 16.dp)
            Text(text = label, style = centraidType("control"), color = centraidColor("text"))
        }
    }
}

/**
 * WHO IS THIS? The roster came with the page, so nothing is read here.
 *
 * **A NAME THE VAULT HAS NEVER HEARD IS TWO WRITES AND ONE TAP** (see
 * [FaceReviewMachine]): "Add" creates the person, and the confirm follows the
 * moment the vault hands back the new id. The picker stays open over the same
 * face until then, with the typed name on it, so a create that fails loses
 * nothing; v0 spent the other side of that trade and dropped the member's
 * answer.
 */
@Composable
private fun NamePicker(
    data: FaceReviewData,
    candidate: FaceCandidate,
    onEvent: (FaceReviewEvent) -> Unit,
) {
    var typed by remember(candidate.region_id) { mutableStateOf("") }
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OutlinedTextField(
            value = typed,
            onValueChange = { typed = it },
            modifier = Modifier.weight(1f),
            label = { Text(text = "New name") },
        )
        TextButton(
            onClick = {
                val trimmed = typed.trim()
                if (trimmed.isNotEmpty()) {
                    onEvent(
                        FaceReviewEvent(
                            confirmed = FaceReviewEvent.Confirmed(
                                region_id = candidate.region_id,
                                new_name = trimmed,
                            ),
                        ),
                    )
                }
            },
        ) { Text(text = "Add") }
    }
    data.known_people.forEach { person ->
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable {
                    onEvent(
                        FaceReviewEvent(
                            confirmed = FaceReviewEvent.Confirmed(
                                region_id = candidate.region_id,
                                party_id = person.party_id,
                            ),
                        ),
                    )
                }
                .padding(vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CentraidIcon(iconKey = "person", tint = centraidColor("text"), size = 16.dp)
            Text(
                text = person.display_name,
                style = centraidType("body"),
                color = centraidColor("text"),
            )
        }
    }
    TextButton(
        onClick = {
            onEvent(FaceReviewEvent(naming = FaceReviewEvent.NamingChanged(naming = false)))
        },
    ) { Text(text = "Cancel") }
}

/**
 * THE FACE, AS A BOX OVER THE ASSET'S OWN THUMBNAIL.
 *
 * There is no per-face derivative in the vault and inventing one would be a
 * second copy of every photograph, so the crop is DRAWN rather than stored: the
 * box is FRACTIONS of the image, which is what lets it be drawn over whatever
 * size this composable rendered at. Pixels would be wrong the moment the
 * thumbnail is not the original's size, which it never is.
 *
 * **`thumbnail_path` IS ABSENT ON THIS BUILD.** The queue reads
 * `media_face_region` and `with_held_thumbnail` needs a `content_id` on the
 * table it is asked of — this one has none, and asking would be refused at
 * prepare rather than answered with an empty path. So the ground is a sentence:
 * the member is told what they are missing rather than shown an empty rectangle
 * with a box on it.
 *
 * A BOX OF ZERO SIZE IS NO BOX. The read answers `(0,0,0,0)` for a bbox it
 * could not read as fractions — malformed, or stored in pixels, which cannot be
 * converted without the asset's own width and height. The whole photograph is
 * then drawn with no rectangle, which is a visible degradation rather than a
 * confident rectangle in the wrong place.
 */
@Composable
private fun FaceCrop(candidate: FaceCandidate) {
    BoxWithConstraints(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .clip(RectangleShape)
            .semantics { contentDescription = "A face in one of your photographs" },
    ) {
        val path = candidate.thumbnail_path
        if (!path.isNullOrEmpty()) {
            ContentImage(path)
        } else {
            Text(
                text = "This photograph is not on this device.",
                style = centraidType("small"),
                color = centraidColor("textSoft"),
                modifier = Modifier.align(Alignment.Center).padding(8.dp),
            )
        }
        if (candidate.box_width > 0.0 && candidate.box_height > 0.0) {
            Box(
                modifier = Modifier
                    .offset(
                        x = maxWidth * candidate.box_x.toFloat(),
                        y = maxHeight * candidate.box_y.toFloat(),
                    )
                    .size(
                        width = maxWidth * candidate.box_width.toFloat(),
                        height = maxHeight * candidate.box_height.toFloat(),
                    )
                    .background(centraidColor("accent").copy(alpha = 0.22f)),
            )
        }
    }
}

/**
 * WHERE THE MEMBER IS, so a queue feels finite.
 *
 * The denominator is what THIS PAGE holds and the wording says so when there is
 * more behind it: the read door has no `COUNT(*)`, so "3 of 60" over a page
 * with a cursor behind it would be a total nobody counted.
 */
private fun position(state: FaceReviewState, data: FaceReviewData): String {
    val shown = state.cursor + 1
    val total = data.candidates.size
    return if (data.next_cursor != null) "$shown of at least $total" else "$shown of $total"
}

/**
 * THE PROMPT, WITH THE MODEL'S CERTAINTY IN WORDS.
 *
 * The bands are [FaceReviewMachine.confidenceWord]'s and are not restated here
 * — a second table is a second answer. An empty word means the row did not say
 * how sure it was (`confidence` is NULL-able in the DDL), and the prompt then
 * simply asks.
 */
private fun prompt(candidate: FaceCandidate): String {
    if (candidate.proposed_name.isEmpty()) return "Who is this?"
    val word = FaceReviewMachine.confidenceWord(candidate.confidence)
    return if (word.isEmpty()) {
        "Is this ${candidate.proposed_name}?"
    } else {
        "This is $word ${candidate.proposed_name}."
    }
}
