package dev.centraid.android.share

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.URI
import java.security.SecureRandom
import org.json.JSONObject

internal object ShareInboxWriter {
    const val INBOX_DIR: String = "share-inbox"
    const val MANIFEST_FILE: String = "manifest.json"
    const val PAYLOAD_FILE: String = "payload"
    const val MANIFEST_VERSION: Int = 1
    const val TYPE_FILE: String = "file"
    const val TYPE_TEXT: String = "text"
    const val TYPE_URL: String = "url"

    private const val CHUNK_BYTES: Int = 64 * 1024
    private val random = SecureRandom()

    fun inboxDir(context: Context): File = File(context.applicationContext.filesDir, INBOX_DIR)

    fun hasPendingItems(inboxDir: File): Boolean {
        if (!inboxDir.isDirectory) return false
        val children = inboxDir.listFiles() ?: return false
        return children.any { child -> child.isDirectory && File(child, MANIFEST_FILE).isFile }
    }

    fun newUuidV7(nowMs: Long = System.currentTimeMillis()): String {
        val bytes = ByteArray(16)
        random.nextBytes(bytes)
        bytes[0] = ((nowMs ushr 40) and 0xFF).toByte()
        bytes[1] = ((nowMs ushr 32) and 0xFF).toByte()
        bytes[2] = ((nowMs ushr 24) and 0xFF).toByte()
        bytes[3] = ((nowMs ushr 16) and 0xFF).toByte()
        bytes[4] = ((nowMs ushr 8) and 0xFF).toByte()
        bytes[5] = (nowMs and 0xFF).toByte()
        bytes[6] = ((bytes[6].toInt() and 0x0F) or 0x70).toByte()
        bytes[8] = ((bytes[8].toInt() and 0x3F) or 0x80).toByte()
        val hex = StringBuilder(36)
        for (index in bytes.indices) {
            if (index == 4 || index == 6 || index == 8 || index == 10) hex.append('-')
            val value = bytes[index].toInt() and 0xFF
            hex.append(HEX[value ushr 4])
            hex.append(HEX[value and 0x0F])
        }
        return hex.toString()
    }

    fun classifyText(text: String): String {
        val trimmed = text.trim()
        if (trimmed.isEmpty() || trimmed.any(Char::isWhitespace)) return TYPE_TEXT
        val parsed = runCatching { URI(trimmed) }.getOrNull() ?: return TYPE_TEXT
        val scheme = parsed.scheme?.lowercase() ?: return TYPE_TEXT
        return if ((scheme == "http" || scheme == "https") && !parsed.host.isNullOrBlank()) {
            TYPE_URL
        } else {
            TYPE_TEXT
        }
    }

    fun writeTextOrUrl(
        inboxDir: File,
        text: String,
        fromApp: String = "",
        name: String = "",
        mime: String = "",
        receivedAtMs: Long = System.currentTimeMillis(),
        uuid: String = newUuidV7(receivedAtMs),
    ): File {
        val type = classifyText(text)
        val effectiveMime = mime.ifBlank {
            if (type == TYPE_URL) "text/uri-list" else "text/plain"
        }
        return writeItem(
            inboxDir = inboxDir,
            uuid = uuid,
            type = type,
            mime = effectiveMime,
            name = name,
            fromApp = fromApp,
            receivedAtMs = receivedAtMs,
        ) { out ->
            out.write(text.toByteArray(Charsets.UTF_8))
        }
    }

    fun writeText(
        inboxDir: File,
        text: String,
        fromApp: String = "",
        name: String = "",
        mime: String = "text/plain",
        receivedAtMs: Long = System.currentTimeMillis(),
        uuid: String = newUuidV7(receivedAtMs),
    ): File = writeItem(
        inboxDir = inboxDir,
        uuid = uuid,
        type = TYPE_TEXT,
        mime = mime.ifBlank { "text/plain" },
        name = name,
        fromApp = fromApp,
        receivedAtMs = receivedAtMs,
    ) { out ->
        out.write(text.toByteArray(Charsets.UTF_8))
    }

    fun writeUrl(
        inboxDir: File,
        url: String,
        fromApp: String = "",
        name: String = "",
        mime: String = "text/uri-list",
        receivedAtMs: Long = System.currentTimeMillis(),
        uuid: String = newUuidV7(receivedAtMs),
    ): File = writeItem(
        inboxDir = inboxDir,
        uuid = uuid,
        type = TYPE_URL,
        mime = mime.ifBlank { "text/uri-list" },
        name = name,
        fromApp = fromApp,
        receivedAtMs = receivedAtMs,
    ) { out ->
        out.write(url.trim().toByteArray(Charsets.UTF_8))
    }

    fun writeFile(
        inboxDir: File,
        source: InputStream,
        mime: String,
        name: String,
        fromApp: String = "",
        receivedAtMs: Long = System.currentTimeMillis(),
        uuid: String = newUuidV7(receivedAtMs),
    ): File = writeItem(
        inboxDir = inboxDir,
        uuid = uuid,
        type = TYPE_FILE,
        mime = mime.ifBlank { "application/octet-stream" },
        name = name,
        fromApp = fromApp,
        receivedAtMs = receivedAtMs,
    ) { out ->
        val buffer = ByteArray(CHUNK_BYTES)
        while (true) {
            val read = source.read(buffer)
            if (read <= 0) break
            out.write(buffer, 0, read)
        }
    }

    private fun writeItem(
        inboxDir: File,
        uuid: String,
        type: String,
        mime: String,
        name: String,
        fromApp: String,
        receivedAtMs: Long,
        writePayload: (FileOutputStream) -> Unit,
    ): File {
        require(uuid.isNotBlank() && !uuid.contains('/') && !uuid.contains('\\') && uuid != "." && uuid != "..") {
            "invalid share-in item uuid"
        }
        if (!inboxDir.exists() && !inboxDir.mkdirs()) {
            throw IOException("could not create share inbox directory")
        }
        val itemDir = File(inboxDir, uuid)
        if (!itemDir.exists() && !itemDir.mkdirs()) {
            throw IOException("could not create share item directory")
        }
        try {
            // Write payload completely before manifest.json exists so Rust's inbox scanner never observes a half-written item.
            writeAtomically(File(itemDir, PAYLOAD_FILE), writePayload)
            val manifest = JSONObject()
                .put("v", MANIFEST_VERSION)
                .put("type", type)
                .put("uti_or_mime", mime)
                .put("name", name)
                .put("from_app", fromApp)
                .put("received_at", receivedAtMs)
            writeAtomically(File(itemDir, MANIFEST_FILE)) { out ->
                out.write(manifest.toString().toByteArray(Charsets.UTF_8))
            }
            return itemDir
        } catch (error: Throwable) {
            itemDir.deleteRecursively()
            throw error
        }
    }

    private fun writeAtomically(target: File, writer: (FileOutputStream) -> Unit) {
        val temp = File(target.parentFile, "${target.name}.tmp")
        try {
            FileOutputStream(temp).use { out ->
                writer(out)
                out.flush()
                out.fd.sync()
            }
            if (target.exists() && !target.delete()) {
                throw IOException("could not replace ${target.name}")
            }
            if (!temp.renameTo(target)) {
                throw IOException("could not rename ${temp.name} to ${target.name}")
            }
        } catch (error: Throwable) {
            temp.delete()
            throw error
        }
    }

    private const val HEX: String = "0123456789abcdef"
}
