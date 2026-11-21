package dev.centraid.android.kit

import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import java.io.ByteArrayInputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/**
 * THE SIZE CEILINGS OF A PICK (#1202): a file over the importer's ceiling is never held, a provider that
 * states no size is held to the same ceiling by the read itself, and the pick's total is spent in order.
 * Counts and bytes only.
 */
@RunWith(RobolectricTestRunner::class)
class PickLimitsTest {
    private val context get() = ApplicationProvider.getApplicationContext<android.app.Application>()

    private fun file(name: String, size: Int): Uri {
        val uri = Uri.parse("content://dev.centraid.test/$name")
        shadowOf(context.contentResolver).registerInputStream(uri, ByteArrayInputStream(ByteArray(size) { 7 }))
        return uri
    }

    @Test
    fun aFileWithinTheCeilingIsRead() {
        val read = PickLimits(perFile = 100, total = 0).read(context, file("a", 100))
        assertTrue(read is PickLimits.Read.Bytes)
        assertArrayEquals(ByteArray(100) { 7 }, (read as PickLimits.Read.Bytes).bytes)
    }

    @Test
    fun aFileOverTheCeilingIsTooLargeEvenWhenTheProviderStatesNoSize() {
        val read = PickLimits(perFile = 100, total = 0).read(context, file("b", 101))
        assertTrue(read is PickLimits.Read.TooLarge)
    }

    @Test
    fun noCeilingReadsAnything() {
        assertTrue(PickLimits(perFile = 0, total = 0).read(context, file("c", 5_000)) is PickLimits.Read.Bytes)
    }

    @Test
    fun theTotalIsSpentInOrderAndTheFileThatWouldPassItIsLeftOut() {
        val limits = PickLimits(perFile = 0, total = 250)
        assertTrue(limits.read(context, file("d1", 100)) is PickLimits.Read.Bytes)
        assertTrue(limits.read(context, file("d2", 100)) is PickLimits.Read.Bytes)
        assertTrue(limits.read(context, file("d3", 100)) is PickLimits.Read.TooLarge)
        assertTrue("a smaller one still fits", limits.read(context, file("d4", 50)) is PickLimits.Read.Bytes)
    }

    @Test
    fun aFileThatCannotBeOpenedIsUnreadable() {
        val read = PickLimits(perFile = 100, total = 0).read(context, Uri.parse("content://dev.centraid.test/missing"))
        assertTrue(read is PickLimits.Read.Unreadable)
    }

    @Test
    fun aMultiplePickNamesTheFilesLeftOutAndKeepsTheRest() {
        val result = kotlinx.coroutines.runBlocking {
            pickMany(context, listOf(file("e1", 10), file("e2", 500), file("e3", 20)), PickLimits(perFile = 100, total = 0))
        }
        val picked = result.bytes_picked!!
        assertTrue(picked.files.size == 2)
        assertTrue(picked.skipped == listOf("e2"))
    }
}
