package dev.centraid.shared.platform

/**
 * A CAPTURE'S TIME-ZONE OFFSET, READ OFF ITS EXIF TAG (D-1025-S7-77, ruled
 * 2026-10-15).
 *
 * `captured_at` is a UTC instant and `photo.offset_min` is the zone the
 * shutter fired in, so a photograph keeps its capture DAY wherever the reader
 * stands (#419). Neither `PHAsset` nor MediaStore publishes that zone; the
 * camera wrote it into the file as `OffsetTimeOriginal`. A platform reads that
 * one tag — the reading is its own, ImageIO on iOS and `ExifInterface` on
 * Android — and hands the TEXT here, so the one rule for what a tag may say
 * lives once and is proved on the JVM.
 *
 * **Only the shutter's tag, never `OffsetTime`.** `OffsetTime` is the zone of
 * the file's LAST CHANGE, which an edit made elsewhere moves, and the capture
 * time the platform hands over is already a wall clock in the device's zone
 * (Photos builds `creationDate` that way). Applying a second, unrelated offset
 * to it would move the wall clock off the time on the shutter, so a photograph
 * that carries `OffsetTime` and no `OffsetTimeOriginal` is read as one that
 * carries neither.
 *
 * **Never the reader's zone.** The refused alternative is stamping the phone's
 * current offset, which would re-date a member's whole library into wherever
 * they stood when they paired. A photograph that names no usable offset is
 * UTC, which is what `captured_at` already is and what every capture carried
 * before this rule.
 */
public object ExifOffset {
    /**
     * `media.add_asset`'s own bound on `tz_offset_min`. **A value outside it is
     * not clamped but refused**: the vault rejects the whole write for it, so a
     * tag a buggy writer filled with `+99:99` would otherwise cost the member
     * the photograph and not merely its zone.
     */
    public const val LIMIT_MINUTES: Int = 1080

    /**
     * The offset to commit, in minutes east of UTC: `OffsetTimeOriginal` when it
     * parses, else 0. **There is no second tag to fall through to** — a present
     * but unusable `OffsetTimeOriginal` is UTC, the same as an absent one.
     */
    public fun of(offsetTimeOriginal: String?): Int = parse(offsetTimeOriginal) ?: 0

    /**
     * One tag's text as minutes east of UTC, or null when it names no offset.
     *
     * EXIF 2.31 writes `±HH:MM`. Three variants real writers produce are read
     * too, because each is unambiguous: `±HHMM`, `±HH` and `Z`. The spec's "not
     * known" filler (blanks and a colon), an empty tag, a sign with nothing
     * after it, minutes past 59 and anything beyond [LIMIT_MINUTES] are null.
     * The text is trimmed of blanks and the NUL an EXIF ASCII field ends with.
     */
    public fun parse(text: String?): Int? {
        val tag = text?.trim { it.isWhitespace() || it == '\u0000' }?.takeIf { it.isNotEmpty() } ?: return null
        if (tag == "Z" || tag == "z") return 0
        val sign = when (tag[0]) {
            '+' -> 1
            '-' -> -1
            else -> return null
        }
        val digits = tag.substring(1)
        val (hours, minutes) = when {
            digits.length == 5 && digits[2] == ':' -> digits.substring(0, 2) to digits.substring(3)
            digits.length == 4 -> digits.substring(0, 2) to digits.substring(2)
            digits.length == 2 -> digits to "00"
            else -> return null
        }
        if (!hours.all(::isAsciiDigit) || !minutes.all(::isAsciiDigit)) return null
        val minuteOfHour = minutes.toInt()
        if (minuteOfHour > MAX_MINUTE) return null
        val total = hours.toInt() * MINUTES_PER_HOUR + minuteOfHour
        return (sign * total).takeIf { it in -LIMIT_MINUTES..LIMIT_MINUTES }
    }

    // `Char.isDigit` accepts every script's digits, and `toInt` would then
    // throw on one it cannot read; the tag is ASCII or it is nothing.
    private fun isAsciiDigit(character: Char): Boolean = character in '0'..'9'

    private const val MINUTES_PER_HOUR: Int = 60
    private const val MAX_MINUTE: Int = 59
}
