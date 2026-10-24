package dev.centraid.android.screens.proof

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import centraid.core.v1.CounterEvent
import centraid.core.v1.CounterRetryTapped
import centraid.core.v1.CounterCopyTapped
import centraid.core.v1.CounterView
import centraid.core.v1.NavEvent
import centraid.core.v1.NavPopped
import centraid.core.v1.ScreenEvent
import dev.centraid.android.kit.PerformScreenEffects
import dev.centraid.core.Screens
import kotlinx.coroutines.launch

/**
 * THE PROOF SCREEN, DRAWN (#1135, lane C2): `proof.counter`, minimal.
 *
 * Every string comes out of the view state; this file writes no copy and names
 * no screen — it switches on which `ViewState` arm Rust sent. It draws the top
 * of the stack Rust holds for [tab] and reports back as an event. A ported
 * screen follows this shape: `docs/screens.md`.
 */
@Composable
fun ProofScreen(screens: Screens, tab: String) {
    val navigation by screens.navigation.collectAsState()
    val views by screens.views.collectAsState()
    val scope = rememberCoroutineScope()
    val entries = navigation?.tabs?.firstOrNull { it.tab == tab }?.entries.orEmpty()
    val top = entries.lastOrNull() ?: return

    PerformScreenEffects(screens, phone = null)

    BackHandler(enabled = entries.size > 1) {
        scope.launch {
            screens.navigate(NavEvent(popped = NavPopped(tab = tab, instance = top.instance)))
        }
    }
    val counter = views[top.instance]?.counter ?: return
    Counter(counter) { event ->
        scope.launch { screens.send(top.instance, ScreenEvent(counter = event)) }
    }
}

@Composable
private fun Counter(view: CounterView, send: (CounterEvent) -> Unit) {
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(view.title)
        view.loading?.let { Text(it.label) }
        view.failed?.let {
            Text(it.sentence)
            Button(onClick = { send(CounterEvent(retry_tapped = CounterRetryTapped())) }) {
                Text(it.remedy)
            }
        }
        view.data_?.let {
            Text(it.count_label)
            Button(onClick = { send(CounterEvent(copy_tapped = CounterCopyTapped())) }) {
                Text(it.copy_label)
            }
            if (it.notice.isNotEmpty()) Text(it.notice)
        }
    }
}
