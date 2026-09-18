package dev.centraid.android.kit

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry

/**
 * THE MAKE-A-VAULT SHEET — WHAT `GatewaySheet` BECAME (#1029 §1).
 *
 * It was "connect this device to a gateway": a field to paste a pairing ticket
 * into, a "Pair this device" button, a "Sync now" button, and the last sentence
 * either of them produced. All three are gone with the plane behind them —
 * there is no ticket to redeem, no gateway to redeem it against, and no pass to
 * run. **The phone is the vault**, so what is left is the one act that
 * replaced them: make one.
 *
 * Same door as iOS `MakeVaultSheet`. Named apart from `HomeScreen`'s own private
 * `VaultSheet`, which is the SWITCHER: one lists the vaults this device holds,
 * this one adds to them. The sheet decides nothing — [onFound] is a
 * `HomeSession` call the activity owns.
 *
 * **R-SHELL-2:** [status] must name the foreground holding (or be empty), never
 * a vault this device has forgotten or switched away from.
 */
@Composable
public fun MakeVaultSheet(
    status: String,
    working: Boolean,
    onFound: (done: () -> Unit) -> Unit,
    onOpenTransferRules: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(CentraidGeometry.PAGE_MARGIN.dp)
            .padding(bottom = 24.dp)
            .testTag("vault-sheet"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            "Vault",
            style = centraidType("title"),
            color = centraidColor("text"),
        )
        Text(
            "Make a vault on this phone",
            style = centraidType("smallStrong"),
            color = centraidColor("text"),
        )
        TextButton(
            onClick = { if (!working) onFound {} },
            enabled = !working,
            modifier = Modifier
                .fillMaxWidth()
                .testTag("vault-found-button"),
        ) {
            Text(
                if (working) "Making…" else "Make a vault",
                color = centraidColor("link"),
            )
        }
        TextButton(
            onClick = onOpenTransferRules,
            modifier = Modifier
                .fillMaxWidth()
                .testTag("vault-transfer-rules"),
        ) {
            Text("Download settings", color = centraidColor("text"))
        }
        if (status.isNotEmpty()) {
            Text(
                status,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
                modifier = Modifier.testTag("vault-status"),
            )
        }
    }
}
