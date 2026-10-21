package dev.centraid.android.screens.health

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.ui.Modifier
import centraid.screen.v1.HealthConnectEvent
import dev.centraid.android.kit.AndroidHealth
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.theme.CentraidTheme
import dev.centraid.android.theme.centraidColor
import dev.centraid.shared.apps.health.HealthConnectMachine
import dev.centraid.shared.apps.health.HealthDevices

/**
 * "WHAT HEALTH MAY READ", FOR HEALTH CONNECT (#1129). Health Connect lists an app's permissions
 * only when the app says where its rationale lives; the manifest points both the Android 13 action
 * and the Android 14 permission-usage alias here. It draws Health's own words — the Connect
 * machine's lede and its list of types, folded from the phone's facts with no vault and no read —
 * and does nothing else: no switch, no button, nothing asked of the OS.
 */
public class HealthRationaleActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        AndroidHealth(this).state()
        val state = HealthConnectMachine.reduce(
            HealthConnectMachine.initial(),
            HealthConnectEvent(opened = HealthConnectEvent.Opened(parent = "", device = HealthDevices.current)),
        ).state
        setContent {
            CentraidTheme {
                Box(Modifier.fillMaxSize().background(centraidColor("bg")).safeDrawingPadding()) {
                    PushedPage(
                        title = state.choices_title,
                        parentTitle = state.chrome?.back_label.orEmpty(),
                        onBack = ::finish,
                    ) {
                        HealthReads(state)
                    }
                }
            }
        }
    }
}
