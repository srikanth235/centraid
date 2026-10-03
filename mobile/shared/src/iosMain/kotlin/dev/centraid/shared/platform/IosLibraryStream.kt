@file:OptIn(ExperimentalForeignApi::class, BetaInteropApi::class)

package dev.centraid.shared.platform

import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import platform.CoreGraphics.CGSizeMake
import platform.Foundation.NSData
import platform.Foundation.NSError
import platform.Foundation.NSKeyedArchiver
import platform.Foundation.NSKeyedUnarchiver
import platform.Foundation.base64EncodedStringWithOptions
import platform.Foundation.create
import platform.Photos.PHAsset
import platform.Photos.PHAssetResource
import platform.Photos.PHAssetResourceManager
import platform.Photos.PHAssetResourceRequestOptions
import platform.Photos.PHImageContentModeAspectFit
import platform.Photos.PHImageManager
import platform.Photos.PHImageRequestOptions
import platform.Photos.PHImageRequestOptionsDeliveryModeHighQualityFormat
import platform.Photos.PHImageRequestOptionsResizeModeExact
import platform.Photos.PHObjectTypeAsset
import platform.Photos.PHPersistentChangeToken
import platform.Photos.PHPhotoLibrary
import platform.UIKit.UIImage
import platform.UIKit.UIImageJPEGRepresentation

/**
 * THE WALKER'S PHOTOS HALF (#1080, the walker; ruling 6).
 *
 * **NOT COMPILED IN CI TODAY**, like the rest of `iosMain`: Kotlin/Native's iOS
 * targets need a macOS host. Every Photos call here is named in the lane D
 * section of the #1080 receipt so the owner's first build can check each one
 * against the SDK.
 *
 * Three things, each the platform's and none of them a decision:
 *
 * 1. [streamResource] — a resource's bytes straight out of Photos into the
 *    stage door. No temporary copy: the phone keeps no second copy of what
 *    the library holds, and `StageBegin.byte_size = 0` is "unknown" now
 *    (seam contract A8), which is what the copy existed to learn.
 * 2. [renderAsset] — a derivative drawn from the CURRENT edit by Photos itself,
 *    because the core cannot decode HEIC.
 * 3. [ChangeTokens] — the persistent change token (iOS 16; the app targets
 *    17.5) that finds an asset ADDED to the library whatever its capture date,
 *    which a `creationDate` keyset cannot: an AirDropped photograph from last
 *    year lands behind the cursor and was never offered.
 */
internal object IosLibraryStream {
    /**
     * `PHPhotosErrorNetworkAccessRequired`: the original is only in iCloud and
     * the request said not to download it. By number, because it is the
     * error's identity and the enum's Kotlin spelling is not.
     */
    const val NETWORK_ACCESS_REQUIRED: Long = 3164L

    /** How many Photos chunks wait for the stage door before Photos is made to wait. */
    const val BUFFERED_CHUNKS: Int = 4

    /** `crates/media/src/renditions.rs`' JPEG quality, as UIKit spells it. */
    const val JPEG_QUALITY: Double = 0.8
}

/**
 * ONE RESOURCE, STREAMED FROM PHOTOS (#1080 ruling 6).
 *
 * `requestDataForAssetResource` is a PUSH api: Photos calls the data handler
 * on its own queue with each chunk. The handler COPIES the chunk (Photos may
 * reuse the `NSData` the moment it returns) and hands it to a small channel,
 * blocking while the channel is full — that block is the backpressure, so a 4K
 * video is never in memory whole and Photos reads no faster than the stage door
 * hashes and seals. [close] cancels the request and the channel together, so a
 * stage that refused half way leaves no Photos queue waiting on nobody.
 *
 * Answers once the FIRST thing happens — a chunk, or the end — so an original
 * only in iCloud is [MediaLibrary.Opened.InCloud] before any stage begins.
 */
internal suspend fun streamResource(
    resource: PHAssetResource,
    mediaType: String,
    allowNetwork: Boolean,
): MediaLibrary.Opened {
    val stream = LibraryStream(mediaType)
    val options = PHAssetResourceRequestOptions()
    // ONLY WHEN THE PASS SAYS SO: downloading an iCloud original is a transfer
    // on the member's link, and the walker decided whether the rule allows it.
    options.networkAccessAllowed = allowNetwork
    val manager = PHAssetResourceManager.defaultManager()
    val request = manager.requestDataForAssetResource(
        resource,
        options,
        { data -> stream.deliver(data) },
        { error -> stream.finish(error) },
    )
    stream.cancel = { manager.cancelDataRequest(request) }
    val first = try {
        stream.first.await()
    } catch (cancelled: CancellationException) {
        stream.close()
        throw cancelled
    }
    return when (first) {
        LibraryStream.First.DATA -> MediaLibrary.Opened.Ready(stream)
        LibraryStream.First.IN_CLOUD -> MediaLibrary.Opened.InCloud.also { stream.close() }
        LibraryStream.First.NOTHING -> MediaLibrary.Opened.Gone.also { stream.close() }
    }
}

/** See [streamResource]. */
internal class LibraryStream(override val mediaType: String) : MediaLibrary.Original {
    enum class First { DATA, IN_CLOUD, NOTHING }

    /** PHOTOS STATES NO SIZE, and zero is "unknown" to the stage door (A8). */
    override val bytes: Long = 0L

