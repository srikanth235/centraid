package dev.centraid.android.kit

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import centraid.core.v1.SecretAnswer
import centraid.core.v1.SecretBatch
import centraid.core.v1.SecretBatched
import centraid.core.v1.SecretEntry
import centraid.core.v1.SecretOp
import centraid.core.v1.SecretStore
import centraid.core.v1.SyncedSecretsStatus
import com.google.android.gms.auth.blockstore.Blockstore
import com.google.android.gms.auth.blockstore.DeleteBytesRequest
import com.google.android.gms.auth.blockstore.RetrieveBytesRequest
import com.google.android.gms.auth.blockstore.StoreBytesData
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import kotlinx.coroutines.tasks.await
import okio.ByteString.Companion.toByteString

/**
 * THE SHELL'S TWO SECRET STORES (#1135, lane H2): the performer of the generic
 * `SecretBatch` and `SyncedSecretsProbe` effects. The shell keeps bytes; Rust
 * decides what to keep and where (`crates/screens/src/custody/secrets.rs`).
 *
 * **THE NAMES ARE TODAY'S.** Rust never spells a prefix: the device store adds
 * `centraid.v1.` to a key as it always did, so a seed an earlier build wrote is
 * found after the update.
 *
 * * DEVICE: preferences `centraid-secure-store`, every value AES-GCM sealed to
 *   its name under a Keystore key and every name an HMAC under another, so an
 *   enumeration of the file names nothing. Auto Backup and device transfer
 *   exclude it, which is what `ThisDeviceOnly` buys on iOS. **Listing** needs the
 *   plain names, which the HMAC hides: the store therefore keeps one sealed
 *   index of the names it has written ([INDEX]). Names written before this index
 *   existed are adopted once ([adoptLegacy]); a name built from a vault's id is read by [get].
 * * SYNCED: Block Store, end-to-end encrypted where the device supports it.
 *   It holds at most 16 keys per app (the member's seed, the index of vaults on
 *   their own words, and so fourteen such vaults). A refused set answers
 *   `ok: false` and Rust keeps the seed on this phone only. Block Store returns
 *   bytes during the new-phone setup flow and at no other time, so a synced SET
 *   reads back and answers `ok: false` unless the value is there.
 */
internal object SecretStores {
    private const val PREFIX = "centraid.v1."
    private const val FILE_NAME = "centraid-secure-store"
    private const val VALUE_KEY_ALIAS = "centraid.v1.secure-store.values"
    private const val NAME_KEY_ALIAS = "centraid.v1.secure-store.names"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val INDEX = PREFIX + "\u0000names"
    private const val ADOPTED = "centraid.v1.legacy-adopted"
    private val keyLock = Any()

    /** Run [batch] in order, one answer per op. */
    suspend fun run(context: Context, batch: SecretBatch): SecretBatched =
        SecretBatched(answers = batch.ops.map { perform(context, it) })

    /**
     * Whether Block Store would carry a key to another device right now.
     * `restores_after_setup` is false on Android, always: it is what the API does
     * (Block Store restores only in the device-setup flow).
     */
    suspend fun probe(context: Context): SyncedSecretsStatus {
        val cloud = try {
            Blockstore.getClient(context).isEndToEndEncryptionAvailable.await()
        } catch (error: Exception) {
            false
        }
        return SyncedSecretsStatus(synchronizing = cloud, restores_after_setup = false)
    }

