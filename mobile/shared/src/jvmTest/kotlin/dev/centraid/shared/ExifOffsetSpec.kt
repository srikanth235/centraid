package dev.centraid.shared

import dev.centraid.shared.platform.ExifOffset
import dev.centraid.shared.platform.FakePlatformServices
import dev.centraid.shared.platform.MediaLibrary
import dev.centraid.shared.shell.CameraRoll
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain

/**
 * A CAPTURE KEEPS THE OFFSET IT WAS TAKEN IN (D-1025-S7-77, ruled 2026-10-15).
 *
 * The platforms read one EXIF tag, `OffsetTimeOriginal`, and hand its text to
 * [ExifOffset]; this is the one rule for what that text may say, and the proof
 * that what it answers reaches `media.add_asset`. `OffsetTime` is not read: the
 * ruling dropped the fallback to it, because Photos has already built the
 * capture time in the device's zone and a second offset moves the wall clock
 * off the shutter's. What the platforms DO to find the tag is theirs and is not
 * provable here: `WalkerPlatformLawSpec` scans that both call this.
 */
class ExifOffsetSpec : StringSpec({

    "the spec's own spelling, east and west" {
        ExifOffset.parse("+05:30") shouldBe 330
        ExifOffset.parse("-08:00") shouldBe -480
        ExifOffset.parse("+00:00") shouldBe 0
        ExifOffset.parse("+14:00") shouldBe 840
        ExifOffset.parse("-12:00") shouldBe -720
        // NEPAL: a quarter hour is a real zone, and a parser that read whole
        // hours would put Kathmandu's evenings on the wrong day.
        ExifOffset.parse("+05:45") shouldBe 345
        // NEGATIVE ZERO is still zero, not a refusal.
        ExifOffset.parse("-00:00") shouldBe 0
    }

    "the three variants real writers produce are read, because each is unambiguous" {
        ExifOffset.parse("+0530") shouldBe 330
        ExifOffset.parse("-0800") shouldBe -480
        ExifOffset.parse("+09") shouldBe 540
        ExifOffset.parse("Z") shouldBe 0
        ExifOffset.parse("z") shouldBe 0
    }

    "an EXIF ASCII field's padding does not make a tag unreadable" {
        // The field is NUL-terminated and some writers pad with blanks.
        ExifOffset.parse("+05:30\u0000") shouldBe 330
        ExifOffset.parse(" +05:30 ") shouldBe 330
    }

    "a tag that names no offset is null, never zero" {
        // NULL, NOT 0: `parse` says "this text names no offset", and `of` is
        // what turns that into UTC.
        ExifOffset.parse(null) shouldBe null
        ExifOffset.parse("") shouldBe null
        ExifOffset.parse("   ") shouldBe null
        // The spec's "not known" filler: blanks around a colon.
        ExifOffset.parse("  :  ") shouldBe null
        ExifOffset.parse("+") shouldBe null
        ExifOffset.parse("05:30") shouldBe null
        ExifOffset.parse("+5:30") shouldBe null
        ExifOffset.parse("+05:3") shouldBe null
        ExifOffset.parse("+05:30:00") shouldBe null
        ExifOffset.parse("+0x:30") shouldBe null
        ExifOffset.parse("UTC") shouldBe null
        // ARABIC-INDIC DIGITS are digits to `Char.isDigit` and not to EXIF.
        ExifOffset.parse("+٠٥:٣٠") shouldBe null
    }

    "minutes past fifty-nine are refused, not carried into the hours" {
        ExifOffset.parse("+05:60") shouldBe null
        ExifOffset.parse("+05:99") shouldBe null
    }

    "a value the vault would refuse is refused here, so one bad tag never costs the photograph" {
        // `photo.add` bounds `offset_min` at +-1080 and rejects the
        // WHOLE write beyond it; an offset that was clamped would be a lie and
        // one that was sent would lose the photograph.
        ExifOffset.LIMIT_MINUTES shouldBe 1080
        ExifOffset.parse("+18:00") shouldBe 1080
        ExifOffset.parse("-18:00") shouldBe -1080
        ExifOffset.parse("+18:01") shouldBe null
        ExifOffset.parse("-23:00") shouldBe null
        ExifOffset.parse("+99:99") shouldBe null
    }

    "OffsetTimeOriginal is the answer, and no tag is UTC" {
        ExifOffset.of("+05:30") shouldBe 330
        ExifOffset.of("-08:00") shouldBe -480
        ExifOffset.of(null) shouldBe 0
        ExifOffset.of("") shouldBe 0
    }

    "there is no second tag: the rule takes one argument and its absence is UTC" {
        // THE FALLBACK TO `OffsetTime` IS DROPPED (D-1025-S7-77, amended). The
        // file's own tag is the zone of its LAST CHANGE, which an edit made
        // elsewhere moves, and the wall clock the platform hands over is
        // already the device's. `of` has one parameter, so a photograph that
        // carries only `OffsetTime` reaches it as `null`, which is zero.
        ExifOffset.of(null) shouldBe 0
        // A present but unusable tag is UTC as well: nothing follows it.
        ExifOffset.of("  :  ") shouldBe 0
        ExifOffset.of("+99:99") shouldBe 0
        ExifOffset.of("garbage") shouldBe 0
    }

    "a stated UTC is UTC" {
        ExifOffset.of("+00:00") shouldBe 0
        ExifOffset.of("Z") shouldBe 0
    }

    "the offset a platform read is the offset the write carries" {
        val roll = CameraRoll(FakePlatformServices(), core = { null })
        val asset = MediaLibrary.Asset(
            localId = "9F1B2C3D-0000/L0/001",
            bytes = 0,
            // 09:41 UTC is 15:11 at +05:30: the DAY the shutter fired is the
            // instant plus this offset, which is what `offset_min` is for.
            capturedAtIso = "2026-02-03T09:41:00Z",
            capturedUtcOffsetMinutes = ExifOffset.of("+05:30"),
        )
        roll.inputFor(asset, "ab".repeat(32), 1L, "image/jpeg") shouldContain "\"offset_min\":330"
        val west = asset.copy(capturedUtcOffsetMinutes = ExifOffset.of("-08:00"))
        roll.inputFor(west, "ab".repeat(32), 1L, "image/jpeg") shouldContain "\"offset_min\":-480"
    }
})
