package dev.centraid.android.screens.words

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.centraid.android.R
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.KitPillButton
import dev.centraid.android.kit.centraidResource
import dev.centraid.android.kit.tokenSp
import dev.centraid.design.KitWords

/**
 * THE LAUNCH SCREEN FOR A DAMAGED VAULT (#1191, row B16). `centraid_open` answered
 * `VAULT_DAMAGED`, so there is no core and no Rust screen to draw this: the words are the Backup
 * screen's own sentences, carried in [KitWords] (generated from the Rust catalogue by
 * `cargo xtask design`), and nothing here words or decides anything. The board is
 * `design/mockups/BackupVaultDamagedOpen.dc.html`.
 */
@Composable
internal fun VaultDamagedScreen(onRestore: () -> Unit) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CentraidIcon("AlertCircle", centraidResource(R.color.centraid_text_ink), size = 32.dp)
        Text(
            KitWords.VAULT_DAMAGED_TITLE,
            modifier = Modifier.semantics { heading() }.testTag("vault-damaged-title"),
            color = centraidResource(R.color.centraid_text_ink),
            fontSize = TITLE_SP.sp,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
        )
        Text(
            KitWords.VAULT_DAMAGED_LINE,
            modifier = Modifier.testTag("vault-damaged-line"),
            color = centraidResource(R.color.centraid_text_meta),
            fontSize = tokenSp(R.dimen.centraid_text_row),
            textAlign = TextAlign.Center,
        )
        Text(
            KitWords.VAULT_DAMAGED_SAFE,
            modifier = Modifier.testTag("vault-damaged-safe"),
            color = centraidResource(R.color.centraid_text_ink),
            fontSize = tokenSp(R.dimen.centraid_text_row),
            textAlign = TextAlign.Center,
        )
        KitPillButton(
            label = KitWords.VAULT_DAMAGED_RESTORE,
            onPress = onRestore,
            modifier = Modifier.padding(top = 12.dp),
            testTag = "vault-damaged-restore",
        )
    }
}

private const val TITLE_SP: Int = 24
