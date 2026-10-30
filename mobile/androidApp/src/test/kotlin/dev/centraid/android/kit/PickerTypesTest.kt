package dev.centraid.android.kit

import org.junit.Assert.assertArrayEquals
import org.junit.Test

/**
 * `PickBytes.accept` AS THE SYSTEM PICKER'S TYPES (#1152): media types pass through, extensions go
 * through the platform's map, and anything that cannot be mapped (or nothing asked) leaves the
 * picker open to every file, so the member is never locked out of what Rust asked for.
 */
class PickerTypesTest {
    private val known = mapOf("csv" to "text/csv", "json" to "application/json")
    private val lookup: (String) -> String? = { known[it] }

    @Test
    fun emptyAcceptIsAnyFile() {
        assertArrayEquals(arrayOf("*/*"), pickerTypes(emptyList(), lookup))
    }

    @Test
    fun mediaTypesPassThroughAndRepeatsCollapse() {
        assertArrayEquals(arrayOf("text/csv", "text/plain"), pickerTypes(listOf("text/csv", "Text/Plain", "text/csv"), lookup))
    }

    @Test
    fun extensionsBecomeTheirMediaTypeWithOrWithoutTheDot() {
        assertArrayEquals(arrayOf("text/csv", "application/json"), pickerTypes(listOf(".csv", "JSON"), lookup))
    }

    @Test
    fun anExtensionTheMapDoesNotKnowKeepsThePickerOpenToEveryFile() {
        assertArrayEquals(arrayOf("*/*"), pickerTypes(listOf("text/csv", "application/x-ofx", ".ofx", ".qfx"), lookup))
    }
}
