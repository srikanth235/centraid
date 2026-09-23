package dev.centraid.shared.apps.photos

/**
 * LOCATION TAKEN OUT OF THE BYTES (#816) — v0's `exif-location-strip.ts`,
 * ported whole.
 *
 * Leaving a place off the screen while handing the OS the original discloses
 * it anyway, so a copy sent with "No place" or "Place name only" goes through
 * this first. **A WALK, NOT A RE-ENCODE**: re-encoding loses the capture time
 * and the ORIENTATION, and a member's sideways photograph arriving sideways is
 * a defect this avoids by not decoding at all. What is removed:
 *
 * - the EXIF GPS IFD, ZEROED IN PLACE — TIFF offsets are absolute, so cutting
 *   the block out would shift every tag after it;
 * - the XMP packet, whole — it can carry `exif:GPSLatitude` a second time;
 * - the Photoshop/IPTC block, whole — it can carry a city and a sublocation.
 *
 * Maker notes and non-JPEG containers are out of its reach. [strip] answers
 * null for anything it cannot walk, and the caller then re-encodes or refuses;
 * **null never means "send the original"**.
 *
 * In the shared module because it is pure bytes and so provable with no
 * device; Android's hand-off calls it, and iOS takes the same three things out
 * with ImageIO's own metadata filter.
 */
public object ExifLocationStrip {
    /** What a walk removed. Empty is a real answer: the file carried none. */
    public enum class Removed { EXIF_GPS, XMP, IPTC }

    public class Result(public val bytes: ByteArray, public val removed: Set<Removed>)

    private const val MARKER = 0xFF
    private const val SOI = 0xD8
    private const val SOS = 0xDA
    private const val TEM = 0x01
    private const val LENGTHLESS_FIRST = 0xD0
    private const val LENGTHLESS_LAST = 0xD9
    private const val APP1 = 0xE1
    private const val APP13 = 0xED

    private const val EXIF_TAG = "Exif\u0000\u0000"
    private const val XMP_TAG = "http://ns.adobe.com/xap/1.0/\u0000"
    private const val PHOTOSHOP_TAG = "Photoshop 3.0\u0000"

    private const val GPS_IFD_TAG = 0x8825

    /** Bytes per TIFF value type, by the type's code. */
    private val TYPE_BYTES = mapOf(
        1 to 1, 2 to 1, 3 to 2, 4 to 4, 5 to 8, 6 to 1,
        7 to 1, 8 to 2, 9 to 4, 10 to 8, 11 to 4, 12 to 8,
    )

    /** A cyclic `next` pointer must not hang a share. */
    private const val MAX_IFD_HOPS = 8

    public fun isJpeg(bytes: ByteArray): Boolean =
        bytes.size > 4 && u8(bytes, 0) == MARKER && u8(bytes, 1) == SOI

    /** The copy with its location removed, or null when it cannot be walked. */
    public fun strip(bytes: ByteArray): Result? {
        if (!isJpeg(bytes)) return null
        val out = bytes.copyOf()
        val removed = mutableSetOf<Removed>()
        val kept = mutableListOf(0 to 2)
        var i = 2
        while (i + 1 < out.size) {
            if (u8(out, i) != MARKER) break
            val marker = u8(out, i + 1)
            if (standalone(marker)) {
                kept += i to i + 2
                i += 2
                continue
            }
            // PAST THE START OF SCAN THERE IS NO METADATA, only the picture.
            if (marker == SOS) break
            if (i + 3 >= out.size) break
            val length = (u8(out, i + 2) shl 8) or u8(out, i + 3)
            val segmentEnd = i + 2 + length
            if (length < 2 || segmentEnd > out.size) break
            val payload = i + 4
            var keep = true
            if (marker == APP1 && matches(out, payload, EXIF_TAG)) {
                if (scrubExifGps(out, payload + EXIF_TAG.length, segmentEnd)) {
                    removed += Removed.EXIF_GPS
                }
            } else if (marker == APP1 && matches(out, payload, XMP_TAG)) {
                keep = false
                removed += Removed.XMP
            } else if (marker == APP13 && matches(out, payload, PHOTOSHOP_TAG)) {
                keep = false
                removed += Removed.IPTC
            }
            if (keep) kept += i to segmentEnd
            i = segmentEnd
        }
        if (i < out.size) kept += i to out.size
        val total = kept.sumOf { (from, to) -> to - from }
        val result = ByteArray(total)
        var at = 0
        for ((from, to) in kept) {
            out.copyInto(result, at, from, to)
            at += to - from
        }
        return Result(result, removed)
    }

