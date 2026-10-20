package dev.centraid.android.screens.health

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import dev.centraid.android.kit.AndroidHealth
import dev.centraid.android.kit.HealthConnectAccess
import dev.centraid.design.copy.HealthCopy
import dev.centraid.shared.apps.health.HealthConnectBridge
import dev.centraid.shared.apps.health.HealthConnectScreenBridge
import dev.centraid.shared.apps.health.HealthDevices
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * CONNECT'S ONE ACT, ANDROID (#1129): the member tapped Connect with [chosen] types on. **The only
 * place Health asks the OS anything**, and only here at the member's tap (R-1127-15):
 *
 * 1. Health Connect not reachable → the Connect page's status line says so, in Health's words
 *    (`CONNECT_UNAVAILABLE`, or `CONNECT_INSTALL` where Google Play can bring it), and nothing is
 *    asked.
 * 2. Health Connect's own permission sheet for exactly the chosen types' READ permissions
 *    ([AndroidHealth.permissionsFor]); nothing is ever asked to write (R-1129-7).
 * 3. The choice is kept as the shell's (R-1129-6) and the phone's facts stated again.
 * 4. No chosen type granted → `failed("")`, Health's own "didn't answer" line. Otherwise
 *    [HealthConnectBridge.connect] writes the store's origin and runs the first read, and the page
 *    is told `connected()` and [onConnected] pops it, or it is told `failed("")`.
 *
 * Returns the act to call with `HealthConnectState.chosen` on `ConnectTapped`.
 */
@Composable
internal fun rememberHealthConnect(
    health: AndroidHealth,
    bridge: HealthConnectBridge,
    screen: HealthConnectScreenBridge,
    scope: CoroutineScope,
    onConnected: () -> Unit,
): (List<String>) -> Unit {
    val asked = remember { arrayOf(emptyList<String>()) }
    val contract = remember(health) { health.contract() }
    val connected by rememberUpdatedState(onConnected)
    val sheet = rememberLauncherForActivityResult(contract) { _ ->
        val chosen = asked[0]
        scope.launch {
            // WHAT HEALTH CONNECT HOLDS NOW, not only what this sheet returned: a type granted
            // before counts, and one the member just turned off does not.
            val granted = withContext(Dispatchers.IO) { health.granted() }.orEmpty()
            health.choose(chosen)
            health.state()
            val any = chosen.any { key -> HealthConnectAccess.TYPE[key]?.let { it in granted } == true }
            if (!any) {
                screen.failed("")
            } else {
                bridge.connect(HealthDevices.HEALTH_CONNECT, chosen) { ok ->
                    if (ok) {
                        screen.connected()
                        connected()
                    } else {
                        screen.failed("")
                    }
                }
            }
        }
    }
    return remember(health, bridge, screen, sheet) {
        { chosen ->
            when (health.status()) {
                HealthConnectAccess.Status.UNAVAILABLE -> screen.failed(HealthCopy.CONNECT_UNAVAILABLE)
                HealthConnectAccess.Status.INSTALL -> screen.failed(HealthCopy.CONNECT_INSTALL)
                HealthConnectAccess.Status.AVAILABLE -> {
                    asked[0] = chosen
                    try {
                        sheet.launch(health.permissionsFor(chosen))
                    } catch (_: android.content.ActivityNotFoundException) {
                        screen.failed("")
                    }
                }
            }
        }
    }
}
