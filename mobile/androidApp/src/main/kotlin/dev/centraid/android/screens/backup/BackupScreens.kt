package dev.centraid.android.screens.backup

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.BackupLine
import centraid.screen.v1.BackupScreenEvent
import centraid.screen.v1.BackupScreenState
import dev.centraid.android.backup.BackupNow
import dev.centraid.android.kit.InkButton
import dev.centraid.android.kit.QuietButton
import dev.centraid.android.screens.words.WordsHead
import dev.centraid.android.screens.words.WordsPage
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.shell.TransferRuleChoice
import dev.centraid.shared.sync.BackupBridge
import dev.centraid.shared.sync.TransferRule
import kotlinx.coroutines.launch

// THE BACKUP SCREEN AND THE HOME LINE (#1080, the shells; seam contract §3).
//
// **THESE VIEWS DECIDE NOTHING** (R-1047-K1). Every sentence — the line, each
// reason something waits, each gateway's last word, every control's label —
// arrives in the state. What is the shell's is what only a platform can do:
// ask for the notification grant when "Back up now" is tapped and start the
// job that keeps the process alive (`BackupNow`), say whether the system is
// holding Centraid back to save battery, and hand pairing a new gateway to
// `pair.laptop`'s scanner.
//
// **EVERY PROTO NAME THIS FILE READS IS IN [BackupScreenModel.of] AND
// [BackupEvents]**, so reconciling with `screen.proto`'s `// --- Backup ---`
// block (lane D's, A9) is an edit to those two places. The iOS twin is
// `mobile/iosApp/Sources/BackupViews.swift`; the two read the same names.
//
// The rule control is the member's existing transfer rule, read and written
// through `TransferRule` over the secure store, so the Home header's sheet and
// this screen are one setting with one store.

/** What the Backup screen draws, copied out of `BackupScreenState`. */
internal data class BackupScreenModel(
    val title: String = "",
    val line: String = "",
    val waiting: List<String> = emptyList(),
    val frozen: Boolean = false,
    val destinations: List<Destination> = emptyList(),
    val addLabel: String = "",
    val forgetLabel: String = "",
    val ruleLabel: String = "",
    val videosLabel: String = "",
    val includeVideos: Boolean = true,
    val backUpNowLabel: String = "",
    val backingUpNow: Boolean = false,
    val progress: String = "",
    /** Non-empty when the machine judges a backlog has stood for a day. */
    val batterySentence: String = "",
    val batteryLabel: String = "",
) {
    internal data class Destination(val id: String, val label: String, val detail: String)

    internal companion object {
        fun of(state: BackupScreenState): BackupScreenModel = BackupScreenModel(
            title = state.title,
            line = state.line?.sentence.orEmpty(),
            waiting = state.line?.waiting.orEmpty().map { it.sentence }.filter { it.isNotEmpty() },
            frozen = state.line?.frozen ?: false,
            destinations = state.destinations.map { Destination(it.gateway_id, it.label, it.detail) },
            addLabel = state.add_destination_label,
            forgetLabel = state.forget_label,
            ruleLabel = state.rule_label,
            videosLabel = state.include_videos_label,
            includeVideos = state.include_videos,
            backUpNowLabel = state.back_up_now_label,
            backingUpNow = state.backing_up_now,
            progress = state.progress,
            batterySentence = state.battery_sentence,
            batteryLabel = state.battery_label,
        )
    }
}

/** `BackupScreenEvent`s, so a view forwards events and never a decision. */
internal object BackupEvents {
    fun backUpNow(): BackupScreenEvent = BackupScreenEvent(back_up_now = BackupScreenEvent.BackUpNow())

    /**
     * A3: the member's words are "include videos"; the core's wire field is
     * `exclude_videos`, and the negation is the machine's, not the view's.
     */
    fun setIncludeVideos(include: Boolean): BackupScreenEvent =
        BackupScreenEvent(set_include_videos = BackupScreenEvent.SetIncludeVideos(include = include))

    /**
     * A5: forgetting a gateway drops its row and its confirmations on this
     * phone; what it already holds stays where it is.
     */
    fun forget(gateway: String): BackupScreenEvent =
        BackupScreenEvent(forget_destination = BackupScreenEvent.ForgetDestination(gateway_id = gateway))

