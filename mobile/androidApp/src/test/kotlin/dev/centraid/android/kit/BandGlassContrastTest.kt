package dev.centraid.android.kit

import androidx.test.core.app.ApplicationProvider
import androidx.compose.ui.graphics.Color
import dev.centraid.android.R
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
class BandGlassContrastTest {
    @Test
    @Config(qualifiers = "notnight")
    fun lightBandKeepsInkAndMetaLegibleOverBlackPhoto() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        val card = Color(context.getColor(R.color.centraid_surface_card))
        val plate = composite(Color.Black, BandGlass.tint(card, dark = false))
        val ink = Color(context.getColor(R.color.centraid_text_ink))
        val meta = Color(context.getColor(R.color.centraid_text_meta))

        assertTrue("ink contrast: ${contrast(plate, ink)}", contrast(plate, ink) >= 4.5)
        assertTrue("meta contrast: ${contrast(plate, meta)}", contrast(plate, meta) >= 4.5)
    }

    @Test
    @Config(qualifiers = "night")
    fun darkBandKeepsInkAndMetaLegibleOverWhitePhoto() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        val card = Color(context.getColor(R.color.centraid_surface_card))
        val plate = composite(Color.White, BandGlass.tint(card, dark = true))
        val ink = Color(context.getColor(R.color.centraid_text_ink))
        val meta = Color(context.getColor(R.color.centraid_text_meta))

        assertTrue("ink contrast: ${contrast(plate, ink)}", contrast(plate, ink) >= 4.5)
        assertTrue("meta contrast: ${contrast(plate, meta)}", contrast(plate, meta) >= 4.5)
    }

    private fun composite(source: Color, tint: Color): Color {
        val alpha = tint.alpha
        return Color(
            red = tint.red * alpha + source.red * (1f - alpha),
            green = tint.green * alpha + source.green * (1f - alpha),
            blue = tint.blue * alpha + source.blue * (1f - alpha),
            alpha = 1f,
        )
    }

    private fun contrast(first: Color, second: Color): Double {
        val firstLuminance = luminance(first)
        val secondLuminance = luminance(second)
        val lighter = maxOf(firstLuminance, secondLuminance)
        val darker = minOf(firstLuminance, secondLuminance)
        return (lighter + 0.05) / (darker + 0.05)
    }

    private fun luminance(color: Color): Double {
        fun linear(channel: Float): Double {
            val value = channel.toDouble()
            return if (value <= 0.04045) value / 12.92 else Math.pow((value + 0.055) / 1.055, 2.4)
        }

        return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue)
    }
}
