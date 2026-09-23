package dev.centraid.android.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import centraid.screen.v1.FreeUpSpace
import centraid.screen.v1.KeepOriginalsRow
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.shared.apps.photos.KeepOriginals

/**
 * "KEEP ORIGINALS ON THIS PHONE" (#1029, photos port — v0's `AlbumDetail.tsx`
 * keep row).
 *
 * A switch that says what it does underneath it. The line is the reducer's
 * (`KeepOriginals.meta`), derived from the switch, so it never states a fact
 * the switch contradicts; until the keep list answers for this album the
 * switch is disabled and the line says it is checking, because a claim about
 * what freeing space would take is not one to guess at.
 *
 * **It holds still while a change is on its way.** The flip shows at once and
 * the list's answer is what settles it; a second flip before that would be a
 * race the member could not see.
 *
 * The SwiftUI twin is `KeepOriginalsRowView` in `PhotoShelfView.swift`.
 */
@Composable
internal fun KeepOriginalsRowView(row: KeepOriginalsRow, onToggle: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(text = KeepOriginals.TITLE, style = centraidType("body"), color = centraidColor("text"))
            Text(text = row.meta, style = centraidType("small"), color = centraidColor("textSoft"))
        }
        Switch(
            checked = row.keep,
            onCheckedChange = onToggle,
            enabled = row.ready && !row.saving,
            colors = SwitchDefaults.colors(
                checkedTrackColor = centraidColor("accent"),
                uncheckedTrackColor = centraidColor("bgSunken"),
            ),
            modifier = Modifier.semantics {
                contentDescription = KeepOriginals.LABEL
                stateDescription = row.meta
            },
        )
    }
}

/**
 * THE MORE SHEET'S "FREE UP SPACE" ROW — A STATEMENT, NOT A BUTTON
 * (`KeepOriginals.kt`). v0's row deleted originals whose copy elsewhere was
 * proved; the laptop's backup does not hold originals yet, so every one here is
 * the only copy, and the row says so with the count and the size rather than
 * offering a verb that could only destroy a photograph.
 *
 * The SwiftUI twin is `FreeUpSpaceRow` in `PhotosMoreSheet.swift`.
 */
@Composable
internal fun FreeUpSpaceRowView(freeUp: FreeUpSpace?) {
    val meta = freeUp?.meta ?: KeepOriginals.COUNTING
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp)
            // ONE SPOKEN ELEMENT: the title and the census's line.
            .semantics(mergeDescendants = true) {},
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            CentraidIcon(iconKey = "Gauge", tint = centraidColor("text"))
            Column {
                Text(text = KeepOriginals.FREE_UP_TITLE, style = centraidType("body"), color = centraidColor("text"))
                Text(text = meta, style = centraidType("small"), color = centraidColor("textSoft"))
            }
        }
        val reason = freeUp?.reason.orEmpty()
        if (reason.isNotEmpty()) {
            Text(text = reason, style = centraidType("small"), color = centraidColor("textSoft"))
        }
    }
}
