package dev.centraid.android

import dev.centraid.shared.platform.SealedEntries
import java.security.GeneralSecurityException
import javax.crypto.KeyGenerator
import kotlin.io.encoding.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * THE SEALING UNDER `AndroidSecureStore`, on the JVM with software keys.
 *
 * The phone generates the same two key kinds inside the Android Keystore; what
 * a unit test cannot reach is the Keystore itself, so this proves the format
 * and the refusals, and the walk proves the Keystore.
 */
class SealedEntriesTest {
    private val valueKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val nameKey = KeyGenerator.getInstance(SealedEntries.HMAC).generateKey()
    private val sealing = SealedEntries(valueKey = { valueKey }, nameKey = { nameKey })

    private val name = "centraid.v1.endpoint-secret.vault-1"

    @Test
    fun aSealedValueOpensUnderItsOwnName() {
        val sealed = sealing.seal(name, "a secret")
        assertEquals("a secret", sealing.open(name, sealed))
        assertFalse(sealed.contains("secret"))
    }

    @Test
    fun theSameValueNeverSealsToTheSameText() {
        assertNotEquals(sealing.seal(name, "a secret"), sealing.seal(name, "a secret"))
    }

    @Test
    fun aStoredNameIsStableAndDoesNotCarryTheVaultId() {
        val stored = sealing.nameOf(name)
        assertEquals(stored, sealing.nameOf(name))
        assertNotEquals(stored, sealing.nameOf("centraid.v1.endpoint-secret.vault-2"))
        assertFalse(stored.contains("vault"))
    }

    @Test
    fun aValueMovedOntoAnotherNameDoesNotOpen() {
        val sealed = sealing.seal(name, "a secret")
        assertThrows(GeneralSecurityException::class.java) {
            sealing.open("centraid.v1.endpoint-secret.vault-2", sealed)
        }
    }

    @Test
    fun aTamperedValueDoesNotOpen() {
        val bytes = Base64.decode(sealing.seal(name, "a secret"))
        bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 1).toByte()
        assertThrows(GeneralSecurityException::class.java) { sealing.open(name, Base64.encode(bytes)) }
    }

    @Test
    fun aValueUnderAnotherKeyDoesNotOpen() {
        val other = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val sealed = SealedEntries(valueKey = { other }, nameKey = { nameKey }).seal(name, "a secret")
        assertThrows(GeneralSecurityException::class.java) { sealing.open(name, sealed) }
    }
}