    private suspend fun perform(context: Context, op: SecretOp): SecretAnswer {
        val synced = op.store == SecretStore.SECRET_STORE_SYNCED
        val value = op.value_.utf8()
        return when (op.op) {
            SecretOp.Op.OP_GET -> {
                val held = if (synced) syncedGet(context, op.key) else deviceGet(context, op.key)
                SecretAnswer(ok = true, found = held != null, value_ = (held ?: "").encodeToByteString())
            }
            SecretOp.Op.OP_SET -> when {
                // An empty value deletes: an empty secret that reads back as present is a credential the app believes it has.
                value.isEmpty() -> SecretAnswer(ok = if (synced) syncedDelete(context, op.key) else deviceDelete(context, op.key))
                synced -> SecretAnswer(ok = syncedSet(context, op.key, value) && syncedGet(context, op.key) == value)
                else -> SecretAnswer(ok = deviceSet(context, op.key, value))
            }
            SecretOp.Op.OP_DELETE ->
                SecretAnswer(ok = if (synced) syncedDelete(context, op.key) else deviceDelete(context, op.key))
            SecretOp.Op.OP_LIST -> {
                val entries = if (synced) syncedList(context, op.key) else deviceList(context, op.key)
                SecretAnswer(ok = true, entries = entries.map { (key, held) -> SecretEntry(key = key, value_ = held.encodeToByteString()) })
            }
            else -> SecretAnswer()
        }
    }

    // ---- device -----------------------------------------------------------------

    /**
     * ONE DEVICE-STORE VALUE, for the shell's own keys and the generic `Keychain` effect: the same
     * file, the same names, the same sealing as `SecretBatch`'s device store. An empty value deletes.
     */
    fun read(context: Context, key: String): String? = deviceGet(context, key)

    fun write(context: Context, key: String, value: String): Boolean =
        if (value.isEmpty()) deviceDelete(context, key) else deviceSet(context, key, value)