    private fun u8(bytes: ByteArray, at: Int): Int =
        if (at in bytes.indices) bytes[at].toInt() and 0xFF else 0

    private fun matches(bytes: ByteArray, at: Int, text: String): Boolean {
        if (at + text.length > bytes.size) return false
        return text.indices.all { u8(bytes, at + it) == text[it].code }
    }

    private fun standalone(marker: Int): Boolean =
        marker == TEM || marker in LENGTHLESS_FIRST..LENGTHLESS_LAST

    /** One TIFF block's bounds and its byte order. */
    private class Tiff(val bytes: ByteArray, val start: Int, val end: Int, val big: Boolean) {
        fun u16(at: Int): Int {
            val a = if (at in bytes.indices) bytes[at].toInt() and 0xFF else 0
            val b = if (at + 1 in bytes.indices) bytes[at + 1].toInt() and 0xFF else 0
            return if (big) (a shl 8) or b else (b shl 8) or a
        }

        fun u32(at: Int): Long {
            val a = u16(at).toLong()
            val b = u16(at + 2).toLong()
            return if (big) (a shl 16) or b else (b shl 16) or a
        }
    }

    private fun tiff(bytes: ByteArray, start: Int, end: Int): Tiff? {
        if (start + 8 > end) return null
        val order = u8(bytes, start)
        val big = order == 0x4D
        if (!big && order != 0x49) return null
        val block = Tiff(bytes, start, end, big)
        // 42: the TIFF byte-order check.
        if (block.u16(start + 2) != 42) return null
        return block
    }

    /** ZERO IN PLACE, the IFD and every value it points outside itself at. */
    private fun zeroIfd(tiff: Tiff, at: Int): Boolean {
        if (at < tiff.start + 8 || at + 2 > tiff.end) return false
        val count = tiff.u16(at)
        val blockEnd = at + 2 + count * 12 + 4
        if (count == 0 || blockEnd > tiff.end) return false
        for (k in 0 until count) {
            val entry = at + 2 + k * 12
            val size = TYPE_BYTES[tiff.u16(entry + 2)] ?: 0
            val total = size.toLong() * tiff.u32(entry + 4)
            // A VALUE OVER FOUR BYTES LIVES ELSEWHERE and needs its own zeroing.
            if (total > 4) {
                val valueAt = tiff.start + tiff.u32(entry + 8)
                if (valueAt >= tiff.start && valueAt + total <= tiff.end) {
                    tiff.bytes.fill(0, valueAt.toInt(), (valueAt + total).toInt())
                }
            }
        }
        tiff.bytes.fill(0, at, blockEnd)
        return true
    }

    private fun scrubExifGps(bytes: ByteArray, start: Int, end: Int): Boolean {
        val tiff = tiff(bytes, start, end) ?: return false
        var removed = false
        var offset = tiff.u32(tiff.start + 4)
        var hop = 0
        while (hop < MAX_IFD_HOPS && offset >= 8) {
            val at = tiff.start + offset
            if (at + 2 > tiff.end) break
            val ifd = at.toInt()
            val count = tiff.u16(ifd)
            if (ifd + 2 + count * 12 + 4 > tiff.end) break
            for (k in 0 until count) {
                val entry = ifd + 2 + k * 12
                if (tiff.u16(entry) != GPS_IFD_TAG) continue
                val gps = tiff.start + tiff.u32(entry + 8)
                if (gps <= Int.MAX_VALUE && zeroIfd(tiff, gps.toInt())) removed = true
            }
            offset = tiff.u32(ifd + 2 + count * 12)
            hop += 1
        }
        return removed
    }
}
