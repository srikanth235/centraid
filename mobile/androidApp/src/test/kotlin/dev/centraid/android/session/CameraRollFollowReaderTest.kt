package dev.centraid.android.session

import centraid.core.v1.FollowGrant
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CameraRollFollowReaderTest {
    @Test
    fun snapshotCarriesStageHashMediaStoreCursorAndStableAssetReference() {
        val page = RollPageResult(
            assets = listOf(
                RollAssetRecord(
                    after = "cursor-next",
                    video = true,
                    byteSize = 91,
                    title = "trip.mp4",
                    capturedAt = "2025-07-01T10:00:00Z",
                    offsetMinutes = 0,
                    captureGroup = "",
                    changedInPlace = false,
                    ref = "video:42",
                    width = 1920,
                    height = 1080,
                    durationSeconds = 4.5,
                    latitude = null,
                    longitude = null,
                ),
            ),
            nextCursor = "cursor-next",
            exhausted = false,
        )
        val stage = LibraryStageOutcome(
            ready = true,
            mediaType = "video/mp4",
            contentHash = "a".repeat(64),
            byteSize = 91,
        )

        val json = JSONObject(CameraRollFollowReader.snapshotJson(page, listOf(stage)))
        assertEquals("camera-roll", json.getJSONObject("origin").getString("ref"))
        assertEquals("cursor-next", json.getJSONObject("origin").getString("cursor"))
        assertFalse(json.getBoolean("complete"))
        val record = json.getJSONArray("records").getJSONObject(0)
        assertEquals("video:42", record.getString("external_id"))
        assertEquals(91, record.getInt("size"))
        assertEquals("a".repeat(64), record.getJSONObject("fields").getString("blob"))
        assertEquals("video/mp4", record.getJSONObject("fields").getString("media_type"))
        assertEquals(4.5, record.getJSONObject("fields").getDouble("duration_s"), 0.0)
    }

    @Test
    fun emptyMediaStoreTraversalIsCompleteAndThePassGrantCarriesLimitedAccess() {
        val empty = RollPageResult(emptyList(), "after-empty", exhausted = true)
        val full = JSONObject(CameraRollFollowReader.snapshotJson(empty, emptyList()))
        val limited = JSONObject(CameraRollFollowReader.snapshotJson(empty, emptyList()))
        assertTrue(full.getBoolean("complete"))
        assertTrue(limited.getBoolean("complete"))
        assertTrue(grantAllowsSnapshot("camera_roll", FollowGrant.FOLLOW_GRANT_LIMITED))
        assertEquals(0, full.getJSONArray("records").length())
        assertEquals(0, limited.getJSONArray("records").length())
    }

    @Test
    fun byteBoundedPrefixResumesFromLastStagedAssetWithoutSkippingRemainder() {
        val first = RollAssetRecord(
            after = "after-first", video = false, byteSize = 8, title = "one.jpg",
            capturedAt = "2025-07-01T10:00:00Z", offsetMinutes = 0, captureGroup = "",
            changedInPlace = false, ref = "image:1", width = 4, height = 3,
            durationSeconds = 0.0, latitude = null, longitude = null,
        )
        val second = first.copy(after = "after-second", title = "two.jpg", ref = "image:2")
        val page = RollPageResult(listOf(first, second), "after-second", exhausted = true)

        val prefix = CameraRollFollowReader.boundedPage(page, stagedCount = 1)

        assertEquals(listOf(first), prefix.assets)
        assertEquals("after-first", prefix.nextCursor)
        assertFalse(prefix.exhausted)
    }
}
