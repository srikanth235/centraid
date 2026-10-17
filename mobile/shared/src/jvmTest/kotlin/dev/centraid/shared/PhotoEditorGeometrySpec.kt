package dev.centraid.shared

import dev.centraid.shared.apps.photos.PhotoEditorMachine
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

/**
 * THE EDITOR'S GEOMETRY, as both renderers call it.
 *
 * SwiftUI cannot hand its plan to Wire's functions, so it used to restate the
 * clamp, the half-up round and the decode constants; [PhotoEditorMachine.cropRect]
 * is the primitive door it calls instead, and these pin what it must say.
 */
class PhotoEditorGeometrySpec : StringSpec({
    "no crop in the plan is the whole frame" {
        PhotoEditorMachine.cropRect(false, 0.4, 0.4, 0.2, 0.2, 4032, 3024) shouldBe
            PhotoEditorMachine.PixelRect(0, 0, 4032, 3024)
    }

    "a crop is clamped into the frame before it is rounded" {
        // A SIDE BELOW THE MINIMUM GROWS TO IT, and a rectangle running off the
        // edge is pulled back inside.
        PhotoEditorMachine.cropRect(true, 0.95, -0.2, 0.01, 2.0, 1000, 1000) shouldBe
            PhotoEditorMachine.PixelRect(900, 0, 100, 1000)
    }

    "a tie on a half pixel goes up, on both shells" {
        // 0.0625 AND 0.3125 ARE EXACT IN BINARY: half a pixel and two and a
        // half. Round-half-even would say 0 and 2.
        PhotoEditorMachine.cropRect(true, 0.0625, 0.0, 0.5, 0.5, 8, 8).x shouldBe 1
        PhotoEditorMachine.cropRect(true, 0.0, 0.0, 0.3125, 0.5, 8, 8).w shouldBe 3
    }

    "a rectangle never runs off the bitmap, whatever the rounding says" {
        val rect = PhotoEditorMachine.cropRect(true, 0.5, 0.5, 0.5, 0.5, 3, 3)
        (rect.x + rect.w <= 3) shouldBe true
        (rect.y + rect.h <= 3) shouldBe true
    }

    "the editor's header names the day the shutter fired on, or says there is none" {
        // THE SAME DAY THE LIBRARY AND THE VIEWER FILE IT UNDER: 23:30 UTC at
        // +01:00 is the next morning there.
        PhotoEditorMachine.editorMeta("2026-07-30T23:30:00.000Z", 60) shouldBe
            "from a photo taken 31 July 2026"
        PhotoEditorMachine.editorMeta("2026-07-30T17:42:00Z", 0) shouldBe
            "from a photo taken 30 July 2026"
        PhotoEditorMachine.editorMeta("", 0) shouldBe "from a photo"
        PhotoEditorMachine.editorMeta("not a time", 0) shouldBe "from a photo"
    }

    "the decode constants are the shared ones" {
        PhotoEditorMachine.PREVIEW_EDGE shouldBe 2048
        PhotoEditorMachine.JPEG_QUALITY_PERCENT shouldBe 92
        PhotoEditorMachine.MIN_CROP shouldBe 0.1
    }
})
