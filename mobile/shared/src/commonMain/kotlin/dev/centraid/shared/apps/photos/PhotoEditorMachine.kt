package dev.centraid.shared.apps.photos

import centraid.screen.v1.Loading
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotoDetail
import centraid.screen.v1.PhotoEditCrop
import centraid.screen.v1.PhotoEditPlan
import centraid.screen.v1.PhotoEditSource
import centraid.screen.v1.PhotoEditorEvent
import centraid.screen.v1.PhotoEditorState
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.ReadFailureKind
import centraid.screen.v1.SeatState
import dev.centraid.design.CentraidCopy
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * THE PHOTO EDITOR — crop, rotate, straighten, flip (#1029, photos port; v0's
 * `PhotoEditor.tsx`, `photo-edit-model.ts` and `photo-edit-save.ts`).
 *
 * ## The editor's one promise
 *
 * **NOTHING IS WRITTEN UNTIL "Save as a new photograph", AND THEN IT IS A NEW
 * PHOTOGRAPH.** The original is never touched: v0's whole argument for having
 * an editor at all was that it is non-destructive and says so, and its test
 * drove every other control and proved the save port was never reached. Here
 * that is structural — [ScreenEffect.RenderEdit] is emitted from ONE branch of
 * [reduce], the `save` one, and every tool is a pure change to [PhotoEditPlan].
 *
 * ## What the reducer owns, and what it cannot
 *
 * The PLAN is data and is reduced here: the quarter turns, the levelling, the
 * flip, the ratio and the crop rectangle, with v0's clamping so a crop can
 * never leave the frame or shrink below a tenth of it. The SENTENCES are
 * reduced here too — the status line, the two live labels and the refusal — so
 * the two shells cannot word one edit two ways.
 *
 * The IMAGE is not. The reducer never decodes a pixel: the stage's aspect
 * arrives on [PhotoEditorEvent.RatioChosen] as the shell measured it, and the
 * render is the shell's, answered by [PhotoEditorEvent.SaveSettled].
 *
 * ## What v0 did that this keeps, and the one thing it adds
 *
 * - The save lands as `media.add_asset` with `source_asset_id` naming the
 *   original — EDIT LINEAGE (#711), omitted never invented.
 *
 * And two things it changes:
 *
 * - **THE NEW PHOTOGRAPH KEEPS THE ORIGINAL'S DATE, PLACE AND CAPTION** (owner
 *   ruling, #1029 photos port — Apple Photos' behaviour). v0 dated an edit
 *   today and carried neither place nor caption, which filed a crop of a 2019
 *   holiday at the top of the library, under today, nowhere. The capture time
 *   and its offset ride the ingest itself; the place is `media.set_asset_place`
 *   once the asset exists, because `add_asset` can only MINT a place from a
 *   coordinate and the original's place is a row that already exists.
 * - **Cancel asks first when there is something to lose.** v0's Cancel dropped
 *   an edit without a word; a crop is minutes of fiddling, and a back gesture
 *   that throws it away is the kind of loss a member does not forgive. An
 *   untouched editor still closes at once.
 */
public object PhotoEditorMachine : ScreenMachine<PhotoEditorState, PhotoEditorEvent> {
    public const val SCREEN_ID: String = "photos.editor"

    override fun initial(): PhotoEditorState = settle(
        PhotoEditorState(
            loading = Loading(first_load = true),
            plan = FRESH_PLAN,
            phase = PhotoEditorState.Phase.PHASE_EDITING,
        ),
    )

    override fun reduce(
        state: PhotoEditorState,
        event: PhotoEditorEvent,
    ): Step<PhotoEditorState> {
        val step = when {
            // A FRESH EDITOR, EVERY TIME. A plan carried over from the last
            // photograph would crop this one by somebody else's rectangle.
            event.opened != null -> Step(
                initial().copy(asset_id = event.opened.asset_id, seat = state.seat),
                listOf(ScreenEffect.ReadPage(SCREEN_ID, afterCursor = null)),
            )

            event.data_ != null -> arrived(state, event.data_.source)

            event.refused != null -> Step(
                state.copy(loading = null, source = null, failure = event.refused.failure),
            )

            event.seat_changed != null -> Step(state.copy(seat = event.seat_changed.seat))

            event.save_settled != null -> saveSettled(state, event.save_settled)

            // WHILE A SAVE RUNS, OR THE DISCARD QUESTION IS UP, THE TOOLS ARE
            // INERT. v0 disabled them under `busy`; a crop moved while the
            // render reads the plan would be a photograph saved from a plan
            // the member was no longer looking at.
            state.phase != PhotoEditorState.Phase.PHASE_EDITING -> Step(state)

            event.discard != null -> Step(
                if (event.discard.discard) {
                    state.copy(discard_open = false, phase = PhotoEditorState.Phase.PHASE_CLOSED)
                } else {
                    state.copy(discard_open = false)
                },
            )

            state.discard_open -> Step(state)

            event.cancel != null -> Step(
                if (state.edited) {
                    state.copy(discard_open = true)
                } else {
                    state.copy(phase = PhotoEditorState.Phase.PHASE_CLOSED)
                },
            )

            event.save != null -> save(state)

            else -> Step(state.copy(plan = edit(state.plan ?: FRESH_PLAN, event)))
        }
        return step.copy(state = settle(step.state))
    }

    override fun rowsChanged(table: String, keys: List<String>): PhotoEditorEvent? = null

    override fun seatChanged(seat: SeatState): PhotoEditorEvent =
        PhotoEditorEvent(seat_changed = PhotoEditorEvent.SeatChanged(seat = seat))

    // -----------------------------------------------------------------------
    // The tools
    // -----------------------------------------------------------------------

    /** One tool press, as a new plan. Every branch here is pure geometry. */
    private fun edit(plan: PhotoEditPlan, event: PhotoEditorEvent): PhotoEditPlan = when {
        // ROTATION MUST NOT SILENTLY RE-CROP AGAINST THE OLD ORIENTATION, so a
        // quarter turn resets the crop and the ratio (v0's `rotateQuarter`).
        event.rotate != null -> plan.copy(
            quarters = (plan.quarters + 1) % 4,
            crop = FULL_CROP,
            ratio = PhotoEditPlan.Ratio.RATIO_ORIGINAL,
        )

        event.straighten != null -> plan.copy(straighten = nextStraighten(plan.straighten))

        event.flip != null -> plan.copy(flip = nextFlip(plan.flip))

        event.ratio != null -> {
            val ratio = event.ratio.ratio
            val value = ratioValue(ratio)
            plan.copy(
                ratio = ratio,
                crop = if (value == null || event.ratio.frame_ratio <= 0.0) {
                    FULL_CROP
                } else {
                    centredCrop(event.ratio.frame_ratio, value)
                },
            )
        }

        event.crop_moved != null -> plan.copy(
            crop = moveCrop(plan.crop ?: FULL_CROP, event.crop_moved.dx, event.crop_moved.dy),
        )

        event.crop_scaled != null ->
            if (event.crop_scaled.factor > 0.0) {
                plan.copy(crop = scaleCrop(plan.crop ?: FULL_CROP, event.crop_scaled.factor))
            } else {
                plan
            }

        event.reset != null -> FRESH_PLAN

        else -> plan
    }

    /**
     * THE COMMIT, OR NOTHING.
     *
     * A refused save emits nothing and changes nothing: the refusal is already
     * on screen beside an outlined commit, and v0's handler refused a press that
     * slipped past the disabled flag for the same reason — a live handler
     * hiding behind a disabled control is the regression worth catching.
     */
    private fun save(state: PhotoEditorState): Step<PhotoEditorState> {
        val source = state.source ?: return Step(state)
        if (saveRefusal(state) != null) return Step(state)
        val path = source.original_path.orEmpty()
        val plan = (state.plan ?: FRESH_PLAN).let { it.copy(crop = clampCrop(it.crop ?: FULL_CROP)) }
        val key = saveKey(state.asset_id, plan)
        return Step(
            state.copy(
                phase = PhotoEditorState.Phase.PHASE_SAVING,
                save_key = key,
                // A NEW ATTEMPT CLEARS THE OLD SENTENCE. A refusal left standing
                // over a save in flight is a screen saying no while it does it.
                save_failure = null,
            ),
            listOf(
                ScreenEffect.RenderEdit(
                    screenId = SCREEN_ID,
                    key = key,
                    sourceAssetId = state.asset_id,
                    sourcePath = path,
                    title = savedTitle(source.title),
                    capturedAt = source.captured_at,
                    tzOffsetMinutes = source.captured_utc_offset_minutes,
                    placeId = source.place_id,
                    plan = plan.encodeByteString(),
                ),
            ),
        )
    }

    /**
     * THE KEY IS THE ASSET AND THE PLAN, and never a counter: two presses of
     * Save over one plan are one intent, and a settle for a plan the member has
     * since changed is recognisably not this one.
     */
    internal fun saveKey(assetId: String, plan: PhotoEditPlan): String {
        val crop = plan.crop ?: FULL_CROP
        return "edit:" + assetId + ":" + plan.quarters + ":" + plan.straighten + ":" +
            plan.flip.value + ":" + crop.x + "," + crop.y + "," + crop.w + "," + crop.h
    }

    /**
     * A SAVE LANDED, OR DID NOT.
     *
     * Committed: the phase says SAVED and names the new photograph, and the
     * shell leaves for it. Refused: back to editing with the plan INTACT and
     * the noun plus the way forward on `save_failure` — v0's
     * `PHOTOS_ERROR_EDIT_NOT_SAVED` — so a member can press Save again without
     * redoing the crop.
     */
    private fun saveSettled(
        state: PhotoEditorState,
        settled: PhotoEditorEvent.SaveSettled,
    ): Step<PhotoEditorState> {
        // A STALE ANSWER. Dropped rather than drawn: it is about a plan that is
        // no longer the one in flight.
        if (state.phase != PhotoEditorState.Phase.PHASE_SAVING ||
            settled.save_key != state.save_key
        ) {
            return Step(state)
        }
        return if (settled.committed) {
            Step(
                state.copy(
                    phase = PhotoEditorState.Phase.PHASE_SAVED,
                    saved_asset_id = settled.asset_id,
                    save_key = "",
                ),
            )
        } else {
            Step(
                state.copy(
                    phase = PhotoEditorState.Phase.PHASE_EDITING,
                    save_key = "",
                    save_failure = ReadFailure(
                        kind = ReadFailureKind.READ_FAILURE_KIND_REFUSED,
                        sentence = EDIT_NOT_SAVED,
                        remedy = settled.sentence.ifEmpty { RETRY },
                    ),
                ),
            )
        }
    }

    private fun arrived(state: PhotoEditorState, source: PhotoEditSource?): Step<PhotoEditorState> {
        if (source == null) return Step(state)
        // A READ FOR A PHOTOGRAPH THE EDITOR HAS LEFT. Dropped rather than
        // drawn: opening the editor on the next photograph issues its own read.
        if (source.asset_id != state.asset_id) return Step(state)
        return Step(state.copy(loading = null, failure = null, source = source))
    }

    /**
     * THE SENTENCES, DERIVED ONCE PER REDUCE.
     *
     * Held on the state rather than recomputed in each view, so that "the two
     * shells say the same thing" is a property of one function rather than of
     * two views kept in step by hand.
     */
    private fun settle(state: PhotoEditorState): PhotoEditorState {
        val plan = state.plan ?: FRESH_PLAN
        return state.copy(
            status_line = if (state.phase == PhotoEditorState.Phase.PHASE_SAVING) {
                SAVING
            } else {
                editorStatus(plan)
            },
            straighten_label = straightenLabel(plan.straighten),
            flip_label = flipLabel(plan.flip),
            edited = isEdited(plan),
            save_refusal = saveRefusal(state).orEmpty(),
        )
    }

    /**
     * WHY SAVE CANNOT FIRE, OR NULL.
     *
     * **THE ORIGINAL, NEVER THE DISPLAY COPY.** v0's `resolveLocalOriginal`
     * said so in its first line — rendering from a thumbnail would silently
     * write a smaller photograph than the one the member edited. So an editor
     * over a photograph whose original is not on this phone refuses the commit
     * and says which absence it is.
     */
    public fun saveRefusal(state: PhotoEditorState): String? {
        val source = state.source ?: return NOT_LOADED
        if (!isEditable(source.kind)) return NOT_A_PHOTOGRAPH
        if (source.original_path.isNullOrEmpty()) return originalAbsent(source.held, source.original_absent_reason)
        return null
    }

    /**
     * THE LIGHTBOX'S EDIT BUTTON: live, or refused with the sentence that says
     * why (#1015 B10 — no verb enabled that cannot run, none disabled without a
     * reason). `PhotoLightboxView.swift`'s `PhotoEditButton` mirrors this by
     * hand, the way `PhotoCells.swift` mirrors `kit/PhotoCells.kt`.
     */
    public fun editRefusal(detail: PhotoDetail?): String? {
        if (detail == null || detail.asset_id.isEmpty()) {
            return PhotoLightboxMachine.NOT_IN_A_VAULT_YET_REASON
        }
        if (!isEditable(detail.kind)) return NOT_A_PHOTOGRAPH
        if (detail.held != PhotoCell.Held.HELD_ORIGINAL) return originalAbsent(detail.held, "")
        return null
    }

    /** Crop and rotate are raster work on a still. A video has no such editor. */
    private fun isEditable(kind: PhotoCell.Kind): Boolean =
        kind == PhotoCell.Kind.KIND_PHOTO || kind == PhotoCell.Kind.KIND_SCAN

    private fun originalAbsent(held: PhotoCell.Held, reason: String): String = when (held) {
        // THE ARROW IS ALREADY ON THE LIGHTBOX'S STATUS LINE; this names it.
        PhotoCell.Held.HELD_WITHHELD_BY_RULE -> "Load the original first."
        PhotoCell.Held.HELD_FETCHING -> "The original is still loading."
        else -> reason.ifEmpty { "The original is not on this phone yet." }
    }

    // -----------------------------------------------------------------------
    // The geometry — v0's `photo-edit-model.ts`, ported whole
    // -----------------------------------------------------------------------

    public const val STRAIGHTEN_STEP: Int = 1
    public const val STRAIGHTEN_LIMIT: Int = 15

    /** Smallest crop side, as a fraction of the frame. */
    public const val MIN_CROP: Double = 0.1

    public val FULL_CROP: PhotoEditCrop = PhotoEditCrop(x = 0.0, y = 0.0, w = 1.0, h = 1.0)

    public val FRESH_PLAN: PhotoEditPlan = PhotoEditPlan(
        quarters = 0,
        straighten = 0,
        flip = PhotoEditPlan.Flip.FLIP_UNSPECIFIED,
        ratio = PhotoEditPlan.Ratio.RATIO_ORIGINAL,
        crop = FULL_CROP,
    )

    /**
     * ONE CONTROL, not the desktop's −/readout/+ trio. Each press levels a
     * degree anticlockwise; past the limit returns to level. The phone cannot
     * straighten clockwise — v0's own rule, kept.
     */
    public fun nextStraighten(degrees: Int): Int {
        val next = degrees - STRAIGHTEN_STEP
        return if (next < -STRAIGHTEN_LIMIT) 0 else next
    }

    /** Minus is U+2212, not a hyphen: a number in the numeric register. */
    public fun signedDegrees(degrees: Int): String = when {
        degrees == 0 -> "0°"
        degrees < 0 -> "−" + abs(degrees) + "°"
        else -> "+" + degrees + "°"
    }

    public fun straightenLabel(degrees: Int): String = "Straighten " + signedDegrees(degrees)

    public fun totalRotation(quarters: Int, straighten: Int): Int =
        (((quarters % 4) + 4) % 4) * 90 + straighten

    public fun totalRotation(plan: PhotoEditPlan): Int = totalRotation(plan.quarters, plan.straighten)

    /**
     * STRAIGHTEN IS NOT A MULTIPLE OF 90°, so the box GROWS rather than
     * swapping sides; the crop is in fractions of that grown box.
     */
    public fun rotatedBox(width: Double, height: Double, degrees: Int): Pair<Double, Double> {
        val radians = degrees * PI / 180.0
        val c = abs(cos(radians))
        val s = abs(sin(radians))
        return Pair(width * c + height * s, width * s + height * c)
    }

    public fun rotatedFrameRatio(assetRatio: Double, degrees: Int): Double {
        val (width, height) = rotatedBox(assetRatio, 1.0, degrees)
        return if (height > 0.0) width / height else assetRatio
    }

    public fun clampCrop(rect: PhotoEditCrop): PhotoEditCrop {
        val w = rect.w.coerceIn(MIN_CROP, 1.0)
        val h = rect.h.coerceIn(MIN_CROP, 1.0)
        return PhotoEditCrop(x = rect.x.coerceIn(0.0, 1.0 - w), y = rect.y.coerceIn(0.0, 1.0 - h), w = w, h = h)
    }

    /** SIZE NEVER CHANGES: a resizing drag would silently change the chosen ratio. */
    public fun moveCrop(rect: PhotoEditCrop, dx: Double, dy: Double): PhotoEditCrop =
        clampCrop(rect.copy(x = rect.x + dx, y = rect.y + dy))

    /** KEEPS ITS ASPECT. Deliberately not a free-form eight-handle resize (#711). */
    public fun scaleCrop(rect: PhotoEditCrop, factor: Double): PhotoEditCrop {
        val cx = rect.x + rect.w / 2
        val cy = rect.y + rect.h / 2
        val w = (rect.w * factor).coerceIn(MIN_CROP, 1.0)
        val h = (rect.h * factor).coerceIn(MIN_CROP, 1.0)
        return clampCrop(PhotoEditCrop(x = cx - w / 2, y = cy - h / 2, w = w, h = h))
    }

    /** The centred rectangle of [ratio] inside a frame of [frameRatio]. */
    public fun centredCrop(frameRatio: Double, ratio: Double): PhotoEditCrop =
        if (ratio >= frameRatio) {
            val h = frameRatio / ratio
            PhotoEditCrop(x = 0.0, y = (1 - h) / 2, w = 1.0, h = h)
        } else {
            val w = ratio / frameRatio
            PhotoEditCrop(x = (1 - w) / 2, y = 0.0, w = w, h = 1.0)
        }

    public fun ratioValue(ratio: PhotoEditPlan.Ratio): Double? = when (ratio) {
        PhotoEditPlan.Ratio.RATIO_SQUARE -> 1.0
        PhotoEditPlan.Ratio.RATIO_THREE_TWO -> 3.0 / 2.0
        else -> null
    }

    /** SPACING IS LOAD-BEARING: `3 : 2` renders in the numeric register. */
    public fun ratioName(ratio: PhotoEditPlan.Ratio): String = when (ratio) {
        PhotoEditPlan.Ratio.RATIO_SQUARE -> "Square"
        PhotoEditPlan.Ratio.RATIO_THREE_TWO -> "3 : 2"
        else -> "Original"
    }

    /** A THREE-WAY CYCLE, not two toggles: one flip per render. */
    public fun nextFlip(current: PhotoEditPlan.Flip): PhotoEditPlan.Flip = when (current) {
        PhotoEditPlan.Flip.FLIP_UNSPECIFIED -> PhotoEditPlan.Flip.FLIP_HORIZONTAL
        PhotoEditPlan.Flip.FLIP_HORIZONTAL -> PhotoEditPlan.Flip.FLIP_VERTICAL
        PhotoEditPlan.Flip.FLIP_VERTICAL -> PhotoEditPlan.Flip.FLIP_UNSPECIFIED
    }

    public fun flipLabel(flip: PhotoEditPlan.Flip): String = when (flip) {
        PhotoEditPlan.Flip.FLIP_HORIZONTAL -> "Flip ↔"
        PhotoEditPlan.Flip.FLIP_VERTICAL -> "Flip ↕"
        PhotoEditPlan.Flip.FLIP_UNSPECIFIED -> "Flip"
    }

    /**
     * `nothing written yet` IS A FACT: nothing is staged, rendered or committed
     * while the editor is open, and the sentence is what says so at every step.
     */
    public fun editorStatus(plan: PhotoEditPlan): String {
        val flip = if (plan.flip == PhotoEditPlan.Flip.FLIP_UNSPECIFIED) {
            ""
        } else {
            " · " + flipLabel(plan.flip).lowercase()
        }
        return "Crop " + ratioName(plan.ratio) + " · rotation " +
            signedDegrees(totalRotation(plan)) + flip + " · nothing written yet"
    }

    public fun isEdited(plan: PhotoEditPlan): Boolean {
        val crop = plan.crop ?: FULL_CROP
        return (plan.ratio != PhotoEditPlan.Ratio.RATIO_ORIGINAL &&
            plan.ratio != PhotoEditPlan.Ratio.RATIO_UNSPECIFIED) ||
            totalRotation(plan) != 0 ||
            crop.x != 0.0 || crop.y != 0.0 || crop.w != 1.0 || crop.h != 1.0 ||
            plan.flip != PhotoEditPlan.Flip.FLIP_UNSPECIFIED
    }

    /**
     * THE NEW PHOTOGRAPH'S TITLE: the original's CAPTION when it has one, and
     * otherwise an `-edited` file name — v0's `editedFilename`, the suffix the
     * web editor writes, so the member can find it by name.
     *
     * `media_asset.title` holds a caption and a file name in one column, and a
     * value still SHAPED like a file name was never captioned: it gives its
     * stem. An empty title gives v0's own `photograph`.
     */
    public fun savedTitle(title: String): String {
        val trimmed = title.trim()
        if (trimmed.isNotEmpty() && !FILE_NAME.matches(trimmed)) return trimmed
        val stem = if (trimmed.isEmpty()) "" else trimmed.substringBeforeLast('.')
        return stem.ifEmpty { "photograph" } + "-edited.jpg"
    }

    /**
     * WHERE THE CROP LANDS IN PIXELS. Rounded and clamped so rounding cannot
     * ask a renderer for a rectangle running off the bitmap. Both shells call
     * this — Android directly, iOS mirroring it — so one crop is one rectangle.
     */
    public fun cropPixels(rect: PhotoEditCrop, width: Int, height: Int): IntArray {
        val w = max(1, halfUp(rect.w * width))
        val h = max(1, halfUp(rect.h * height))
        val x = halfUp(rect.x * width).coerceIn(0, max(0, width - w))
        val y = halfUp(rect.y * height).coerceIn(0, max(0, height - h))
        return intArrayOf(x, y, min(w, width), min(h, height))
    }

    /**
     * HALF UP, v0's `Math.round`, and NOT `kotlin.math.round` — which rounds a
     * tie to the even neighbour, so the two shells would cut a crop that lands
     * on a half pixel one pixel apart.
     */
    private fun halfUp(value: Double): Int = kotlin.math.floor(value + 0.5).toInt()

    private val FILE_NAME = Regex("^[^\\s/]+\\.[A-Za-z0-9]{2,5}$")

    // -----------------------------------------------------------------------
    // The words — v0's, unchanged
    // -----------------------------------------------------------------------

    public const val EDITOR_TITLE: String = "Crop and rotate"
    public const val EDITOR_CANCEL: String = "Cancel"
    /** v0's shared words, from the one copy table (`copy/photos.json`). */
    public const val SAVE_AS_NEW: String = CentraidCopy.Photos.PHOTOS_SAVE_AS_NEW
    public const val SAVE_AS_NEW_EXPLANATION: String =
        CentraidCopy.Photos.PHOTOS_SAVE_AS_NEW_EXPLANATION
    public const val SAVING: String = "Rendering the new photograph · the original is not touched"
    public const val EDIT_NOT_SAVED: String = "Photograph not saved."
    public const val RETRY: String = "Try again."
    public const val DISCARD_QUESTION: String = "Discard this edit?"
    public const val DISCARD: String = "Discard"
    public const val KEEP_EDITING: String = "Keep editing"
    public const val NOT_LOADED: String = "The photograph has not loaded."
    public const val NOT_A_PHOTOGRAPH: String =
        "Crop and rotate work on photographs, not on this kind of media"
}
