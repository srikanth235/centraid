package dev.centraid.android.screens.words

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.centraid.android.kit.AppMark
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry
import centraid.core.v1.HomeFirstLaunch

/**
 * THE FIRST-LAUNCH GATE: what a device that holds no vault opens onto, in
 * place of Home. Same screen as iOS `FirstLaunchView`.
 *
 * Every app's mark as one house, one sentence and the two doors, nothing else
 * (`DESIGN.md`'s empty state). Every word and the house's marks (Home's own
 * roster, #1129) are Rust's (`HomeState.first_launch`).
 *
 * **It decides nothing**: Home draws it while Rust says the phone holds no
 * vault; [onMake] and [onRestore] are Home's `MakePressed` and `RestorePressed`,
 * which push the words pages over it, so cancelling out of either lands back
 * here, and the gate goes only when the shelf holds a vault.
 */
@Composable
internal fun FirstLaunchScreen(gate: HomeFirstLaunch, onMake: () -> Unit, onRestore: () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .background(centraidColor("bg"))
            .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp, vertical = 24.dp)
            .testTag("first-launch"),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        // THE SENTENCE TAKES THE MIDDLE (the weight) and the doors sit at the
        // foot, as on iOS.
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.Center) {
            HouseMarks(gate.apps)
            Text(
                gate.body,
                style = centraidType("title"),
                color = centraidColor("text"),
                modifier = Modifier.semantics { heading() }.testTag("first-launch-body"),
            )
        }
        WordsControls(
            primary = gate.make_label,
            primaryEnabled = true,
            secondary = gate.restore_label,
            prefix = "first-launch",
            onPrimary = onMake,
            onSecondary = onRestore,
        )
    }
}

/**
 * EVERY APP'S MARK AS ONE HOUSE, as iOS draws it on its first slip: five to a
 * row at 40dp. A picture, not a list to read, so it is hidden from TalkBack.
 */
@Composable
private fun HouseMarks(apps: List<String>) {
    Column(
        Modifier
            .padding(bottom = 24.dp)
            .clearAndSetSemantics {}
            .testTag("first-launch-house"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        apps.chunked(5).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { appId -> AppMark(appId = appId, size = 40.dp) }
            }
        }
    }
}