    private fun preferences(context: Context) = context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)

    private fun deviceGet(context: Context, key: String): String? = try {
        val name = PREFIX + key
        preferences(context).getString(nameOf(name), null)?.let { open(name, it) }
    } catch (error: Exception) {
        null
    }

    private fun deviceSet(context: Context, key: String, value: String): Boolean = try {
        val name = PREFIX + key
        val written = preferences(context).edit().putString(nameOf(name), seal(name, value)).commit()
        written && remember(context, key, add = true)
    } catch (error: Exception) {
        false
    }

    private fun deviceDelete(context: Context, key: String): Boolean = try {
        val name = PREFIX + key
        val removed = preferences(context).edit().remove(nameOf(name)).commit()
        removed && remember(context, key, add = false)
    } catch (error: Exception) {
        false
    }

    private fun deviceList(context: Context, prefix: String): List<Pair<String, String>> {
        adoptLegacy(context)
        val names = indexNames(context)
        return names.filter { it.startsWith(prefix) }.mapNotNull { key -> deviceGet(context, key)?.let { key to it } }
    }

    /**
     * THE NAMES AN EARLIER BUILD WROTE, before the index existed, are adopted once: each fixed
     * name the custody keeps is probed, and so are the entries a probed index names. A name
     * built from a vault's id (`vault-index.<id>`, `vault-own.<id>`) cannot be probed from here:
     * Rust asks for those by id once the shelf knows the vaults (`VaultSecrets::hydrate_ops`).
     */
    private fun adoptLegacy(context: Context) {
        if (preferences(context).getBoolean(ADOPTED, false)) return
        val fixed = listOf(
            "recovery-seed.this-device", "recovery-words.this-device", "recovery-words-saved", "seed-settled",
            "vault-index-high-water", "vault-index-pending", "vault-seeds.this-device", "vault-seeds.to-file",
            "transfer-rule", "transfer-rule.include-videos",
        )
        val found = fixed.filter { deviceGet(context, it) != null }.toMutableList()
        deviceGet(context, "vault-seeds.this-device")?.lines()
            ?.mapNotNull { line -> line.substringBefore('\t').takeIf { it.isNotEmpty() } }
            ?.forEach { id ->
                listOf("vault-seed.this-device.$id", "vault-words.this-device.$id")
                    .filterTo(found) { deviceGet(context, it) != null }
            }
        val names = indexNames(context).toMutableSet().apply { addAll(found) }
        val written = preferences(context).edit().putString(nameOf(INDEX), seal(INDEX, names.sorted().joinToString("\n"))).commit()
        if (written) preferences(context).edit().putBoolean(ADOPTED, true).apply()
    }

    private fun indexNames(context: Context): Set<String> = try {
        preferences(context).getString(nameOf(INDEX), null)?.let { open(INDEX, it) }
            ?.split('\n')?.filter { it.isNotEmpty() }?.toSet().orEmpty()
    } catch (error: Exception) {
        emptySet()
    }

    /** Keep the sealed index of written names in step with a set or a delete. */
    private fun remember(context: Context, key: String, add: Boolean): Boolean {
        val names = indexNames(context).toMutableSet()
        if (add) names += key else names -= key
        return preferences(context).edit().putString(nameOf(INDEX), seal(INDEX, names.sorted().joinToString("\n"))).commit()
    }

    /** Every value AES-GCM sealed to its name, every name an HMAC: both keys in the Keystore. */
    private val sealing = SealedEntries(
        valueKey = { keystoreKey(VALUE_KEY_ALIAS, KeyProperties.KEY_ALGORITHM_AES) },
        nameKey = { keystoreKey(NAME_KEY_ALIAS, KeyProperties.KEY_ALGORITHM_HMAC_SHA256) },
    )

    private fun nameOf(logicalName: String): String = sealing.nameOf(logicalName)

    private fun seal(logicalName: String, value: String): String = sealing.seal(logicalName, value)

    /** THROWS on a value that does not open: a null would read as "no credential". */
    private fun open(logicalName: String, sealed: String): String = sealing.open(logicalName, sealed)

    /** The Keystore key under [alias], generated on first use, under a lock so two first reads cannot each generate one. */
    private fun keystoreKey(alias: String, algorithm: String): SecretKey = synchronized(keyLock) {
        val keystore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keystore.getKey(alias, null) as SecretKey?) ?: KeyGenerator.getInstance(algorithm, ANDROID_KEYSTORE)
            .apply { init(spec(alias, algorithm)) }
            .generateKey()
    }

    private fun spec(alias: String, algorithm: String): KeyGenParameterSpec =
        if (algorithm == KeyProperties.KEY_ALGORITHM_AES) {
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        } else {
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN).build()
        }

    // ---- synchronised (Block Store) ------------------------------------------------

    private suspend fun syncedSet(context: Context, key: String, value: String): Boolean = try {
        Blockstore.getClient(context).storeBytes(
            StoreBytesData.Builder()
                .setBytes(value.encodeToByteArray())
                .setKey(key)
                .setShouldBackupToCloud(true)
                .build(),
        ).await()
        true
    } catch (error: Exception) {
        false
    }

    private suspend fun syncedGet(context: Context, key: String): String? = try {
        Blockstore.getClient(context).retrieveBytes(
            RetrieveBytesRequest.Builder().setKeys(listOf(key)).build(),
        ).await().blockstoreDataMap[key]?.bytes?.decodeToString()
    } catch (error: Exception) {
        null
    }

    private suspend fun syncedDelete(context: Context, key: String): Boolean = try {
        Blockstore.getClient(context).deleteBytes(
            DeleteBytesRequest.Builder().setKeys(listOf(key)).build(),
        ).await()
        true
    } catch (error: Exception) {
        // A value that would not delete is not an error a member can act on: the
        // local copy is gone either way and the next set under the key replaces it.
        true
    }

    private suspend fun syncedList(context: Context, prefix: String): List<Pair<String, String>> = try {
        Blockstore.getClient(context).retrieveBytes(
            RetrieveBytesRequest.Builder().setRetrieveAll(true).build(),
        ).await().blockstoreDataMap
            .filterKeys { it.startsWith(prefix) }
            .map { (key, data) -> key to data.bytes.decodeToString() }
    } catch (error: Exception) {
        emptyList()
    }
}

private fun String.encodeToByteString(): okio.ByteString = encodeToByteArray().toByteString()