    fun dismissed(): BackupScreenEvent = BackupScreenEvent(dismissed = BackupScreenEvent.Dismissed())
}

/**
 * THE HOME LINE: one sentence under the vault, the door to the screen.
 * Empty draws nothing.
 */
@Composable
internal fun BackupLineRow(line: BackupLine?, onOpen: () -> Unit) {
    val sentence = line?.sentence.orEmpty()
    if (sentence.isEmpty()) return
    Text(
        sentence,
        style = centraidType("mono"),
        color = centraidColor(if (line?.frozen == true) "net" else "textFaint"),
        maxLines = 2,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .clickable(onClick = onOpen)
            .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp, vertical = 8.dp)
            .testTag("home-backup-line")
            .semantics { role = Role.Button },
    )
}

/**
 * THE BACKUP SCREEN'S SHEET, AT THE ROOT — like the custody sheets, and for
 * the same reason: it is the activity's, not an app's route. It holds the one
 * bridge for the activity's life (`ChangeStream.route` has no removal).
 */
public class BackupSheets {
    // E-A6: every kit bridge's shape — `attach`, `states`, `open`, `forward`.
    private val bridge = BackupBridge()
    private var attached = false

    /** Whether the sheet is up. */
    public var showing: Boolean by mutableStateOf(false)
        private set

    public fun attach(session: HomeSession) {
        bridge.attach(session)
        attached = true
    }

    /** Home's backup line. */
    public fun open() {
        if (!attached) return
        bridge.open()
        showing = true
    }

    private fun close() {
        showing = false
        bridge.forward(BackupEvents.dismissed())
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    public fun Sheet(onAddDestination: () -> Unit) {
        if (!showing) return
        val state by bridge.states.collectAsStateWithLifecycle()
        val model = BackupScreenModel.of(state)
        val context = LocalContext.current
        val scope = rememberCoroutineScope()
        // "BACK UP NOW": the event to the machine, and the job that keeps the
        // process alive while the pass runs. The notification grant is asked
        // for here, at the tap and never before; either answer starts it — a
        // refused grant hides the notification, not the backup.
        val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
            BackupNow.start(context)
        }
        val backUpNow: () -> Unit = {
            bridge.forward(BackupEvents.backUpNow())
            if (needsNotificationGrant(context)) {
                notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                BackupNow.start(context)
            }
        }
        // THE RULE, read from the store as the sheet opens: the store is the
        // authority, and a value held since launch may have moved.
        var rule by remember { mutableStateOf("") }
        LaunchedEffect(Unit) { rule = TransferRule.read(platformServices().secureStore).stored }
        val choices = remember { TransferRule.entries.map { TransferRuleChoice(it.stored, it.sentence) } }
        val pickRule: (String) -> Unit = { picked ->
            scope.launch {
                val settled = TransferRule.of(picked)
                TransferRule.write(platformServices().secureStore, settled)
                rule = settled.stored
            }
        }
        ModalBottomSheet(onDismissRequest = ::close, containerColor = centraidColor("bg")) {
            BackupScreen(
                model = model,
                choices = choices,
                rule = rule,
                onPickRule = pickRule,
                batteryHeld = model.batterySentence.isNotEmpty() && !ignoresBatteryOptimizations(context),
                onBattery = { openBatterySettings(context) },
                onEvent = bridge::forward,
                onBackUpNow = backUpNow,
                onAddDestination = {
                    close()
                    onAddDestination()
                },
            )
        }
    }

    private fun needsNotificationGrant(context: Context): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED

    /**
     * WHETHER THE SYSTEM IS HOLDING CENTRAID BACK TO SAVE BATTERY. A platform
     * fact only the shell can read; the machine says WHEN it matters (a
     * backlog that has stood for a day), this says WHETHER it applies.
     */
    private fun ignoresBatteryOptimizations(context: Context): Boolean =
        context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) ?: true

    /**
     * The system's own list, where the member chooses. Not the direct
     * per-app request: that needs a permission the store polices, and the
     * choice is the member's to make on the system's page.
     */
    private fun openBatterySettings(context: Context) {
        runCatching {
            context.startActivity(
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
    }
}

@Composable
private fun BackupScreen(
    model: BackupScreenModel,
    choices: List<TransferRuleChoice>,
    rule: String,
    onPickRule: (String) -> Unit,
    batteryHeld: Boolean,
    onBattery: () -> Unit,
    onEvent: (BackupScreenEvent) -> Unit,
    onBackUpNow: () -> Unit,
    onAddDestination: () -> Unit,
) {
    WordsPage(testTag = "backup-screen", description = "") {
        WordsHead(model.title, model.line)
        model.waiting.forEach { reason ->
            Text(reason, style = centraidType("small"), color = centraidColor("textSoft"))
        }
        if (batteryHeld) {
            Text(model.batterySentence, style = centraidType("small"), color = centraidColor("textSoft"))
            if (model.batteryLabel.isNotEmpty()) {
                QuietButton(label = model.batteryLabel, testTag = "backup-battery", onPress = onBattery)
            }
        }
        // BACK UP NOW, offered while nothing runs; while it runs, the
        // machine's progress sentence stands in its place.
        if (model.backUpNowLabel.isNotEmpty() && !model.frozen && !model.backingUpNow) {
            InkButton(label = model.backUpNowLabel, testTag = "backup-now", onPress = onBackUpNow)
        }
        if (model.backingUpNow && model.progress.isNotEmpty()) {
            Row(
                Modifier.testTag("backup-progress").semantics(mergeDescendants = true) { },
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(color = centraidColor("textSoft"), modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                Text(model.progress, style = centraidType("small"), color = centraidColor("textSoft"))
            }
        }
        Destinations(model, onEvent, onAddDestination)
        if (model.ruleLabel.isNotEmpty()) {
            Text(model.ruleLabel, style = centraidType("smallStrong"), color = centraidColor("text"))
        }
        choices.forEach { choice ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 44.dp)
                    .clickable { onPickRule(choice.stored) }
                    .testTag("backup-rule-" + choice.stored)
                    .semantics(mergeDescendants = true) {
                        contentDescription = choice.sentence
                        if (choice.stored == rule) this.selected = true
                    },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                // THE SELECTION IS THE STORE'S ANSWER, not the tap.
                RadioButton(selected = choice.stored == rule, onClick = { onPickRule(choice.stored) })
                Text(choice.sentence, style = centraidType("small"), color = centraidColor("text"))
            }
        }
        if (model.videosLabel.isNotEmpty()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 44.dp)
                    .testTag("backup-include-videos"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    model.videosLabel,
                    style = centraidType("small"),
                    color = centraidColor("text"),
                    modifier = Modifier.weight(1f),
                )
                Switch(
                    checked = model.includeVideos,
                    onCheckedChange = { onEvent(BackupEvents.setIncludeVideos(it)) },
                    colors = SwitchDefaults.colors(checkedTrackColor = centraidColor("link")),
                    modifier = Modifier.semantics { contentDescription = model.videosLabel },
                )
            }
        }
    }
}

@Composable
private fun Destinations(
    model: BackupScreenModel,
    onEvent: (BackupScreenEvent) -> Unit,
    onAddDestination: () -> Unit,
) {
    Column {
        model.destinations.forEach { row ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 44.dp)
                    .padding(vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(row.label, style = centraidType("smallStrong"), color = centraidColor("text"))
                    if (row.detail.isNotEmpty()) {
                        Text(row.detail, style = centraidType("mono"), color = centraidColor("textFaint"))
                    }
                }
                // FORGET IS PLAIN AND VISIBLE, and needs no confirmation: it
                // forgets this phone's pairing and nothing the gateway holds,
                // and pairing again undoes it.
                if (model.forgetLabel.isNotEmpty()) {
                    QuietButton(
                        label = model.forgetLabel,
                        testTag = "backup-forget-" + row.id,
                        modifier = Modifier.semantics { contentDescription = model.forgetLabel + " " + row.label },
                    ) { onEvent(BackupEvents.forget(row.id)) }
                }
            }
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(CentraidGeometry.HAIRLINE.dp)
                    .background(centraidColor("line")),
            )
        }
        if (model.addLabel.isNotEmpty()) {
            QuietButton(
                label = model.addLabel,
                testTag = "backup-add-destination",
                modifier = Modifier.padding(top = 12.dp),
                onPress = onAddDestination,
            )
        }
    }
}
