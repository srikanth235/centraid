package dev.centraid.shared.apps.photos

import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotoDetail
import centraid.screen.v1.PhotoLightboxFact
import centraid.screen.v1.PhotoLightboxState
import dev.centraid.design.copy.PhotosCopy
import dev.centraid.shared.kit.MediaFormat
import dev.centraid.shared.kit.time.CivilWords
import dev.centraid.shared.kit.time.dayOfMonthOf

/**
 * THE LIGHTBOX'S WORDS — the status line, the whereabouts, the facts and the
 * stamp — decided ONCE, here, and drawn by both shells.
 *
 * Each was composed in SwiftUI and again in Compose (`PhotoLightboxView.swift`
 * and `PhotoLightboxScreen.kt`), with the platform's date formatter underneath
 * the stamp and the platform's number formatter underneath the file size. Two
 * statements of one sentence are two places it can drift, and one did: Swift
 * rounded a size half to even and the core half up. [PhotoLightboxMachine]
 * fills these onto [PhotoLightboxState] after every step, so a shell holds a
 * finished sentence and no rule.
 *
 * **ONE ZONE: THE SHUTTER'S.** The stamp is the capture-local day and clock
 * ([PhotosTimeline.captureDay], [PhotosTimeline.captureClock]), the zone the
 * Library files the photograph under, so the grid and the lightbox cannot name
 * two dates for one evening. The clock is on 24 hours and the month is a word
 * from [CivilWords], as every other civil date in the shell is.
 */
internal object PhotoLightboxText {
    /** [state] with every derived line filled from its `detail`, or emptied when there is none. */
    fun fill(state: PhotoLightboxState): PhotoLightboxState {
        val detail = state.detail
        val meta = PhotoLightboxMachine.slideshowMeta(state)
        if (detail == null) {
            return state.copy(
                status_line = "",
                status_line_playing = "",
                whereabouts = "",
                facts = emptyList(),
                stamp_date = "",
                stamp_line = "",
                slideshow_meta = meta,
                write_refusal = PhotoLightboxMachine.writeRefusal(state).orEmpty(),
                edit_refusal = PhotoEditorMachine.editRefusal(null).orEmpty(),
            )
        }
        return state.copy(
            status_line = statusLine(detail, playing = false),
            status_line_playing = statusLine(detail, playing = true),
            whereabouts = whereabouts(detail),
            facts = facts(detail),
            stamp_date = stampDate(detail),
            stamp_line = stampLine(detail),
            slideshow_meta = meta,
            write_refusal = PhotoLightboxMachine.writeRefusal(state).orEmpty(),
            edit_refusal = PhotoEditorMachine.editRefusal(detail).orEmpty(),
        )
    }

    /**
     * THE STAGE'S ONE LINE, and nothing when there is nothing to say.
     *
     * The precedence is v0's: a byte status with something to DO beats a
     * description of what is playing, because an offer beats a lesson. A video
     * with no player is one whose file is not here, and the line says what the
     * stage is showing instead.
     */
    fun statusLine(detail: PhotoDetail, playing: Boolean): String = when {
        detail.held == PhotoCell.Held.HELD_WITHHELD_BY_RULE -> PhotosCopy.PHOTOS_ORIGINAL_HELD_BACK
        // A PERCENTAGE ONLY WHEN THERE IS ONE: "0%" would read as "nothing has
        // crossed".
        detail.held == PhotoCell.Held.HELD_FETCHING ->
            if (detail.fetch_percent > 0) {
                PhotosCopy.PHOTOS_ORIGINAL_DOWNLOADING_PERCENT.replace("{percent}", "${detail.fetch_percent}")
            } else {
                PhotosCopy.PHOTOS_ORIGINAL_DOWNLOADING
            }
        detail.held == PhotoCell.Held.HELD_ABSENT -> PhotosCopy.PHOTOS_NOTHING_ON_PHONE
        detail.kind == PhotoCell.Kind.KIND_VIDEO && !playing -> PhotosCopy.PHOTOS_VIDEO_STILL_ONLY
        else -> ""
    }

