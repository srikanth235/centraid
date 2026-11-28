package dev.centraid.android.share

import android.content.Intent
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class ShareInboxWriterTest {
    private fun tempInbox(): File = Files.createTempDirectory("centraid-share-inbox-test").toFile()

    @Test
    fun writesTextItemWithManifestV1Schema() {
        val inbox = tempInbox()
        try {
            assertFalse(ShareInboxWriter.hasPendingItems(inbox))
            val uuid = ShareInboxWriter.newUuidV7(1_732_680_000_000L)
            val dir = ShareInboxWriter.writeTextOrUrl(
                inboxDir = inbox,
                text = "Buy oat milk\nand coffee beans",
                fromApp = "com.example.notes",
                name = "Groceries",
                receivedAtMs = 1_732_680_000_000L,
                uuid = uuid,
            )

            assertTrue(ShareInboxWriter.hasPendingItems(inbox))
            assertEquals(uuid, dir.name)
            assertEquals("Buy oat milk\nand coffee beans", File(dir, ShareInboxWriter.PAYLOAD_FILE).readText())
            val manifest = JSONObject(File(dir, ShareInboxWriter.MANIFEST_FILE).readText())
            assertEquals(1, manifest.getInt("v"))
            assertEquals("text", manifest.getString("type"))
            assertEquals("text/plain", manifest.getString("uti_or_mime"))
            assertEquals("Groceries", manifest.getString("name"))
            assertEquals("com.example.notes", manifest.getString("from_app"))
            assertEquals(1_732_680_000_000L, manifest.getLong("received_at"))
            assertEquals(setOf("payload", "manifest.json"), dir.list()?.toSet())
        } finally {
            inbox.deleteRecursively()
        }
    }

    @Test
    fun classifiesAndWritesUrlItem() {
        val inbox = tempInbox()
        try {
            val dir = ShareInboxWriter.writeTextOrUrl(
                inboxDir = inbox,
                text = "https://centraid.dev/guide?tab=1",
                fromApp = "org.mozilla.firefox",
                name = "Guide",
                receivedAtMs = 1_732_680_001_000L,
            )

            assertEquals("https://centraid.dev/guide?tab=1", File(dir, ShareInboxWriter.PAYLOAD_FILE).readText())
            val manifest = JSONObject(File(dir, ShareInboxWriter.MANIFEST_FILE).readText())
            assertEquals(1, manifest.getInt("v"))
            assertEquals("url", manifest.getString("type"))
            assertEquals("text/uri-list", manifest.getString("uti_or_mime"))
            assertEquals("org.mozilla.firefox", manifest.getString("from_app"))
            assertEquals("text", ShareInboxWriter.classifyText("Read https://centraid.dev later"))
        } finally {
            inbox.deleteRecursively()
        }
    }

    @Test
    fun writesSingleFileAtomicallyWithUuidV7() {
        val inbox = tempInbox()
        try {
            val payloadBytes = byteArrayOf(0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x37)
            val dir = ShareInboxWriter.writeFile(
                inboxDir = inbox,
                source = ByteArrayInputStream(payloadBytes),
                mime = "application/pdf",
                name = "receipt.pdf",
                fromApp = "com.android.documentsui",
                receivedAtMs = 1_732_680_002_000L,
            )

            assertTrue("uuid must be lowercase RFC 9562 UUIDv7", isUuidV7(dir.name))
            assertArrayEquals(payloadBytes, File(dir, ShareInboxWriter.PAYLOAD_FILE).readBytes())
            val manifest = JSONObject(File(dir, ShareInboxWriter.MANIFEST_FILE).readText())
            assertEquals(1, manifest.getInt("v"))
            assertEquals("file", manifest.getString("type"))
            assertEquals("application/pdf", manifest.getString("uti_or_mime"))
            assertEquals("receipt.pdf", manifest.getString("name"))
            assertEquals("com.android.documentsui", manifest.getString("from_app"))
            assertEquals(setOf("payload", "manifest.json"), dir.list()?.toSet())
        } finally {
            inbox.deleteRecursively()
        }
    }

    @Test
    fun writesMultipleFilesIntoDistinctDirectories() {
        val inbox = tempInbox()
        try {
            val first = ShareInboxWriter.writeFile(
                inboxDir = inbox,
                source = ByteArrayInputStream("img-1".toByteArray()),
                mime = "image/jpeg",
                name = "one.jpg",
                receivedAtMs = 1_732_680_003_000L,
            )
            val second = ShareInboxWriter.writeFile(
                inboxDir = inbox,
                source = ByteArrayInputStream("img-2".toByteArray()),
                mime = "image/png",
                name = "two.png",
                receivedAtMs = 1_732_680_004_000L,
            )

            assertTrue(first.name != second.name)
            assertEquals(setOf(first.name, second.name), inbox.list()?.toSet())
            assertEquals("img-1", File(first, ShareInboxWriter.PAYLOAD_FILE).readText())
            assertEquals("img-2", File(second, ShareInboxWriter.PAYLOAD_FILE).readText())
        } finally {
            inbox.deleteRecursively()
        }
    }

    @Test
    fun idempotentDirectoryLayoutByUuidAndFailedWriteCleanup() {
        val inbox = tempInbox()
        try {
            val uuid = ShareInboxWriter.newUuidV7(1_732_680_005_000L)
            ShareInboxWriter.writeText(inbox, "first", uuid = uuid, receivedAtMs = 1_732_680_005_000L)
            val rewritten = ShareInboxWriter.writeText(inbox, "second", uuid = uuid, receivedAtMs = 1_732_680_006_000L)

            assertEquals(listOf(uuid), inbox.list()?.toList())
            assertEquals("second", File(rewritten, ShareInboxWriter.PAYLOAD_FILE).readText())
            assertEquals(setOf("payload", "manifest.json"), rewritten.list()?.toSet())

            val failingStream = object : InputStream() {
                override fun read(): Int = throw IOException("stream interrupted")
            }
            val failedUuid = ShareInboxWriter.newUuidV7(1_732_680_007_000L)
            var threw = false
            try {
                ShareInboxWriter.writeFile(inbox, failingStream, "application/pdf", "broken.pdf", uuid = failedUuid)
            } catch (_: IOException) {
                threw = true
            }
            assertTrue(threw)
            assertFalse(File(inbox, failedUuid).exists())
            assertEquals(listOf(uuid), inbox.list()?.toList())
        } finally {
            inbox.deleteRecursively()
        }
    }

    @Test
    fun receiverIngestHandlesActionSendAndActionSendMultiple() {
        val app = RuntimeEnvironment.getApplication()
        val inbox = tempInbox()
        try {
            val sendUrl = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, "https://example.org/article")
                putExtra(Intent.EXTRA_SUBJECT, "Article")
            }
            assertEquals(1, ShareInReceiverActivity.ingest(app, sendUrl, "com.example.browser", inbox))

            val sendMultiple = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
                type = "text/plain"
                putStringArrayListExtra(Intent.EXTRA_TEXT, arrayListOf("First note", "Second note"))
            }
            assertEquals(2, ShareInReceiverActivity.ingest(app, sendMultiple, "com.example.chat", inbox))

            val items = inbox.listFiles()?.filter { it.isDirectory }.orEmpty()
            assertEquals(3, items.size)
            val types = items.map { JSONObject(File(it, ShareInboxWriter.MANIFEST_FILE).readText()).getString("type") }.sorted()
            assertEquals(listOf("text", "text", "url"), types)
        } finally {
            inbox.deleteRecursively()
        }
    }

    private fun isUuidV7(id: String): Boolean {
        if (id.length != 36) return false
        return id.indices.all { index ->
            val ch = id[index]
            when (index) {
                8, 13, 18, 23 -> ch == '-'
                14 -> ch == '7'
                19 -> ch in listOf('8', '9', 'a', 'b')
                else -> ch in '0'..'9' || ch in 'a'..'f'
            }
        }
    }
}
