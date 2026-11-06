package dev.centraid.android.screens.money

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.core.v1.MoneyWeeklySeries
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/** Geometry only: category assignments, amounts and segment heights are Rust's. */
@Composable
internal fun MoneyWeeklyChart(series: MoneyWeeklySeries) {
    Column(Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
        .background(centraidColor("bgElev"), moneyRadius("lg")).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(series.heading, style = centraidType("smallStrong"), color = centraidColor("text"), modifier = Modifier.semantics { heading() })
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            series.weeks.forEach { week ->
                Column(Modifier.width(48.dp * LocalDensity.current.fontScale).clearAndSetSemantics { contentDescription = week.accessibility_label },
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Column(Modifier.fillMaxWidth().height(140.dp).clip(moneyRadius("sm")), verticalArrangement = Arrangement.Bottom) {
                        week.segments.forEach { segment ->
                            Box(Modifier.fillMaxWidth().height(140.dp * segment.height_bp.toFloat() / 10_000f)
                                .background(centraidColor(segment.color_key)).semantics { contentDescription = segment.label })
                        }
                    }
                    Text(week.total, style = centraidType("annotLabelOn"), color = centraidColor("text"))
                    Text(week.label, style = centraidType("annotLabel"), color = centraidColor("textSoft"))
                }
            }
        }
    }
}

@Composable
internal fun MoneyDayHeader(title: String, total: String) {
    val modifier = Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER).padding(top = 20.dp, bottom = 8.dp).semantics(mergeDescendants = true) { heading() }
    if (LocalDensity.current.fontScale > 1.3f) {
        Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = centraidType("annotLabelOn"), color = centraidColor("textSoft"))
            Text(total, style = centraidType("annotLabelOn"), color = centraidColor("textSoft"))
        }
    } else {
        Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(title, Modifier.weight(1f), style = centraidType("annotLabelOn"), color = centraidColor("textSoft"))
            Text(total, style = centraidType("annotLabelOn"), color = centraidColor("textSoft"))
        }
    }
}
