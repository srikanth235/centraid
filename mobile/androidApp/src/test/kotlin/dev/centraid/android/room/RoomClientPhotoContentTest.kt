package dev.centraid.android.room

import android.graphics.BitmapFactory
import centraid.core.v1.ContentRef
import centraid.core.v1.ContentSource
import centraid.core.v1.ContentUrl
import centraid.core.v1.ContentUrls
import centraid.core.v1.Envelope
import centraid.core.v1.Response
import dev.centraid.core.CoreOutcome
import java.io.File
import java.util.Base64
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RoomClientPhotoContentTest {
    @Test
    fun canvasKeepsSeededPhotoIdsOpaqueAndLeavesPathsAndUrisAlone() {
        assertTrue(shouldResolvePhotoReference("photo:seeded-front"))
        assertFalse(shouldResolvePhotoReference("/app/files/photo.png"))
        assertFalse(shouldResolvePhotoReference("file:///app/files/photo.png"))
        assertFalse(shouldResolvePhotoReference("content://media/external/images/17"))
    }

    @Test
    fun resolvesSeededPhotoOwnerAndHashOnlyWhenCoreAllowsAnExistingStoreImage() = runTest {
        val png = smallPng()
        val decoded = BitmapFactory.decodeFile(png.absolutePath)
        assertNotNull("positive resolver fixture must be a decodable PNG", decoded)
        decoded.recycle()
        var asked = emptyList<ContentRef>()
        val client = RoomClient({ request ->
            asked = request.request?.content_urls?.refs.orEmpty()
            CoreOutcome.Answered(
                Envelope(
                    response = Response(
                        content_urls = ContentUrls(
                            urls = listOf(
                                ContentUrl(
                                    content_id = "photo:seeded-front",
                                    path = png.absolutePath,
                                    media_type = "image/png",
                                    embeddable = true,
                                    source = ContentSource.CONTENT_SOURCE_STORE,
                                ),
                                ContentUrl(
                                    content_id = "hash-present",
                                    path = png.absolutePath,
                                    media_type = "image/jpeg",
                                    embeddable = true,
                                    source = ContentSource.CONTENT_SOURCE_STORE,
                                ),
                                ContentUrl(
                                    content_id = "missing-store",
                                    path = File(png.parentFile, "missing.png").absolutePath,
                                    media_type = "image/png",
                                    embeddable = true,
                                    source = ContentSource.CONTENT_SOURCE_STORE,
                                ),
                                ContentUrl(
                                    content_id = "os-library-only",
                                    media_type = "image/jpeg",
                                    embeddable = true,
                                    source = ContentSource.CONTENT_SOURCE_OS_LIBRARY,
                                    os_ref = "asset:17",
                                ),
                                ContentUrl(
                                    content_id = "non-embeddable",
                                    path = png.absolutePath,
                                    media_type = "image/svg+xml",
                                    embeddable = false,
                                    source = ContentSource.CONTENT_SOURCE_STORE,
                                ),
                                ContentUrl(
                                    content_id = "video-store",
                                    path = png.absolutePath,
                                    media_type = "video/mp4",
                                    embeddable = true,
                                    source = ContentSource.CONTENT_SOURCE_STORE,
                                ),
                                // Core must not be able to smuggle an unrelated result into this map.
                                ContentUrl(
                                    content_id = "not-requested",
                                    path = png.absolutePath,
                                    media_type = "image/png",
                                    embeddable = true,
                                    source = ContentSource.CONTENT_SOURCE_STORE,
                                ),
                            ),
                        ),
                    ),
                ),
            )
        }, this)
        val scope = "client-a:room-42:people/photos"
        client.activatePhotoResolutionScope(scope)

        val paths = client.resolvePhotoPaths(
            scope,
            listOf("photo:seeded-front", "hash-present", "missing-store", "os-library-only", "non-embeddable", "video-store"),
        )

        assertEquals(
            listOf("photo:seeded-front", "hash-present", "missing-store", "os-library-only", "non-embeddable", "video-store"),
            asked.map { it.content_id },
        )
        assertTrue(asked.all { it.owner_type == "photo" && it.owner_id == it.content_id })
        assertEquals(
            mapOf("photo:seeded-front" to png.absolutePath, "hash-present" to png.absolutePath),
            paths,
        )
        png.delete()
    }

    @Test
    fun contentUrlBatchesNeverExceedOneHundredRefs() = runTest {
        val batchSizes = mutableListOf<Int>()
        val client = RoomClient({ request ->
            batchSizes += request.request?.content_urls?.refs.orEmpty().size
            CoreOutcome.Answered(Envelope(response = Response(content_urls = ContentUrls())))
        }, this)
        val scope = "client-a:room-42:photos"
        client.activatePhotoResolutionScope(scope)

        client.resolvePhotoPaths(scope, (0..100).map { "photo:seeded-$it" })

        assertEquals(listOf(100, 1), batchSizes)
    }

    @Test
    fun disposingOneComposedRoomScopeDoesNotInvalidateAnother() = runTest {
        val png = smallPng()
        val client = RoomClient({ request ->
            val refs = request.request?.content_urls?.refs.orEmpty()
            CoreOutcome.Answered(
                Envelope(
                    response = Response(
                        content_urls = ContentUrls(
                            urls = refs.map { ref ->
                                ContentUrl(
                                    content_id = ref.content_id,
                                    path = png.absolutePath,
                                    media_type = "image/png",
                                    embeddable = true,
                                    source = ContentSource.CONTENT_SOURCE_STORE,
                                )
                            },
                        ),
                    ),
                ),
            )
        }, this)
        val visibleRoot = "client-a:instance-1:photos"
        val visibleStage = "client-a:instance-2:photos"
        client.activatePhotoResolutionScope(visibleRoot)
        client.activatePhotoResolutionScope(visibleStage)

        client.clearPhotoResolutionScope(visibleStage)
        val paths = client.resolvePhotoPaths(visibleRoot, listOf("photo:seeded-front"))

        assertEquals(mapOf("photo:seeded-front" to png.absolutePath), paths)
        png.delete()
    }

    @Test
    @OptIn(ExperimentalCoroutinesApi::class)
    fun lateOwnerLookupFromPreviousVaultScopeIsDiscarded() = runTest {
        val oldStarted = CompletableDeferred<Unit>()
        val oldResponse = CompletableDeferred<CoreOutcome<Envelope>>()
        val png = smallPng()
        val client = RoomClient({ request ->
            val ref = request.request?.content_urls?.refs?.singleOrNull()?.content_id
            if (ref == "old-photo") {
                oldStarted.complete(Unit)
                oldResponse.await()
            } else {
                CoreOutcome.Answered(
                    Envelope(
                        response = Response(
                            content_urls = ContentUrls(
                                urls = listOf(
                                    ContentUrl(
                                        content_id = "new-photo",
                                        path = png.absolutePath,
                                        media_type = "image/png",
                                        embeddable = true,
                                        source = ContentSource.CONTENT_SOURCE_STORE,
                                    ),
                                ),
                            ),
                        ),
                    ),
                )
            }
        }, this)
        val oldScope = "client-a:instance-1:vault-a/photos"
        val newScope = "client-a:instance-2:vault-b/photos"
        client.activatePhotoResolutionScope(oldScope)
        val old = async { client.resolvePhotoPaths(oldScope, listOf("old-photo")) }
        oldStarted.await()

        client.clearPhotoResolutionScope(oldScope)
        client.activatePhotoResolutionScope(newScope)
        val current = client.resolvePhotoPaths(newScope, listOf("new-photo"))
        oldResponse.complete(
            CoreOutcome.Answered(
                Envelope(
                    response = Response(
                        content_urls = ContentUrls(
                            urls = listOf(
                                ContentUrl(
                                    content_id = "old-photo",
                                    path = png.absolutePath,
                                    media_type = "image/png",
                                    embeddable = true,
                                    source = ContentSource.CONTENT_SOURCE_STORE,
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        )
        runCurrent()

        assertEquals(mapOf("new-photo" to png.absolutePath), current)
        assertTrue("late results from a switched room/vault are discarded", old.await().isEmpty())
        png.delete()
    }

    private fun smallPng(): File = File.createTempFile("centraid-photo", ".png").apply {
        writeBytes(Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=="))
    }
}
