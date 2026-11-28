package dev.centraid.android.session

import android.content.Context
import centraid.core.v1.LibraryStage
import centraid.core.v1.RollPage
import dev.centraid.core.CentraidCore
import org.json.JSONArray
import org.json.JSONObject

/** Reads one bounded MediaStore page and streams each original through the core's Stage door. */
internal object CameraRollFollowReader {
    suspend fun read(
        context: Context,
        core: CentraidCore,
        cursor: String,
    ): String {
        val page = LibraryRoll.page(context, cursor, PAGE_SIZE)
        val stages = ArrayList<LibraryStageOutcome>(page.assets.size)
        var pageBytes = 0L
        var stagedCount = 0
        for (asset in page.assets) {
            if (stages.isNotEmpty() && asset.byteSize > MAX_PAGE_BYTES - pageBytes) break
            if (stages.isEmpty() && asset.byteSize > MAX_SINGLE_ASSET_BYTES) {
                throw IllegalStateException("Camera roll item exceeds the bounded staging size")
            }
            val stage = try {
                LibraryRoll.stage(
                    context,
                    core,
                    LibraryStage(ref = asset.ref, byte_size = asset.byteSize, changed_in_place = asset.changedInPlace),
                )
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                if (stages.isNotEmpty()) break
                throw failure
            }
            if (!stage.ready || stage.contentHash.length != 64 || stage.byteSize < 0L) {
                // A missing, revoked or unreadable asset means this page did not complete. Do not
                // advance its cursor or tell Core that the library was empty.
                if (stages.isNotEmpty()) break
                throw IllegalStateException("Camera roll item could not be staged")
            }
            if (!stage.mediaType.startsWith("image/") && !stage.mediaType.startsWith("video/")) {
                if (stages.isNotEmpty()) break
                throw IllegalStateException("Camera roll item is not an image or video")
            }
            if (stage.byteSize > MAX_SINGLE_ASSET_BYTES) {
                if (stages.isNotEmpty()) break
                throw IllegalStateException("Camera roll item exceeds the bounded staging size")
            }
            if (stages.isNotEmpty() && stage.byteSize > MAX_PAGE_BYTES - pageBytes) break
            stages += stage
            pageBytes += stage.byteSize
            stagedCount += 1
        }
        val boundedPage = boundedPage(page, stagedCount)
        return snapshotJson(boundedPage, stages)
    }

    internal fun boundedPage(page: RollPageResult, stagedCount: Int): RollPageResult =
        if (stagedCount < page.assets.size) {
            require(stagedCount > 0) { "A partial camera roll page must have at least one staged record" }
            val assets = page.assets.take(stagedCount)
            page.copy(assets = assets, nextCursor = assets.last().after, exhausted = false)
        } else {
            page
        }

    internal fun snapshotJson(
        page: RollPageResult,
        stages: List<LibraryStageOutcome>,
    ): String {
        require(stages.size == page.assets.size) { "Each camera roll row needs a staged original" }
        val records = JSONArray()
        page.assets.zip(stages).forEach { (asset, stage) ->
            val fields = JSONObject()
                .put("title", asset.title)
                .put("blob", stage.contentHash)
                .put("media_type", stage.mediaType)
            if (asset.width > 0) fields.put("width", asset.width)
            if (asset.height > 0) fields.put("height", asset.height)
            if (asset.durationSeconds > 0.0) fields.put("duration_s", asset.durationSeconds)
            fields.put("taken_at", asset.capturedAt)
            fields.put("offset_min", asset.offsetMinutes)
            if (asset.latitude != null && asset.longitude != null) {
                fields.put("lat", asset.latitude).put("lon", asset.longitude)
            }
            records.put(
                JSONObject()
                    .put("external_id", asset.ref)
                    .put("size", stage.byteSize)
                    .put("fields", fields),
            )
        }
        val origin = JSONObject()
            .put("ref", CAMERA_ROLL_REF)
            .put("label", CAMERA_ROLL_LABEL)
            .put("cursor", page.nextCursor)
        return JSONObject()
            .put("origin", origin)
            .put("records", records)
            .put("complete", page.exhausted)
            .toString()
    }

    private const val PAGE_SIZE = 64
    private const val MAX_PAGE_BYTES = 128L * 1024L * 1024L
    private const val MAX_SINGLE_ASSET_BYTES = 448L * 1024L * 1024L
    private const val CAMERA_ROLL_REF = "camera-roll"
    private const val CAMERA_ROLL_LABEL = "Camera roll"
}
