package dev.centraid.shared

import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.string.shouldContain
import java.io.File

/**
 * THE WALKER'S PLATFORM FACTS NO MACHINE HERE CAN COMPILE (#1080, the walker).
 *
 * Neither native half of `MediaLibrary` builds in this container — Kotlin/Native
 * needs a macOS host and there is no Android SDK — so these are source scans,
 * as `BackgroundPassLawSpec`'s are, and each names the regression it exists
 * for. What a walk DOES with the platform's answers is `CameraRollStreamSpec`'s.
 *
 * | Fact | What happens when it is wrong |
 * |---|---|
 * | iOS streams from Photos with no temporary file | a second copy of the member's library on their disk, the thing ruling 6 removed |
 * | iOS downloads from iCloud only when the walker allows it | an original crosses a link the member's rule keeps it off |
 * | iOS finds additions by change token | an AirDropped photograph with an old date sorts behind the cursor and is never backed up |
 * | Android walks photographs AND videos | every video on an Android phone is left out of the backup |
 * | Android sizes from the descriptor | `available()` is what reads without blocking, not the length |
 * | Android asks for the original | the camera's GPS tags are redacted from the backed-up bytes |
 * | iOS names an edited asset's version in the render's ref, and stages the camera's file beside it | the deleter has no witness (A20(3)) and either keeps every edited photograph or deletes one whose latest edit is on no gateway |
 * | iOS finds the assets UPDATED since the token, and Android those with a later `DATE_MODIFIED`, marked so the walker names what they replace | an edit made after the import is never backed up, or arrives as a second photograph with no lineage and nothing folds (A20, R-1127-5) |
 * | neither platform reads a deletion as news | Photos mirrors a camera-roll deletion into the vault (R-1127-4) |
 * | both read the capture's EXIF `OffsetTimeOriginal` through `ExifOffset`, and neither reads `OffsetTime` | every photograph is filed at a zero offset again (D-1025-S7-77), and a late-evening shot in Kathmandu lands on the next day; or the file's last-change zone moves the wall clock off the shutter's |
 */