    val first: CompletableDeferred<First> = CompletableDeferred()
    var cancel: () -> Unit = {}

    private val chunks = Channel<ByteArray>(IosLibraryStream.BUFFERED_CHUNKS)
    private var pending = ByteArray(0)
    private var offset = 0

    /** Photos' data handler, on Photos' own queue. */
    fun deliver(data: NSData?) {
        val chunk = data?.toByteArray() ?: return
        if (chunk.isEmpty()) return
        first.complete(First.DATA)
        try {
            // THE BLOCK IS THE BACKPRESSURE. See [streamResource].
            runBlocking { chunks.send(chunk) }
        } catch (gone: Exception) {
            // THE WALKER LET GO ([close]); Photos is being cancelled too.
        }
    }

    /** Photos' completion handler: the end, or why there is no more. */
    fun finish(error: NSError?) {
        if (error == null) {
            // NOTHING AT ALL is an empty resource, which is not a photograph.
            first.complete(First.NOTHING)
            chunks.close()
            return
        }
        first.complete(
            if (error.code == IosLibraryStream.NETWORK_ACCESS_REQUIRED) First.IN_CLOUD else First.NOTHING,
        )
        // A READ THAT BROKE THROWS: a truncated original staged as whole would
        // be committed under the truncation's hash as the member's photograph.
        chunks.close(IllegalStateException(error.localizedDescription))
    }

    override suspend fun read(max: Int): ByteArray {
        if (offset >= pending.size) {
            val next = chunks.receiveCatching()
            pending = next.getOrNull() ?: run {
                next.exceptionOrNull()?.let { throw IllegalStateException(it.message ?: "Photos stopped the read.") }
                return ByteArray(0)
            }
            offset = 0
        }
        val end = minOf(offset + max, pending.size)
        return pending.copyOfRange(offset, end).also { offset = end }
    }

    /** Cannot throw: it runs in the walker's `finally`. */
    override suspend fun close() {
        runCatching { cancel() }
        runCatching { chunks.cancel() }
    }
}

/**
 * A DERIVATIVE, DRAWN BY PHOTOS FROM THE CURRENT EDIT (#1080).
 *
 * Aspect-fit inside a square of the tier's edge, upright, at the core's JPEG
 * quality. `UIImageJPEGRepresentation` encodes pixels and no GPS, which is the
 * privacy property the core's own renditions keep. **No download**: Photos
 * draws a derivative from what this phone holds, and an original only in
 * iCloud still has a local thumbnail to draw from.
 */
internal suspend fun renderAsset(asset: PHAsset, edge: Int): ByteArray? {
    val options = PHImageRequestOptions()
    options.deliveryMode = PHImageRequestOptionsDeliveryModeHighQualityFormat
    options.resizeMode = PHImageRequestOptionsResizeModeExact
    options.networkAccessAllowed = false
    val image = suspendCancellableCoroutine<UIImage?> { continuation ->
        PHImageManager.defaultManager().requestImageForAsset(
            asset,
            CGSizeMake(edge.toDouble(), edge.toDouble()),
            PHImageContentModeAspectFit,
            options,
        ) { drawn, _ ->
            if (continuation.isActive) continuation.resume(drawn)
        }
    } ?: return null
    return UIImageJPEGRepresentation(image, IosLibraryStream.JPEG_QUALITY)?.toByteArray()
}

/**
 * THE PERSISTENT CHANGE TOKEN, KEPT AS TEXT (#1080, the walker's cursor).
 *
 * `PHPersistentChangeToken` is opaque and `NSSecureCoding`, so the cursor
 * carries it archived and base64'd. [insertedSince] answers every asset added
 * since the token, oldest change first, and the token of the newest change;
 * null when Photos will not answer — an expired token, which restarts the walk.
 */
internal object ChangeTokens {
    fun current(): String? = encode(PHPhotoLibrary.sharedPhotoLibrary().currentChangeToken)

    fun encode(token: PHPersistentChangeToken): String? =
        NSKeyedArchiver.archivedDataWithRootObject(token, true, null)?.base64EncodedStringWithOptions(0u)

    fun decode(text: String): PHPersistentChangeToken? {
        val data = NSData.create(base64EncodedString = text, options = 0u) ?: return null
        return NSKeyedUnarchiver.unarchivedObjectOfClass(PHPersistentChangeToken.`class`()!!, data, null)
            as? PHPersistentChangeToken
    }

    /** The added assets' identifiers in change order, and the newest token, or null. */
    fun insertedSince(text: String): Pair<List<String>, String?>? {
        val token = decode(text) ?: return null
        val changes = PHPhotoLibrary.sharedPhotoLibrary().fetchPersistentChangesSinceToken(token, null) ?: return null
        val inserted = LinkedHashSet<String>()
        var newest: PHPersistentChangeToken? = null
        changes.enumerateChangesWithBlock { change, _ ->
            val details = change?.changeDetailsForObjectType(PHObjectTypeAsset, null)
            // ONE CHANGE'S SET HAS NO ORDER; sorted, so a resumed page is the same page.
            details?.insertedLocalIdentifiers?.mapNotNull { it as? String }?.sorted()?.forEach { inserted += it }
            change?.changeToken?.let { newest = it }
        }
        return inserted.toList() to newest?.let { encode(it) }
    }
}
