package dev.centraid.android.kit

import androidx.compose.material3.SliderDefaults
import dev.centraid.android.theme.centraidColor
import androidx.compose.material3.Slider
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import kotlin.math.roundToInt

/** Native adjustment over chart buckets; the core owns the selected words. */
@Composable
internal fun ChartScrubber(label: String, valueLabel: String, index: Int, count: Int, onSelect: (Int) -> Unit) {
    if (count > 1) {
        Slider(
            colors = SliderDefaults.colors(thumbColor = centraidColor("healthFill"), activeTrackColor = centraidColor("healthFill"), inactiveTrackColor = centraidColor("healthTint")),
            value = index.toFloat(),
            onValueChange = { onSelect(it.roundToInt()) },
            valueRange = 0f..(count - 1).toFloat(),
            steps = (count - 2).coerceAtLeast(0),
            modifier = Modifier.testTag("health-metric-scrubber").semantics {
                contentDescription = label
                stateDescription = valueLabel
            },
        )
    }
}
