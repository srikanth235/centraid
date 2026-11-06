package dev.centraid.android.screens.locker

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import centraid.core.v1.LockerCategory
import centraid.core.v1.LockerFieldRow
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun LockerCategories(categories: List<LockerCategory>, onPick: (LockerCategory) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxWidth().padding(KitGeometry.GUTTER)) {
        val availableWidth = maxWidth
        val columns = if (availableWidth >= 300.dp && androidx.compose.ui.platform.LocalDensity.current.fontScale < 1.8f) 2 else 1
        FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            categories.forEach { category ->
                Column(Modifier.width((availableWidth - (10 * (columns - 1)).dp) / columns)
                    .clip(RoundedCornerShape(KitGeometry.RADIUS))
                    .background(centraidColor(if (category.selected) "lockerTint" else "bgElev"))
                    .clickable { onPick(category) }.padding(12.dp).heightIn(min = 80.dp).testTag("locker-category-${category.key}"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        CentraidIcon(category.icon_key, tint = centraidColor("lockerText"), size = 26.dp)
                        Spacer(Modifier.weight(1f))
                        Text(category.count_label, style = centraidType("title"), color = centraidColor("text"))
                    }
                    Text(category.label, style = centraidType("body"), color = centraidColor("text"))
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun LockerCodeCard(row: LockerFieldRow, onVerb: (String) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(KitGeometry.GUTTER).clip(RoundedCornerShape(KitGeometry.RADIUS))
        .background(centraidColor("bgElev")).padding(16.dp).testTag("locker-verification-code"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(row.label, style = centraidType("title"), color = centraidColor("text"))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp), itemVerticalAlignment = Alignment.CenterVertically) {
            Text(if (row.revealed) row.value_ else row.mask, style = centraidType("title").copy(fontFamily = FontFamily.Monospace), color = centraidColor("lockerText"), modifier = Modifier.testTag("locker-value-${row.key}"))
            row.countdown?.let { LockerCountdownRing(it) }
        }
        Text(row.note, style = centraidType("small"), color = centraidColor("textSoft"))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            row.verbs.forEach { verb -> OutlineButton(verb.label, testTag = "locker-verb-${row.key}-${verb.key}") { onVerb(verb.key) } }
        }
    }
}
