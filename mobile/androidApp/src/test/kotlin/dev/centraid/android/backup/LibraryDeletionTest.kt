package dev.centraid.android.backup

import centraid.core.v1.LibraryDeleted
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FREE UP SPACE'S PURE HALF (#1080 A19, A20; #1127), on the JVM without a `ContentResolver`.
 *
 * The Android half of iOS's `LibraryDeletionTests`. Each rule has its NEGATIVE case: a row changed
 * after its backup, a ref naming the other collection and a ref that names no row are all kept,
 * because a gate shown only green is a gate nobody saw refuse. MediaStore has no edit revision,
 * Live Photo pair or camera-original row, so those iOS rules have no case here (the receipt of
 * #1152 says which, case by case); the system's dialog and the deletion itself are device hand-offs
 * (`docs/release/v1-handoffs.md`, section 8).
 */
class LibraryDeletionTest {
    private val image = LibraryRefs.Row(video = false, id = 42L)

    @Test
    fun anImageTheCoreOfferedNamesItsRowInTheImageCollection() {
        assertEquals(image, LibraryDeletion.target("image/jpeg", "image:42"))
        // A bare `_ID`, an early build's ref, was always an image.
        assertEquals(image, LibraryDeletion.target("image/heic", "42"))
        assertEquals(LibraryRefs.Row(video = true, id = 7L), LibraryDeletion.target("video/mp4", "video:7"))
    }

    @Test
    fun theCollectionIsTheMediaTypesAndARefNamingTheOtherOneIsSkipped() {
        // A movie's row never resolves in the images collection, nor a still's in the videos.
        assertNull(LibraryDeletion.target("image/jpeg", "video:42"))
        assertNull(LibraryDeletion.target("video/mp4", "image:42"))
        // Anything that is not `video/…` is an image, whatever it is called.
        assertEquals(image, LibraryDeletion.target("application/octet-stream", "image:42"))
    }

    @Test
    fun aRefThatNamesNoRowNamesNone() {
        assertNull(LibraryDeletion.target("image/jpeg", ""))
        assertNull(LibraryDeletion.target("image/jpeg", "image:"))
        assertNull(LibraryDeletion.target("image/jpeg", "image:abc"))
        assertNull(LibraryDeletion.target("image/jpeg", "image:42#r100"))
        assertNull(LibraryDeletion.target("video/mp4", "video:-"))
    }

    @Test
    fun aRowGoesOnlyWhileItIsTheSizeThatWasBackedUp() {
        assertTrue(LibraryDeletion.unchanged(stored = 4_096L, backedUp = 4_096L))
        // EDITED IN PLACE since the backup: the store holds bytes the gateway does not.
        assertFalse(LibraryDeletion.unchanged(stored = 4_097L, backedUp = 4_096L))
        // THE STORE NO LONGER ANSWERS for the row: nothing to delete, nothing to guess.
        assertFalse(LibraryDeletion.unchanged(stored = null, backedUp = 4_096L))
        assertFalse(LibraryDeletion.unchanged(stored = null, backedUp = 0L))
    }

    @Test
    fun aRefNamesItsCollectionAndItsRow() {
        assertEquals(LibraryRefs.Row(video = false, id = 1_760_000_000_123L), LibraryRefs.row("image:1760000000123"))
        assertEquals(LibraryRefs.Row(video = true, id = 9L), LibraryRefs.row("video:9"))
        assertEquals(image, LibraryRefs.row("42"))
        assertNull(LibraryRefs.row("image:"))
        assertNull(LibraryRefs.row("photo:42"))
    }

    @Test
    fun aRefIsSpelledTheWayTheWalkerSpellsIt() {
        // `LibraryRoll` mints with `LibraryRefs.of`; what it wrote reads back as the same row.
        assertEquals("image:42", LibraryRefs.of(video = false, id = 42L))
        assertEquals("video:42", LibraryRefs.of(video = true, id = 42L))
        for (row in listOf(image, LibraryRefs.Row(video = true, id = 7L), LibraryRefs.Row(video = false, id = Long.MAX_VALUE))) {
            assertEquals(row, LibraryRefs.row(LibraryRefs.of(row.video, row.id)))
        }
    }

    @Test
    fun onlyRowsTheStoreNoLongerAnswersForAreReportedDeletedInTheOrderAsked() {
        val asked = listOf("a" to 1L, "b" to 2L, "c" to 3L, "d" to 4L)
        val remaining = setOf(2L, 4L)
        assertEquals(
            listOf("a", "c"),
            LibraryDeletion.deletedHashes(asked, hash = { it.first }, stillThere = { it.second in remaining }),
        )
        // A refusal reads as "still there", so nothing is reported that this request did not remove.
        assertEquals(emptyList<String>(), LibraryDeletion.deletedHashes(asked, { it.first }, { true }))
        assertEquals(emptyList<String>(), LibraryDeletion.deletedHashes(emptyList<Pair<String, Long>>(), { it.first }, { false }))
    }

    @Test
    fun aYesIsDeletedANoIsDeclinedAndAnythingElseFails() {
        assertEquals(LibraryDeleted(deleted_hashes = listOf("a", "c")), LibraryDeletion.answer(true) { listOf("a", "c") })
        // A no never looks at the store.
        assertEquals(LibraryDeleted(declined = true), LibraryDeletion.answer(false) { error("a no reads nothing") })
        assertEquals(LibraryDeleted(error = "not allowed"), LibraryDeletion.failed(SecurityException("not allowed")))
        // No words from the platform: the exception's name, never an empty error.
        assertEquals(LibraryDeleted(error = "IllegalStateException"), LibraryDeletion.failed(IllegalStateException()))
    }
}
