package dev.centraid.android.kit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StoreRefusalTest {
    @Test
    fun aStoreNeverAskedForIsNotRefused() {
        val failed = StoreRefusal.failure(asked = false)
        assertFalse(failed.denied)
        assertEquals(EffectReason.UNAVAILABLE, failed.reason)
    }

    @Test
    fun aStoreAskedForAndNotGrantedIsDenied() {
        val failed = StoreRefusal.failure(asked = true)
        assertTrue(failed.denied)
        assertEquals(EffectReason.DENIED, failed.reason)
    }
}
