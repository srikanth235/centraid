package dev.centraid.shared.platform

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * THE DURABLE HALF OF THE CAMERA ROLL (#1025 S6, D-1025-S7-70).
 *
 * What is provable here without a photo library, and what is not:
 *
 * * **The cursor round trip IS provable**, and it is the piece a relaunch
 *   depends on. A cursor that does not survive `encode` → `parse` is a phone
 *   that re-offers the whole roll on every launch — the exact failure the
 *   durable cursor exists to prevent, and one no compiler catches.
 * * **The media-type map IS provable**, because it is a pure function over a
 *   uniform type identifier and the system table answers the same way in a test
 *   process as in the app.
 * * **`page` and `open` are NOT.** They need a `PHPhotoLibrary` with a grant and
 *   a seeded library, which is a simulator running an app and not a unit test.
 *   `receipts/issue-1025-sync-model.md` carries that run as screenshots, and
 *   this file says so rather than mocking Photos and proving the mock.
 */
class IosMediaLibrarySpec {
    @Test
    fun a_cursor_survives_the_round_trip_it_is_written_for() {
        val cursor = IosMediaLibrary.Cursor(1_726_000_000_000L, "9F1B2C3D-0000/L0/001")
        val back = IosMediaLibrary.Cursor.parse(cursor.encode())
        assertEquals(cursor, back, "a relaunch resumes where the last pass stopped")
    }

    @Test
    fun a_cursor_keeps_a_local_identifier_that_contains_the_separator() {
        // A `PHAsset` identifier is `<UUID>/L0/001` and carries slashes, not
        // pipes — but the parse splits on the FIRST separator for exactly this
        // reason, so an identifier that grew one would still round-trip.
        val cursor = IosMediaLibrary.Cursor(7L, "odd|identifier")
        assertEquals("odd|identifier", IosMediaLibrary.Cursor.parse(cursor.encode())?.localId)
    }

    @Test
    fun an_undated_asset_takes_the_epoch_floor_and_still_round_trips() {
        // Photos sorts a nil `creationDate` FIRST under an ascending sort, and
        // `epochMillisOf` answers 0 for one. A cursor that could not carry the
        // floor would drop every undated asset from the walk after page one.
        val cursor = IosMediaLibrary.Cursor(0L, "undated/L0/001")
        assertEquals(0L, IosMediaLibrary.Cursor.parse(cursor.encode())?.epochMillis)
    }

    @Test
    fun a_capture_before_1970_is_ordered_and_not_clamped() {
        // A scanned photograph dated 1965 is a real row in a real roll, and its
        // epoch is NEGATIVE. Only a nil date takes the floor; a negative one is
        // a fact and compares correctly against it.
        val old = IosMediaLibrary.Cursor(-157_766_400_000L, "scan/L0/001")
        val back = IosMediaLibrary.Cursor.parse(old.encode())
        assertEquals(-157_766_400_000L, back?.epochMillis)
        assertTrue(back!!.epochMillis < 0L, "a pre-1970 capture sorts before the floor's siblings")
    }

    @Test
    fun a_cursor_this_class_did_not_write_starts_the_walk_again() {
        // STARTING AGAIN IS THE SAFE FAILURE and a guess is not. A re-walk
        // re-offers photographs the core already holds, which `already_held`
        // makes cheap; a guessed date would SKIP them, which nothing makes
        // cheap and nothing would report.
        assertNull(IosMediaLibrary.Cursor.parse("no-separator-here"))
        assertNull(IosMediaLibrary.Cursor.parse("notanumber|asset/L0/001"))
        assertNull(IosMediaLibrary.Cursor.parse(""))
        assertNull(IosMediaLibrary.Cursor.parse(null))
    }

    @Test
    fun the_media_type_is_the_platforms_and_never_octet_stream_for_a_photograph() {
        // A photograph promoted as `application/octet-stream` is one a grid will
        // not embed (`Staging`), and the core has no sniffer — so this is the
        // one chance to get it right.
        assertEquals("image/jpeg", IosMediaLibrary.mimeOf("public.jpeg"))
        assertEquals("image/png", IosMediaLibrary.mimeOf("public.png"))
        assertEquals("image/heic", IosMediaLibrary.mimeOf("public.heic"))
        assertEquals("video/quicktime", IosMediaLibrary.mimeOf("com.apple.quicktime-movie"))
    }

    @Test
    fun an_identifier_the_system_does_not_know_is_octet_stream_and_not_a_throw() {
        // A roll can hold a type this build has never heard of. The bytes still
        // belong in the vault; what they lose is the grid's embed, which the
        // gateway's own derivation can still repair later.
        assertEquals("application/octet-stream", IosMediaLibrary.mimeOf(null))
        assertEquals("application/octet-stream", IosMediaLibrary.mimeOf("dev.centraid.nonsense"))
    }
}