class WalkerPlatformLawSpec : StringSpec({

    val mobileRoot = File(
        System.getProperty("centraid.mobileRoot")
            ?: error("centraid.mobileRoot is unset; see mobile/shared/build.gradle.kts"),
    )

    /** The code with comments dropped, so a comment naming a trap is not the trap. */
    fun code(dir: String): String = mobileRoot.resolve(dir).walkTopDown()
        .filter { it.isFile && it.extension == "kt" }
        .joinToString("\n") { file ->
            file.readLines()
                .map { it.substringBefore("//") }
                .filterNot { it.trimStart().startsWith("*") }
                .joinToString("\n")
        }

    val ios = code("shared/src/iosMain")
    val android = code("shared/src/androidMain")

    "iOS streams a resource straight out of Photos, and makes no copy of it" {
        withClue("a temporary copy of a library original is back in iosMain") {
            ios.contains("NSTemporaryDirectory").shouldBeFalse()
            ios.contains("centraid-stage-").shouldBeFalse()
            ios.contains("writeDataForAssetResource").shouldBeFalse()
        }
        ios shouldContain "requestDataForAssetResource("
        // A STAGE THAT REFUSED HALF WAY lets go of the Photos request too.
        ios shouldContain "cancelDataRequest("
    }

    "iOS downloads from iCloud only when the walker said it may" {
        ios shouldContain "networkAccessAllowed = allowNetwork"
        withClue("an iCloud download is hard-coded on") {
            ios.contains("networkAccessAllowed = true").shouldBeFalse()
        }
    }

    "iOS stages the current rendition, names its version, and stages the camera's file beside an edit" {
        // A20: the edited render is the asset's bytes for v1. Its ref names the
        // `modificationDate` it was read at, which is the delete guard's
        // witness; the camera's own file is a resource of its own.
        ios shouldContain "edited = asset.hasAdjustments"
        ios shouldContain "PHAssetResourceTypeFullSizePhoto"
        ios shouldContain "LibraryRefs.rendition("
        ios shouldContain "asset.modificationDate"
        ios shouldContain "MediaLibrary.Resource.Role.CAMERA_ORIGINAL"
        ios shouldContain "LibraryRefs.camera("
        withClue("an edited asset is marked at the stage door again, and the core never offers it for deletion") {
            ios.contains("osEdited").shouldBeFalse()
            ios.contains("os_edited").shouldBeFalse()
        }
    }

    "iOS finds what was added since the last walk by its persistent change token" {
        ios shouldContain "fetchPersistentChangesSinceToken("
        ios shouldContain "insertedLocalIdentifiers"
        ios shouldContain "currentChangeToken"
    }

    "iOS finds an edit made in Photos as an UPDATED asset, and offers it only when it is edited" {
        ios shouldContain "updatedLocalIdentifiers"
        // A favourite or an album move is an update and not an edit.
        ios shouldContain "LibraryRefs.worthOffering("
    }

    "no platform turns a deletion from the library into news for the vault" {
        // R-1127-4: the vault is the photograph's backup, and Free up space
        // deletes from the camera roll itself. The change reads ask for what
        // was added and updated; a deleted identifier is never read.
        withClue("a deletion is read from the library's changes") {
            ios.contains("deletedLocalIdentifiers").shouldBeFalse()
        }
    }

    "Android finds an item edited in place by its DATE_MODIFIED" {
        android shouldContain "MediaStore.MediaColumns.DATE_MODIFIED"
        // The keyset still walks additions by `_ID`; the modified walk stays at or below it.
        android shouldContain "_ID} <= ?"
        // The edit is marked, so the walker looks up what the vault held for the
        // ref (`library_assets`) and the grid can fold the earlier version.
        android shouldContain "changedInPlace = changed"
        android shouldContain "captureGroupId = if (changed) ref else null"
    }

    "Android walks photographs and videos, sizes from the descriptor, and keeps the location" {
        android shouldContain "MediaStore.Files.getContentUri("
        android shouldContain "MEDIA_TYPE_IMAGE"
        android shouldContain "MEDIA_TYPE_VIDEO"
        android shouldContain "statSize"
        android shouldContain "MediaStore.setRequireOriginal("
        withClue("a length guessed from what can be read without blocking") {
            android.contains(".available()").shouldBeFalse()
        }
        withClue("Android 11 refuses LIMIT in a MediaStore sort order") {
            Regex("""ASC LIMIT""").containsMatchIn(android).shouldBeFalse()
        }
    }

    "both platforms read the capture's offset from the file and through the one rule" {
        // D-1025-S7-77: neither `PHAsset` nor MediaStore states a zone, so each
        // platform finds the one EXIF tag and hands its text to `ExifOffset`.
        ios shouldContain "ExifOffset.of("
        ios shouldContain "OffsetTimeOriginal"
        android shouldContain "ExifOffset.of("
        android shouldContain "TAG_OFFSET_TIME_ORIGINAL"
        withClue("`OffsetTime` is read again, and the wall clock moves off the shutter's") {
            // THE FALLBACK IS DROPPED (D-1025-S7-77, amended 2026-10-15): the
            // file's own tag is the zone of its last change, and Photos has
            // already built the capture time in the device's zone. The quoted
            // key and the constant's closing parenthesis are what tell the
            // general tag from the shutter's, which both begin the same way.
            ios.contains("OffsetTime\"").shouldBeFalse()
            android.contains("TAG_OFFSET_TIME)").shouldBeFalse()
        }
        withClue("an asset is described with a hard-coded zero offset again") {
            ios.contains("capturedUtcOffsetMinutes = 0").shouldBeFalse()
            android.contains("capturedUtcOffsetMinutes = 0").shouldBeFalse()
        }
        // THE OFFSET IS READ THROUGH PHOTOS' OWN URL, which the "downloads only
        // when the walker said" law above already holds to `networkAccessAllowed
        // = false`: describing a page must never download a library.
        ios shouldContain "PHContentEditingInputRequestOptions"
    }

    "both platforms draw the derivatives themselves" {
        ios shouldContain "requestImageForAsset("
        android shouldContain "loadThumbnail("
    }
})
