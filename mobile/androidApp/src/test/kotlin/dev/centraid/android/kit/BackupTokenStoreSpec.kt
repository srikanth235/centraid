package dev.centraid.android.kit

import java.io.File
import javax.crypto.KeyGenerator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * THE GATEWAY TOKEN'S HOME ON ANDROID (#1191 B15, `contracts/backup/decisions.md` E12).
 *
 * The token lives in the device secret store under `gateway-token.<vault hex>.<gateway hex>`: a value
 * AES-GCM sealed under a Keystore key, in preferences that Auto Backup and device transfer exclude. A
 * JVM test cannot reach the Keystore, so this proves what it can: the sealing hides the token and the
 * vault and gateway ids from every byte the preferences file holds, and the backup rules exclude that
 * file by domain. The Keystore key's non-exportability and a restart are the owner's device walk.
 */
class BackupTokenStoreSpec {
    @get:Rule val folder = TemporaryFolder()

    private val valueKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val nameKey = KeyGenerator.getInstance(SealedEntries.HMAC).generateKey()
    private val sealing = SealedEntries(valueKey = { valueKey }, nameKey = { nameKey })

    private val vault = "a1".repeat(16)
    private val gateway = "b2".repeat(16)
    private val token = "tok-" + "7f3c9e".repeat(10)
    private val logical = "centraid.v1.gateway-token.$vault.$gateway"

    @Test
    fun theTokenNeverReachesTheStoredFileInThePlain() {
        // The shape of the preferences file: sealed name -> sealed value, one line each.
        val file = File(folder.root, "centraid-secure-store.xml")
        file.writeText("<map><string name=\"${sealing.nameOf(logical)}\">${sealing.seal(logical, token)}</string></map>")
        val scanned = folder.root.walkTopDown().filter { it.isFile }.map { it.readText() }.joinToString("\n")
        assertFalse(scanned.contains(token))
        assertFalse(scanned.contains(vault))
        assertFalse(scanned.contains(gateway))
        assertEquals(token, sealing.open(logical, sealing.seal(logical, token)))
    }

    @Test
    fun aTokenSealedForOneGatewayDoesNotOpenForAnother() {
        val sealed = sealing.seal(logical, token)
        val other = "centraid.v1.gateway-token.$vault.${"c3".repeat(16)}"
        val refused = runCatching { sealing.open(other, sealed) }.isFailure
        assertTrue("a token moved to another gateway's name must not open", refused)
    }

    @Test
    fun theBackupRulesExcludeThePreferencesFromCloudBackupAndDeviceTransfer() {
        val res = File("src/main/res/xml")
        val extraction = File(res, "data_extraction_rules.xml").readText()
        val cloud = extraction.substringAfter("<cloud-backup>").substringBefore("</cloud-backup>")
        val transfer = extraction.substringAfter("<device-transfer>").substringBefore("</device-transfer>")
        for (block in listOf(cloud, transfer)) {
            assertTrue(block.contains("<exclude domain=\"sharedpref\""))
            assertFalse("no include may re-admit a domain", block.contains("<include"))
        }
        val legacy = File(res, "full_backup_content.xml").readText()
        assertTrue(legacy.contains("<exclude domain=\"sharedpref\""))
        assertFalse(legacy.contains("<include"))
    }
}
