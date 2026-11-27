package dev.centraid.android.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ScanDocumentCaptureTest {
    @Test
    fun largeCapturesAreDecodedWithinTheBitmapBudget() {
        assertEquals(1, boundedDecodeSampleSize(4_000, 3_000))
        assertEquals(4, boundedDecodeSampleSize(12_000, 12_000))
        assertThrows(IllegalArgumentException::class.java) { boundedDecodeSampleSize(0, 100) }
    }

    @Test
    fun cameraExifRotationIsAppliedToThePdfPage() {
        assertEquals(90, rotationForExifOrientation(6))
        assertEquals(180, rotationForExifOrientation(3))
        assertEquals(270, rotationForExifOrientation(8))
        assertEquals(0, rotationForExifOrientation(1))
    }
}
