package dev.centraid.android.screens.words

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.res.dimensionResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import centraid.core.v1.HomeFirstLaunch
import centraid.core.v1.HomeFirstLaunchSlide
import dev.centraid.android.R
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.CentraidMark
import dev.centraid.android.kit.tokenColor
import dev.centraid.android.kit.tokenSp
import dev.centraid.android.theme.centraidDark

/**
 * THE WELCOME SCREEN (#1173): what a device that holds no vault opens onto, in
 * place of Home. Same screen as iOS `FirstLaunchView`, from
 * `design/mockups/Welcome.dc.html`: one native screen, not a deck. The mark, a
 * title, one sentence, the three things the app is (apps on this phone, an
 * assistant on this phone, encrypted backups) and two doors.
 *
 * **It decides nothing**: Home draws it while Rust says the phone holds no vault;
 * every word is Rust's (`HomeState.first_launch`, the claims in the order it
 * lists them). [onMake] and [onRestore] are Home's `MakePressed` and
 * `RestorePressed`, which push the words pages over it, so cancelling out of
 * either lands back here, and the screen goes only when the shelf holds a vault.
 * Pairing a backup device stays out of first run: Home leads there once a vault
 * exists.
 */
@Composable
internal fun FirstLaunchScreen(gate: HomeFirstLaunch, onMake: () -> Unit, onRestore: () -> Unit) {
    val dark = centraidDark()
    val page = tokenColor(if (dark) R.color.centraid_surface_page else R.color.centraid_surface_plain_page_light)
    Column(
        Modifier
            .fillMaxSize()
            .background(page)
            .testTag("first-launch"),
    ) {
        Column(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = SIDE.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.size(56.dp))
            MarkTile()
            Text(
                gate.title,
                modifier = Modifier
                    .padding(top = 28.dp)
                    .semantics { heading() }
                    .testTag("first-launch-title"),
                color = tokenColor(R.color.centraid_text_ink),
                fontSize = TITLE_SP.sp,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
            )
            Text(
                gate.body,
                modifier = Modifier.padding(top = 8.dp),
                color = tokenColor(R.color.centraid_text_meta),
                fontSize = tokenSp(R.dimen.centraid_text_row),
                textAlign = TextAlign.Center,
            )
            Column(
                Modifier.padding(top = 36.dp).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(22.dp),
            ) {
                gate.slides.forEachIndexed { index, claim -> Claim(index, claim) }
            }
            Spacer(Modifier.size(16.dp))
        }
        Doors(gate, onMake, onRestore)
    }
}

/** The app icon: the mark on a white tile with a hairline edge (white in dark too, as on the icon board). */
@Composable
private fun MarkTile() {
    val shape = RoundedCornerShape(TILE_RADIUS.dp)
    Box(
        Modifier
            .size(TILE.dp)
            .clip(shape)
            .background(Color.White)
            .border(BorderStroke(1.dp, tokenColor(R.color.centraid_surface_border)), shape)
            .clearAndSetSemantics {},
        contentAlignment = Alignment.Center,
    ) {
        CentraidMark(size = (TILE * 76 / 120).dp)
    }
}

/** The icon in each claim's tile, in the order Rust lists the claims: apps, assistant, backups. */
private val CLAIM_ICONS: List<String> = listOf("Grid", "Sparkle", "Lock")

@Composable
private fun Claim(index: Int, claim: HomeFirstLaunchSlide) {
    val shell = tokenColor(R.color.centraid_shell_text)
    Row(
        Modifier.fillMaxWidth().testTag("first-launch-claim-$index"),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Box(
            Modifier
                .size(40.dp)
                .clip(RoundedCornerShape(dimensionResource(R.dimen.centraid_radius_card) * 0.75f))
                .background(shell.copy(alpha = if (centraidDark()) 0.18f else 0.12f))
                .clearAndSetSemantics {},
            contentAlignment = Alignment.Center,
        ) {
            CentraidIcon(
                iconKey = CLAIM_ICONS[minOf(index, CLAIM_ICONS.size - 1)],
                tint = shell,
                size = 20.dp,
                strokeWidth = 2f,
            )
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                claim.title,
                color = tokenColor(R.color.centraid_text_ink),
                fontSize = tokenSp(R.dimen.centraid_text_row),
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                claim.body,
                color = tokenColor(R.color.centraid_text_meta),
                fontSize = DETAIL_SP.sp,
            )
        }
    }
}

/** Teal is the shell's colour: a filled pill for the act, a quiet teal link for the way back. */
@Composable
private fun Doors(gate: HomeFirstLaunch, onMake: () -> Unit, onRestore: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = SIDE.dp).padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 52.dp)
                .clip(CircleShape)
                .background(tokenColor(R.color.centraid_shell))
                .clickable(onClick = onMake)
                .semantics { role = Role.Button }
                .testTag("first-launch-primary"),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                gate.make_label,
                color = Color.White,
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
        Box(
            Modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = 44.dp)
                .clickable(onClick = onRestore)
                .semantics { role = Role.Button }
                .testTag("first-launch-secondary"),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                gate.restore_label,
                color = tokenColor(R.color.centraid_shell_text),
                fontSize = tokenSp(R.dimen.centraid_text_row),
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

private const val SIDE: Int = 32
private const val TILE: Int = 104

/** The icon tile's corner, 27 of 120 of its side, as on the icon board. */
private const val TILE_RADIUS: Float = 104 * 0.225f
private const val TITLE_SP: Int = 30
private const val DETAIL_SP: Int = 15
