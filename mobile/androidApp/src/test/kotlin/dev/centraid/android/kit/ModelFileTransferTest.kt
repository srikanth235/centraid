package dev.centraid.android.kit

import centraid.core.v1.ModelDownload
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.Rule

class ModelFileTransferTest {
    @get:Rule val temp = TemporaryFolder()

    @Test
    fun followsBoundedHttpsRedirectAndKeepsOnlyTheWholeVerifiedFile() = runTest {
        val bytes = "verified model bytes".toByteArray()
        val transfer = request("https://models.example/model", bytes)
        val calls = mutableListOf<String>()

        val completed = ModelFileTransfer.downloadTo(transfer, unmetered = true) { url ->
            calls += url.toString()
            if (calls.size == 1) {
                Connection(url, 302, header = "https://cdn.example/model")
            } else {
                Connection(url, 200, body = bytes)
            }
        }

        assertTrue(completed)
        assertEquals(listOf("https://models.example/model", "https://cdn.example/model"), calls)
        assertEquals(bytes.toList(), modelFile(transfer).readBytes().toList())
    }

    @Test
    fun wrongHashLeavesAnExistingVerifiedModelUntouched() = runTest {
        val bytes = "new model".toByteArray()
        val transfer = request("https://models.example/model", bytes).copy(sha256 = "0".repeat(64))
        val target = modelFile(transfer).apply { parentFile!!.mkdirs(); writeText("previous verified model") }

        val completed = ModelFileTransfer.downloadTo(transfer, unmetered = true) { url -> Connection(url, 200, body = bytes) }

        assertFalse(completed)
        assertEquals("previous verified model", target.readText())
    }

    @Test
    fun truncatedBodyDoesNotBecomeTheModel() = runTest {
        val full = "the complete model".toByteArray()
        val transfer = request("https://models.example/model", full)

        val completed = ModelFileTransfer.downloadTo(transfer, unmetered = true) { url ->
            Connection(url, 200, body = full.copyOf(full.size - 1), declaredLength = full.size.toLong())
        }

        assertFalse(completed)
        assertFalse(modelFile(transfer).exists())
    }

    @Test
    fun unmeteredTextAndVisionTransfersStayBoundToTheApprovedNetwork() = runTest {
        val bytes = "existing model".toByteArray()
        val transfer = request("https://models.example/projector", bytes).copy(vision = true, allow_cellular = false)
        val target = modelFile(transfer).apply { parentFile!!.mkdirs(); writeText("previous verified model") }
        val calls = mutableListOf<String>()
        val open = ModelFileTransfer.connectionOpener(
            transfer,
            openApproved = { url ->
                calls += "approved:${transfer.vision}:${url.host}"
                throw IOException("approved Wi-Fi network was lost")
            },
            openDefault = { url ->
                calls += "default:${url.host}"
                Connection(url, 200, body = bytes)
            },
        )

        val completed = ModelFileTransfer.downloadTo(transfer, unmetered = true, open = open)

        assertFalse(completed)
        assertEquals(listOf("approved:true:models.example"), calls)
        assertEquals("previous verified model", target.readText())
    }

    private fun request(url: String, bytes: ByteArray) = ModelDownload(
        url = url,
        file_name = "model.bin",
        sha256 = bytes.sha256(),
        bytes = bytes.size.toLong(),
        models_dir = temp.root.absolutePath,
        allow_cellular = false,
    )

    private fun modelFile(transfer: ModelDownload) = java.io.File(transfer.models_dir, transfer.file_name)

    private fun ByteArray.sha256() = MessageDigest.getInstance("SHA-256").digest(this)
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private class Connection(
        url: URL,
        private val status: Int,
        private val body: ByteArray = byteArrayOf(),
        private val header: String? = null,
        private val declaredLength: Long? = null,
    ) : HttpURLConnection(url) {
        override fun connect() = Unit
        override fun disconnect() = Unit
        override fun usingProxy() = false
        override fun getResponseCode() = status
        override fun getHeaderField(name: String?): String? = if (name.equals("Location", ignoreCase = true)) header else null
        override fun getInputStream(): InputStream = ByteArrayInputStream(body)
        override fun getContentLengthLong(): Long = if (status in 200..299) declaredLength ?: body.size.toLong() else -1L
    }
}
