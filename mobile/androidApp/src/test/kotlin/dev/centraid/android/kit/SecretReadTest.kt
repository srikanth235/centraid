package dev.centraid.android.kit

import java.util.concurrent.CancellationException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SecretReadTest {
    @Test
    fun damagedSealedMetadataIsNotReportedAsAnAbsentReceipt() {
        val key = SecretKeySpec(ByteArray(16), "AES")
        val parameters = GCMParameterSpec(128, ByteArray(12))
        val encoder = Cipher.getInstance("AES/GCM/NoPadding")
        encoder.init(Cipher.ENCRYPT_MODE, key, parameters)
        val damaged = encoder.doFinal("receipt metadata".encodeToByteArray())
        damaged[damaged.lastIndex] = (damaged.last().toInt() xor 1).toByte()
        val decoder = Cipher.getInstance("AES/GCM/NoPadding")
        decoder.init(Cipher.DECRYPT_MODE, key, parameters)

        val answer = deviceSecretAnswer { decoder.doFinal(damaged).decodeToString() }

        assertFalse(answer.ok)
        assertFalse(answer.found)
        assertEquals(0, answer.value_.size)
    }

    @Test
    fun aMissingValueAndAnExistingValueRemainDistinctSuccessfulReads() {
        val missing = deviceSecretAnswer { null }
        assertTrue(missing.ok)
        assertFalse(missing.found)
        val present = deviceSecretAnswer { "receipt metadata" }
        assertTrue(present.ok)
        assertTrue(present.found)
        assertEquals("receipt metadata", present.value_.utf8())
    }

    @Test(expected = CancellationException::class)
    fun cancellingTheReaderDoesNotTurnIntoAStoreReply() {
        deviceSecretAnswer { throw CancellationException() }
    }
}