    /**
     * WHERE THE BYTES ARE, in a sentence that says what fetching costs:
     * "explicit choice" is only honest if the choice is described before it is
     * offered.
     */
    fun whereabouts(detail: PhotoDetail): String = when (detail.held) {
        PhotoCell.Held.HELD_ORIGINAL -> PhotosCopy.PHOTOS_ORIGINAL_ON_PHONE
        PhotoCell.Held.HELD_WITHHELD_BY_RULE -> PhotosCopy.PHOTOS_ORIGINAL_YOUR_CHOICE
        PhotoCell.Held.HELD_FETCHING -> PhotosCopy.PHOTOS_ORIGINAL_DOWNLOADING_NOW
        PhotoCell.Held.HELD_ABSENT -> PhotosCopy.PHOTOS_NOTHING_ON_PHONE
        PhotoCell.Held.HELD_THUMBNAIL_ONLY, PhotoCell.Held.HELD_UNSPECIFIED ->
            PhotosCopy.PHOTOS_SMALLER_COPY_ONLY
    }

    /**
     * **A FIELD THE RECORD LACKS IS OMITTED, never invented as `?p` or
     * `0:00`.** Every row exists only when the vault answered for it; a fact
     * that could not be read is still a row.
     */
    fun facts(detail: PhotoDetail): List<PhotoLightboxFact> = buildList {
        val date = stampDate(detail)
        if (date.isNotEmpty()) {
            // NO ORIGINAL OFFSET IS NOT ZERO. `tz_offset_min` is nullable and a
            // missing one reads as zero here, so the line says UTC rather than
            // claiming the camera recorded Greenwich.
            val zone = detail.captured_utc_offset_minutes.let { if (it == 0) "UTC" else offset(it) }
            add(PhotoLightboxFact(PhotosCopy.PHOTOS_FACT_CAPTURED, "$date ${stampLine(detail)} · $zone"))
        }
        if (detail.width > 0 && detail.height > 0) {
            add(PhotoLightboxFact(PhotosCopy.PHOTOS_FACT_SIZE, "${detail.width} × ${detail.height}"))
        }
        if (detail.duration_seconds > 0) {
            add(PhotoLightboxFact(PhotosCopy.PHOTOS_FACT_LENGTH, MediaFormat.clock(detail.duration_seconds.toLong())))
        }
        if (detail.byte_size > 0L) {
            add(PhotoLightboxFact(PhotosCopy.PHOTOS_FACT_FILE, MediaFormat.bytes(detail.byte_size)))
        } else if (PhotoDetail.Part.PART_CONTENT in detail.unread_parts) {
            add(PhotoLightboxFact(PhotosCopy.PHOTOS_FACT_FILE, PhotosCopy.PHOTOS_FILE_SIZE_UNREADABLE))
        }
        if (detail.camera.isNotEmpty()) add(PhotoLightboxFact(PhotosCopy.PHOTOS_FACT_CAMERA, detail.camera))
    }

    /**
     * `30 July 2026`, or empty when the row records no capture time. Never an
     * invented date: a photograph with no timestamp shows its name instead.
     */
    fun stampDate(detail: PhotoDetail): String =
        stampDate(detail.captured_at, detail.captured_utc_offset_minutes)

    /** [stampDate] from the two columns it is a function of, which the editor's header also holds. */
    fun stampDate(capturedAt: String, offsetMinutes: Int): String {
        val day = PhotosTimeline.captureDay(capturedAt, offsetMinutes)
        val dayOfMonth = dayOfMonthOf(day) ?: return ""
        val month = day.substring(MONTH_FROM, MONTH_TO).toIntOrNull()?.let(CivilWords::monthName).orEmpty()
        return "$dayOfMonth $month ${day.substring(0, YEAR_TO).toInt()}"
    }

    /**
     * `17:42 · Lyme Regis`. The place stops the line short when there is none,
     * never leaving a dangling separator.
     */
    fun stampLine(detail: PhotoDetail): String =
        listOf(
            PhotosTimeline.captureClock(detail.captured_at, detail.captured_utc_offset_minutes),
            detail.place_name,
        ).filter { it.isNotEmpty() }.joinToString(" · ")

    /** `UTC+01:00` — the zone as a signed offset from Greenwich. */
    fun offset(minutes: Int): String {
        val total = if (minutes < 0) -minutes else minutes
        return "UTC" + (if (minutes < 0) "-" else "+") +
            (total / 60).toString().padStart(2, '0') + ":" + (total % 60).toString().padStart(2, '0')
    }

    private const val YEAR_TO: Int = 4
    private const val MONTH_FROM: Int = 5
    private const val MONTH_TO: Int = 7
}
