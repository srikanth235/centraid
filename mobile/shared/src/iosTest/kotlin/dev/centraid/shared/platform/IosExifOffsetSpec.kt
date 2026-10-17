@file:OptIn(ExperimentalForeignApi::class, BetaInteropApi::class)

package dev.centraid.shared.platform

import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ExperimentalForeignApi
import platform.Foundation.NSData
import platform.Foundation.NSFileManager
import platform.Foundation.NSTemporaryDirectory
import platform.Foundation.NSURL
import platform.Foundation.create
import platform.Foundation.writeToURL
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * THE iOS HALF OF A CAPTURE'S OFFSET (D-1025-S7-77).
 *
 * `exifOffsetTag` is what `captureOffsetOf` calls once Photos has handed over
 * a URL, so a file on disk is the whole of its input: these three are
 * 8x8 JPEGs ImageIO itself wrote, one with both tags (`+05:30` and `-08:00`),
 * one with only `OffsetTime` and one with neither, and the proof is that
 * ImageIO's reading comes back through [ExifOffset] as the zone the shutter
 * fired in — and that `OffsetTime` alone is never an offset. What needs a photo
 * library — Photos handing the URL over — is not provable here and is not
 * pretended to be: `receipts/issue-1025-sync-model.md` carries that as a
 * simulator walk.
 */
class IosExifOffsetSpec {
    private fun fileOf(name: String, base64: String): NSURL {
        val data = NSData.create(base64EncodedString = base64, options = 0u)
            ?: error("the fixture $name is not base64")
        val url = NSURL.fileURLWithPath(NSTemporaryDirectory() + "centraid-exif-" + name)
        check(data.writeToURL(url, atomically = true)) { "could not write $name" }
        return url
    }

    @Test
    fun a_shutters_own_offset_is_read_and_the_files_is_not() {
        val tag = exifOffsetTag(fileOf("both.jpg", BOTH))
        // THE SHUTTER'S, not the file's last change: +05:30, never -08:00,
        // though this file carries both.
        assertEquals("+05:30", tag)
        assertEquals(330, ExifOffset.of(tag))
    }

    @Test
    fun a_file_with_only_the_general_offset_is_utc_and_does_not_fall_back_to_it() {
        // D-1025-S7-77 AMENDED: `OffsetTime` is the zone of the file's last
        // change, and Photos' own capture time is already in the device's zone,
        // so applying it would move the wall clock off the shutter's.
        val tag = exifOffsetTag(fileOf("general.jpg", GENERAL))
        assertNull(tag)
        assertEquals(0, ExifOffset.of(tag))
    }

    @Test
    fun a_file_that_names_no_offset_is_utc_and_not_the_readers_zone() {
        val tag = exifOffsetTag(fileOf("none.jpg", NONE))
        assertNull(tag)
        // ZERO, THE OLD ANSWER. A phone stamping its own zone here would put a
        // library into wherever it was standing when it paired.
        assertEquals(0, ExifOffset.of(tag))
    }

    @Test
    fun a_file_that_is_gone_or_is_not_an_image_is_nothing_and_not_a_throw() {
        val missing = NSURL.fileURLWithPath(NSTemporaryDirectory() + "centraid-exif-missing.jpg")
        NSFileManager.defaultManager.removeItemAtURL(missing, null)
        assertNull(exifOffsetTag(missing))
        val text = NSData.create(base64EncodedString = "bm90IGFuIGltYWdl", options = 0u)!!
        val notImage = NSURL.fileURLWithPath(NSTemporaryDirectory() + "centraid-exif-text.jpg")
        check(text.writeToURL(notImage, atomically = true))
        assertNull(exifOffsetTag(notImage))
    }

    private companion object {
        val BOTH: String =
        "/9j/4AAQSkZJRgABAQAASABIAAD/4QCIRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAABZADAAIAAAAUAAAAXJAQ" +
        "AAIAAAAHAAAAcJARAAIAAAAHAAAAeKACAAQAAAABAAAACKADAAQAAAABAAAACAAAAAAyMDI2OjAyOjAzIDE1OjExOjAwAC0w" +
        "ODowMAAAKzA1OjMwAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+" +
        "/8AAEQgACAAIAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAAB" +
        "fQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldY" +
        "WVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh" +
        "4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAEC" +
        "dwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZX" +
        "WFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ" +
        "2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMABgYGBgYGCgYGCg4KCgoOEg4ODg4SFxISEhISFxwXFxcXFxccHBwcHBwcHCIiIiIi" +
        "IicnJycnLCwsLCwsLCwsLP/bAEMBBwcHCwoLEwoKEy4fGh8uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4u" +
        "Li4uLi4uLi4uLi4uLv/dAAQAAf/aAAwDAQACEQMRAD8ApUUUV8QfsJ//2Q=="

        val GENERAL: String =
        "/9j/4AAQSkZJRgABAQAASABIAAD/4QB0RXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAABJADAAIAAAAUAAAAUJAQ" +
        "AAIAAAAHAAAAZKACAAQAAAABAAAACKADAAQAAAABAAAACAAAAAAyMDI2OjAyOjAzIDE1OjExOjAwAC0wODowMAAA/+0AOFBo" +
        "b3Rvc2hvcCAzLjAAOEJJTQQEAAAAAAAAOEJJTQQlAAAAAAAQ1B2M2Y8AsgTpgAmY7PhCfv/AABEIAAgACAMBIgACEQEDEQH/" +
        "xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEU" +
        "MoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoOE" +
        "hYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4eLj5OXm5+jp6vHy8/T19vf4+fr/" +
        "xAAfAQADAQEBAQEBAQEBAAAAAAAAAQIDBAUGBwgJCgv/xAC1EQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIy" +
        "gQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqC" +
        "g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/" +
        "2wBDAAYGBgYGBgoGBgoOCgoKDhIODg4OEhcSEhISEhccFxcXFxcXHBwcHBwcHBwiIiIiIiInJycnJywsLCwsLCwsLCz/2wBD" +
        "AQcHBwsKCxMKChMuHxofLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi7/3QAEAAH/" +
        "2gAMAwEAAhEDEQA/AKVFFFfEH7Cf/9k="

        val NONE: String =
        "/9j/4AAQSkZJRgABAQAASABIAAD/4QBgRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA5ADAAIAAAAUAAAARKAC" +
        "AAQAAAABAAAACKADAAQAAAABAAAACAAAAAAyMDI2OjAyOjAzIDE1OjExOjAwAP/tADhQaG90b3Nob3AgMy4wADhCSU0EBAAA" +
        "AAAAADhCSU0EJQAAAAAAENQdjNmPALIE6YAJmOz4Qn7/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAA" +
        "AAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkK" +
        "FhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm" +
        "p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAA" +
        "AAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYk" +
        "NOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOk" +
        "paanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwAGBgYGBgYKBgYKDgoKCg4S" +
        "Dg4ODhIXEhISEhIXHBcXFxcXFxwcHBwcHBwcIiIiIiIiJycnJycsLCwsLCwsLCws/9sAQwEHBwcLCgsTCgoTLh8aHy4uLi4u" +
        "Li4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4u/90ABAAB/9oADAMBAAIRAxEAPwClRRRXxB+w" +
        "n//Z"
    }
}
