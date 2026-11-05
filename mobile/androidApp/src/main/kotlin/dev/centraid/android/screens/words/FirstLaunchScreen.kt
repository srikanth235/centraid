package dev.centraid.android.screens.words

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import centraid.core.v1.HomeFirstLaunch
import dev.centraid.android.kit.CentraidBrandMark
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/** One welcome page, with both actions always reachable, including at large text sizes. */
@Composable
internal fun FirstLaunchScreen(gate: HomeFirstLaunch, onMake: () -> Unit, onRestore: () -> Unit) {
    Column(
        Modifier.fillMaxSize()
            .background(centraidColor("bgList"))
            .verticalScroll(rememberScrollState())
            .testTag("first-launch"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(
            Modifier.widthIn(max = 560.dp).fillMaxWidth().padding(horizontal = 32.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            CentraidBrandMark(size = 104.dp)
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(gate.title, style = centraidType("display"), color = centraidColor("text"), textAlign = TextAlign.Center,
                    modifier = Modifier.semantics { heading() })
                Text(gate.body, style = centraidType("body"), color = centraidColor("textSoft"), textAlign = TextAlign.Center)
            }
            Column(Modifier.padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
                gate.slides.forEachIndexed { index, feature ->
                    Row(Modifier.fillMaxWidth().testTag("first-launch-feature-$index").semantics(mergeDescendants = true) { },
                        horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.Top) {
                        CentraidIcon(
                            iconKey = feature.icon_key, tint = centraidColor("shellText"), size = 20.dp,
                            modifier = Modifier.size(40.dp)
                                .background(centraidColor("shellTint"), RoundedCornerShape((LocalCentraidTokens.current.radii["md"] ?: 0).dp))
                                .padding(10.dp),
                        )
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(feature.title, style = centraidType("bodyStrong"), color = centraidColor("text"))
                            Text(feature.body, style = centraidType("body"), color = centraidColor("textSoft"))
                        }
                    }
                }
            }
            WordsControls(
                primary = gate.make_label, primaryEnabled = true, secondary = gate.restore_label,
                prefix = "first-launch", onPrimary = onMake, onSecondary = onRestore,
            )
        }
    }
}
