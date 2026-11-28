package dev.centraid.android.kit

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Network
import centraid.core.v1.ModelDownload
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.coroutineContext
import kotlin.coroutines.resume

internal object ModelFileTransfer {
    suspend fun download(context: Context, transfer: ModelDownload): Boolean {
        // `allow_cellular` is the member's per-transfer consent, and `vision` distinguishes the
        // projector from the text model. If cellular is not allowed, pin every redirect and byte
        // read to the unmetered network we approved; a Wi-Fi loss must fail this attempt instead
        // of silently moving the socket onto mobile data.
        val approvedNetwork = if (transfer.allow_cellular) null else awaitUnmeteredNetwork(context) ?: return false
        return downloadTo(
            transfer,
            unmetered = transfer.allow_cellular || approvedNetwork != null,
            open = connectionOpener(
                transfer,
                openApproved = { url -> (approvedNetwork?.openConnection(url) ?: url.openConnection()) as HttpURLConnection },
                openDefault = { url -> url.openConnection() as HttpURLConnection },
            ),
        )
    }

    /** Cellular consent is per named text/projector transfer, not a one-time Wi-Fi check. */
    internal fun connectionOpener(
        transfer: ModelDownload,
        openApproved: (URL) -> HttpURLConnection,
        openDefault: (URL) -> HttpURLConnection,
    ): (URL) -> HttpURLConnection = if (transfer.allow_cellular) openDefault else openApproved

    internal suspend fun downloadTo(
        transfer: ModelDownload,
        unmetered: Boolean,
        open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
    ): Boolean = withContext(Dispatchers.IO) {
        val name = transfer.file_name
        val expectedBytes = transfer.bytes
        val expectedHash = transfer.sha256
        val url = runCatching { URL(transfer.url) }.getOrNull() ?: return@withContext false
        if (
            url.protocol != "https" || url.userInfo != null || name.isBlank() ||
            name == "." || name == ".." || name.contains('/') || name.contains('\\') ||
            expectedBytes <= 0 || expectedHash.length != 64 || !expectedHash.all { it in '0'..'9' || it in 'a'..'f' }
        ) return@withContext false

        val directory = File(transfer.models_dir).canonicalFile
        val target = File(directory, name).canonicalFile
        if (target.parentFile != directory) return@withContext false
        if (!transfer.allow_cellular && !unmetered) return@withContext false
        if (!directory.exists() && !directory.mkdirs()) return@withContext false
        val modelKind = if (transfer.vision) "vision" else "text"
        val partial = File(directory, ".$modelKind-$name.${java.util.UUID.randomUUID()}.part")
        var connection: HttpURLConnection? = null
        try {
            var currentUrl = url
            var redirects = 0
            var responseConnection: HttpURLConnection? = null
            while (true) {
                val nextConnection = open(currentUrl).apply {
                    instanceFollowRedirects = false
                    connectTimeout = 30_000
                    readTimeout = 30_000
                    requestMethod = "GET"
                    connect()
                }
                connection = nextConnection
                val response = nextConnection.responseCode
                if (response in REDIRECT_CODES) {
                    val location = nextConnection.getHeaderField("Location") ?: return@withContext false
                    nextConnection.disconnect()
                    if (redirects == MAX_REDIRECTS) return@withContext false
                    redirects += 1
                    currentUrl = URL(currentUrl, location)
                    if (currentUrl.protocol != "https" || currentUrl.userInfo != null) return@withContext false
                    continue
                }
                if (response !in 200..299) return@withContext false
                responseConnection = nextConnection
                break
            }
            val finalConnection = responseConnection
            if (finalConnection.responseCode !in 200..299) return@withContext false
            if (finalConnection.contentLengthLong >= 0 && finalConnection.contentLengthLong != expectedBytes) return@withContext false
            val digest = MessageDigest.getInstance("SHA-256")
            var copied = 0L
            finalConnection.inputStream.use { input ->
                partial.outputStream().buffered().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        coroutineContext.ensureActive()
                        val size = input.read(buffer)
                        if (size < 0) break
                        copied += size
                        if (copied > expectedBytes) return@withContext false
                        digest.update(buffer, 0, size)
                        output.write(buffer, 0, size)
                    }
                }
            }
            if (
                copied != expectedBytes ||
                digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xFF) } != expectedHash
            ) {
                return@withContext false
            }
            replaceVerified(target, partial)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            false
        } finally {
            connection?.disconnect()
            partial.delete()
        }
    }

    private fun onUnmeteredNetwork(context: Context): android.net.Network? {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return null
        val network = manager.activeNetwork ?: return null
        val capabilities = manager.getNetworkCapabilities(network) ?: return null
        return if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) &&
            (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
        ) network else null
    }

    private suspend fun awaitUnmeteredNetwork(context: Context): android.net.Network? {
        onUnmeteredNetwork(context)?.let { return it }
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return null
        return suspendCancellableCoroutine { continuation ->
            val finished = AtomicBoolean(false)
            lateinit var callback: ConnectivityManager.NetworkCallback
            fun unregister() {
                if (finished.compareAndSet(false, true)) {
                    runCatching { manager.unregisterNetworkCallback(callback) }
                }
            }
            fun resumeIfUnmetered(network: android.net.Network) {
                if (continuation.isActive && finished.compareAndSet(false, true)) {
                    runCatching { manager.unregisterNetworkCallback(callback) }
                    continuation.resume(network)
                }
            }
            fun checkNetwork(network: Network) {
                val capabilities = manager.getNetworkCapabilities(network) ?: return
                if (
                    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) &&
                    (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
                ) resumeIfUnmetered(network)
            }
            callback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = checkNetwork(network)

                override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) = checkNetwork(network)
            }
            try {
                manager.registerDefaultNetworkCallback(callback)
                continuation.invokeOnCancellation { unregister() }
                manager.activeNetwork?.let(::checkNetwork)
            } catch (_: Exception) {
                if (continuation.isActive && finished.compareAndSet(false, true)) continuation.resume(null)
            }
        }
    }

    private fun replaceVerified(target: File, partial: File): Boolean {
        val previous = if (target.exists()) File(target.parentFile, ".${target.name}.${java.util.UUID.randomUUID()}.previous") else null
        if (previous != null && !target.renameTo(previous)) return false
        if (partial.renameTo(target)) {
            previous?.delete()
            return true
        }
        if (previous != null) previous.renameTo(target)
        return false
    }

    private const val MAX_REDIRECTS = 5
    private val REDIRECT_CODES = setOf(301, 302, 303, 307, 308)
}
