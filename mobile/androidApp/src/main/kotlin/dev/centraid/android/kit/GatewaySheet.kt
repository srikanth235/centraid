package dev.centraid.android.kit

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry

/**
 * CONNECT THIS DEVICE TO A GATEWAY (#1020, D-1020-B7; #1025 live-shell).
 *
 * Same door as iOS `GatewaySheet`: paste a ticket, pair, sync now, and read
 * the last showable sentence. The sheet decides nothing — [onPair] and
 * [onSyncNow] are `HomeSession` calls the activity owns.
 *
 * **R-SHELL-2:** [status] must name the foreground holding (or be empty),
 * never a vault this device has forgotten or switched away from.
 */
@Composable
public fun GatewaySheet(
    status: String,
    working: Boolean,
    onPair: (ticket: String, done: () -> Unit) -> Unit,
    onSyncNow: (done: () -> Unit) -> Unit,
    onOpenTransferRules: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var ticket by remember { mutableStateOf("") }
    Column(
        modifier
            .fillMaxWidth()
            .padding(CentraidGeometry.PAGE_MARGIN.dp)
            .padding(bottom = 24.dp)
            .testTag("gateway-sheet"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            "Gateway",
            style = centraidType("title"),
            color = centraidColor("text"),
        )
        Text(
            "Pair with a gateway",
            style = centraidType("smallStrong"),
            color = centraidColor("text"),
        )
        BasicTextField(
            value = ticket,
            onValueChange = { ticket = it },
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 72.dp)
                .testTag("gateway-ticket-field"),
            textStyle = centraidType("mono").copy(color = centraidColor("text")),
            decorationBox = { inner ->
                if (ticket.isEmpty()) {
                    Text(
                        "Pairing code",
                        style = centraidType("mono"),
                        color = centraidColor("textFaint"),
                    )
                }
                inner()
            },
        )
        TextButton(
            onClick = {
                val trimmed = ticket.trim()
                if (trimmed.isEmpty() || working) return@TextButton
                onPair(trimmed) {}
            },
            enabled = ticket.trim().isNotEmpty() && !working,
            modifier = Modifier
                .fillMaxWidth()
                .testTag("gateway-pair-button"),
        ) {
            Text(
                if (working) "Pairing…" else "Pair this device",
                color = centraidColor("link"),
            )
        }
        TextButton(
            onClick = onOpenTransferRules,
            modifier = Modifier
                .fillMaxWidth()
                .testTag("gateway-transfer-rules"),
        ) {
            Text("Download settings", color = centraidColor("text"))
        }
        TextButton(
            onClick = { if (!working) onSyncNow {} },
            enabled = !working,
            modifier = Modifier
                .fillMaxWidth()
                .testTag("gateway-sync-button"),
        ) {
            Text(if (working) "Syncing…" else "Sync now", color = centraidColor("text"))
        }
        if (status.isNotEmpty()) {
            Text(
                status,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
                modifier = Modifier.testTag("gateway-status"),
            )
        }
    }
}
