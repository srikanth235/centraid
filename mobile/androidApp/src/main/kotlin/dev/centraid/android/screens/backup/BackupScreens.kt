package dev.centraid.android.screens.backup

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.ManagedActivityResultLauncher
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.BackupLine
import centraid.screen.v1.BackupScreenEvent
import centraid.screen.v1.BackupScreenState
import dev.centraid.android.kit.InkButton
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.screens.words.WordsHead
import dev.centraid.android.screens.words.WordsPage
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry
import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.shell.HomeSession
import dev.centraid.shared.shell.TransferRuleChoice
import dev.centraid.shared.sync.BackupBridge
import dev.centraid.shared.sync.TransferRule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import dev.centraid.android.kit.KitSpinner

// THE BACKUP SCREEN AND THE HOME LINE (#1080, the shells; seam contract A11).
//
// **THESE VIEWS DECIDE NOTHING** (R-1047-K1). Every sentence — the line and
// its detail, each reason something waits, each gateway's last word, every
// control's label, what the last act did, why the phone will not wake
// Centraid — arrives in the state, and so do the line's tone and whether
// "Back up now" may be pressed. What is the shell's is what only a platform
// can do: ask for the notification grant when "Back up now" is tapped, say
// whether the system is holding Centraid back to save battery, and hand
// pairing a new gateway to `pair.laptop`'s scanner. The job that keeps the
// process alive while a run goes is started and stopped by the session's own
// "Back up now" (`HomeSession.backUpNow` through `SyncPass.installBacklog`,
// installed by `CentraidApplication`), never by this sheet.
//
// **EVERY PROTO NAME THIS FILE READS IS IN [BackupScreenModel.of] AND
// [BackupEvents]** (Home draws `BackupLine.status` in `VaultHeader`), so a change to `screen.proto`'s
// `// --- Backup ---` block is an edit to those places. The iOS twin is
// `mobile/iosApp/Sources/BackupViews.swift`; the two read the same names.
//
// The rule control is the member's existing transfer rule, written through
// [writeTransferRule] by this screen and the Home header's sheet alike, so the
// two are one setting with one store and both re-ask the background windows.

/** What the Backup screen draws, copied out of `BackupScreenState`. */
internal data class BackupScreenModel(
    val title: String = "",
    val line: String = "",
    val lineDetail: String = "",
    val waiting: List<String> = emptyList(),
    /** Why the phone will not wake Centraid in the background, or empty. */
    val backgroundNotice: String = "",
    /** What the last act did, or why it could not: one clause, never a toast. */
    val notice: String = "",
    val destinations: List<Destination> = emptyList(),
    val addLabel: String = "",
    val forgetLabel: String = "",
    val ruleLabel: String = "",
    val videosLabel: String = "",
    val includeVideos: Boolean = true,
    val backUpNowLabel: String = "",
    /** The machine's verdict: a gateway, a vault that has not moved, no run going. */
    val backUpNowEnabled: Boolean = false,
    /** Non-empty only while a run is in progress. */
    val progress: String = "",
    /** Non-empty when the machine judges a backlog has stood for a day. */
    val batterySentence: String = "",
    val batteryLabel: String = "",
    /** THE RECOVERY KEY (R-ONBOARD-10): an empty heading draws no section. */
    val keyHeading: String = "",
    val keyLine: String = "",
    /** On this phone alone and no copy saved: drawn as a warning, first. */
    val keyWarning: Boolean = false,
    val keyShowLabel: String = "",
    val keySyncLabel: String = "",
    val keySynced: Boolean = false,
    /** The page's one Ink button, named by the machine; every other button is the Outline button. */
    val ink: BackupScreenState.InkAction = BackupScreenState.InkAction.INK_ACTION_NONE,
) {
    internal data class Destination(
        val id: String,
        val label: String,
        val detail: String,
        val accessibilityLabel: String,
    )

    internal companion object {
        fun of(state: BackupScreenState): BackupScreenModel = BackupScreenModel(
            title = state.title,
            line = state.line?.sentence.orEmpty(),
            lineDetail = state.line?.detail.orEmpty(),
            waiting = state.line?.waiting.orEmpty().map { it.sentence }.filter { it.isNotEmpty() },
            backgroundNotice = state.background_notice,
            notice = state.notice,
            destinations = state.destinations.map {
                Destination(it.gateway_id, it.label, it.detail, it.accessibility_label)
            },
            addLabel = state.add_destination_label,
            forgetLabel = state.forget_label,
            ruleLabel = state.rule_label,
            videosLabel = state.include_videos_label,
            includeVideos = state.include_videos,
            backUpNowLabel = state.back_up_now_label,
            backUpNowEnabled = state.back_up_now_enabled,
            progress = state.progress,
            batterySentence = state.battery_sentence,
            batteryLabel = state.battery_label,
            keyHeading = state.key_heading,
            keyLine = state.key_line,
            keyWarning = state.key_warning,
            keyShowLabel = state.key_show_label,
            keySyncLabel = state.key_sync_label,
            keySynced = state.key_synced,
            ink = state.ink_action,
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

    /** Move the recovery key into the keychain, or out of it. */
    fun setKeySync(on: Boolean): BackupScreenEvent =
        BackupScreenEvent(set_key_sync = BackupScreenEvent.SetKeySync(on = on))
}

/**
 * THE MEMBER CHANGED THE RULE, from the Backup screen or the Home header's
 * sheet (#1080): written, answered as what the store HOLDS, and the
 * background windows asked for again (`HomeSession.ruleChanged`), so the
 * periodic worker's network constraint follows the rule. `HomeBridge.setTransferRule`
 * is the iOS twin.
 */
internal suspend fun writeTransferRule(session: HomeSession?, picked: String): String {
    val settled = TransferRule.of(picked)
    TransferRule.write(platformServices().secureStore, settled)
    session?.ruleChanged()
    return settled.stored
}

/**
 * THE BACKUP SCREEN'S SHEET, AT THE ROOT — like the custody sheets, and for
 * the same reason: it is the activity's, not an app's route. It holds the one
 * bridge for the activity's life (`ChangeStream.route` has no removal).
 */
public class BackupSheets {
    // Seam contract A11: every kit bridge's shape — `attach`, `states`, `open`, `forward`.
    private val bridge = BackupBridge()
    private var session: HomeSession? = null

    /** Whether the sheet is up. */
    public var showing: Boolean by mutableStateOf(false)
        private set

    /**
     * A "Back up now" whose notification answer arrived before a session was
     * attached: the activity was recreated under the system's dialog. See
     * [answered].
     */
    private var owedBackUpNow = false

    public fun attach(session: HomeSession) {
        bridge.attach(session)
        this.session = session
        if (owedBackUpNow) {
            owedBackUpNow = false
            run(session)
        }
    }

    /** The band's Backup tab, or Home's backup line: the tab is shown. */
    public fun open() {
        if (session == null) return
        bridge.open()
        showing = true
    }

    /** The tab was left: its machine is told the screen is gone. */
    public fun close() {
        if (!showing) return
        showing = false
        bridge.forward(BackupEvents.dismissed())
    }

    /** Read again while shown — a pairing that closed over the tab. */
    public fun reread() {
        if (showing) bridge.open()
    }

    /**
     * The notification grant was answered, either way — a refused grant hides
     * the notification, not the backup. With the sheet up the tap goes to the
     * machine as ever. With it down, the activity was recreated under the
     * system's dialog (a rotation): the new sheet is closed and has read no
     * gateway, so the machine would refuse the event, and the tap goes to the
     * session's own run, which an opened screen follows like any other.
     */
    private fun answered() {
        if (showing) {
            bridge.forward(BackupEvents.backUpNow())
            return
        }
        val open = session
        if (open == null) owedBackUpNow = true else run(open)
    }

    private fun run(session: HomeSession) {
        CoroutineScope(Dispatchers.IO).launch { session.backUpNow() }
    }

    private var notifications: ManagedActivityResultLauncher<String, Boolean>? = null

    /**
     * "BACK UP NOW" IS THE MACHINE'S: the event starts the session's run, and
     * the session starts and stops the job around it. The shell's part is the
     * notification grant, asked for at the tap and never before; the event
     * goes once the grant is answered ([answered]), so the job is started
     * from a visible app.
     *
     * REGISTERED WHETHER OR NOT THE TAB IS SHOWN (#1080, the Android emulator
     * smoke): the activity draws this at its root. A rotation while the
     * system's dialog is up recreates the activity; the answer is delivered
     * to the launcher registered under the same key, and a launcher that only
     * existed inside the Backup screen was never registered again, so the
     * member's tap was dropped without a word.
     */
    @Composable
    public fun Registered() {
        notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
            answered()
        }
    }

    @Composable
    public fun Tab(onAddDestination: () -> Unit, onShowWords: () -> Unit) {
        if (!showing) return
        val state by bridge.states.collectAsStateWithLifecycle()
        val model = BackupScreenModel.of(state)
        val context = LocalContext.current
        val scope = rememberCoroutineScope()
        val backUpNow: () -> Unit = {
            val ask = notifications
            if (ask != null && needsNotificationGrant(context)) {
                ask.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                bridge.forward(BackupEvents.backUpNow())
            }
        }
        // THE RULE, read from the store as the sheet opens: the store is the
        // authority, and a value held since launch may have moved.
        var rule by remember { mutableStateOf("") }
        LaunchedEffect(Unit) { rule = TransferRule.read(platformServices().secureStore).stored }
        val choices = remember { TransferRule.entries.map { TransferRuleChoice(it.stored, it.sentence) } }
        val pickRule: (String) -> Unit = { picked ->
            scope.launch { rule = writeTransferRule(session, picked) }
        }
        // A TAB LIKE CHAT, drawn in place of Home's springboard under the
        // band (R-ONBOARD-9): adding a backup device and showing the words
        // open their own sheets over it, and it stays.
        BackupScreen(
            model = model,
            choices = choices,
            rule = rule,
            onPickRule = pickRule,
            batteryHeld = model.batterySentence.isNotEmpty() && !ignoresBatteryOptimizations(context),
            onBattery = { openBatterySettings(context) },
            onEvent = bridge::forward,
            onBackUpNow = backUpNow,
            onAddDestination = onAddDestination,
            onShowWords = onShowWords,
        )
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
    onShowWords: () -> Unit,
) {
    val paired = model.destinations.isNotEmpty()
    WordsPage(testTag = "backup-screen", description = "") {
        // WHERE THE BACKUP STANDS, and the one act that moves it: with nothing
        // paired that act is adding a backup device, drawn as the page's
        // primary; once one is paired it is "Back up now" (iOS `BackupView`).
        WordsHead(model.title, model.line)
        if (model.lineDetail.isNotEmpty()) Sentence(model.lineDetail)
        model.waiting.forEach { reason -> Sentence(reason) }
        // WHY THE PHONE WILL NOT WAKE CENTRAID, when it will not.
        if (model.backgroundNotice.isNotEmpty()) Sentence(model.backgroundNotice, "backup-background-notice")
        if (batteryHeld) {
            Sentence(model.batterySentence)
            if (model.batteryLabel.isNotEmpty()) {
                OutlineButton(label = model.batteryLabel, testTag = "backup-battery", onPress = onBattery)
            }
        }
        // ONE INK BUTTON AT A TIME, and the machine names it (`ink_action`); a
        // verb that is not the page's one thing to do is the outline.
        if (!paired && model.addLabel.isNotEmpty()) {
            if (model.ink == BackupScreenState.InkAction.INK_ACTION_ADD_DESTINATION) {
                InkButton(label = model.addLabel, testTag = "backup-add-destination", onPress = onAddDestination)
            } else {
                OutlineButton(label = model.addLabel, testTag = "backup-add-destination", onPress = onAddDestination)
            }
        }
        // BACK UP NOW, only once there is somewhere to back up to (the machine
        // draws no label before). Pressable when the machine says so; while a
        // run goes, its progress sentence stands beside it.
        if (model.backUpNowLabel.isNotEmpty()) {
            val enabled = model.backUpNowEnabled
            if (model.ink == BackupScreenState.InkAction.INK_ACTION_BACK_UP_NOW) {
                InkButton(
                    label = model.backUpNowLabel,
                    testTag = "backup-now",
                    enabled = enabled,
                    onPress = onBackUpNow,
                )
            } else {
                OutlineButton(
                    label = model.backUpNowLabel,
                    testTag = "backup-now",
                    enabled = enabled,
                    onPress = onBackUpNow,
                )
            }
        }
        if (model.progress.isNotEmpty()) {
            Row(
                Modifier.testTag("backup-progress").semantics(mergeDescendants = true) { },
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                KitSpinner(model.progress)
            }
        }
        // WHAT THE LAST ACT DID, in place: one clause, never a toast.
        if (model.notice.isNotEmpty()) Sentence(model.notice, "backup-notice")
        // A KEY ON THIS PHONE ALONE IS THE PAGE'S FIRST CONCERN: a lost phone
        // takes every vault with it, whatever is backed up.
        if (model.keyWarning) RecoveryKey(model, onEvent, onShowWords)
        if (paired) {
            Section(SharedCopy.BACKUP_DEVICES_HEADING) { Destinations(model, onEvent, onAddDestination) }
        }
        if (choices.isNotEmpty()) {
            Section(model.ruleLabel) {
                choices.forEach { choice ->
                    val picked = choice.stored == rule
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 44.dp)
                            .clickable { onPickRule(choice.stored) }
                            .padding(vertical = 8.dp)
                            .testTag("backup-rule-" + choice.stored)
                            .semantics(mergeDescendants = true) {
                                contentDescription = choice.sentence
                                if (picked) this.selected = true
                            },
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        // THE SELECTION IS THE STORE'S ANSWER, not the tap.
                        RuleMark(picked)
                        Text(
                            choice.sentence,
                            style = centraidType("small"),
                            color = centraidColor(if (picked) "text" else "textSoft"),
                        )
                    }
                }
            }
        }
        if (model.videosLabel.isNotEmpty()) {
            Rule()
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .testTag("backup-include-videos"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    model.videosLabel,
                    style = centraidType("body"),
                    color = centraidColor("text"),
                    modifier = Modifier.weight(1f),
                )
                Switch(
                    checked = model.includeVideos,
                    onCheckedChange = { onEvent(BackupEvents.setIncludeVideos(it)) },
                    colors = SwitchDefaults.colors(checkedTrackColor = centraidColor("accent")),
                    modifier = Modifier.semantics { contentDescription = model.videosLabel },
                )
            }
        }
        // THE RECOVERY KEY BELONGS HERE: it is the other half of getting a
        // vault back, beside the backup device that holds the copy.
        if (!model.keyWarning) RecoveryKey(model, onEvent, onShowWords)
    }
}

/**
 * WHERE THE RECOVERY KEY IS, and what can be done about it (iOS
 * `BackupView.recoveryKey`). A warning carries the attention mark Home's line
 * uses, and the machine makes "Show recovery key" the page's Ink button
 * (`ink_action`); otherwise it is one quiet sentence and an outline button.
 * Moving the key into or out of the keychain is a plain link: a choice made
 * once, not a thing to do.
 */
@Composable
private fun RecoveryKey(model: BackupScreenModel, onEvent: (BackupScreenEvent) -> Unit, onShowKey: () -> Unit) {
    if (model.keyHeading.isEmpty()) return
    Section(model.keyHeading) {
        if (model.keyWarning) {
            Row(
                Modifier.height(IntrinsicSize.Min).testTag("backup-key-line").semantics(mergeDescendants = true) { },
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(Modifier.width(2.dp).fillMaxHeight().background(centraidColor("attention")))
                Text(model.keyLine, style = centraidType("body"), color = centraidColor("text"))
            }
        } else {
            Sentence(model.keyLine, "backup-key-line")
        }
        if (model.keyShowLabel.isNotEmpty()) {
            if (model.ink == BackupScreenState.InkAction.INK_ACTION_SHOW_KEY) {
                InkButton(label = model.keyShowLabel, testTag = "backup-show-key", onPress = onShowKey)
            } else {
                OutlineButton(label = model.keyShowLabel, testTag = "backup-show-key", onPress = onShowKey)
            }
        }
        if (model.keySyncLabel.isNotEmpty()) {
            Box(
                Modifier
                    .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
                    .clickable(role = Role.Button) { onEvent(BackupEvents.setKeySync(!model.keySynced)) }
                    .testTag("backup-key-sync"),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text(model.keySyncLabel, style = centraidType("small"), color = centraidColor("link"))
            }
        }
    }
}

/** A hairline between groups: the page is already inset. */
@Composable
private fun Rule() {
    Box(
        Modifier
            .fillMaxWidth()
            .height(CentraidGeometry.HAIRLINE.dp)
            .background(centraidColor("line")),
    )
}

/** ONE GROUP: a rule above, its name in sentence case, then its rows. */
@Composable
private fun Section(heading: String, content: @Composable () -> Unit) {
    Rule()
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (heading.isNotEmpty()) {
            Text(
                heading,
                style = centraidType("smallStrong"),
                color = centraidColor("text"),
                modifier = Modifier.semantics { heading() },
            )
        }
        content()
    }
}

/** THE RULE'S CHOICE MARK in the theme's ink: a ring, filled when picked. */
@Composable
private fun RuleMark(picked: Boolean) {
    Box(
        Modifier
            .size(20.dp)
            .border(1.5.dp, centraidColor(if (picked) "text" else "lineStrong"), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        if (picked) Box(Modifier.size(10.dp).background(centraidColor("text"), CircleShape))
    }
}

/** One of the machine's sentences, drawn quietly. */
@Composable
private fun Sentence(text: String, testTag: String? = null) {
    Text(
        text,
        style = centraidType("small"),
        color = centraidColor("textSoft"),
        modifier = if (testTag == null) Modifier else Modifier.testTag(testTag),
    )
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
                Column(
                    Modifier
                        .weight(1f)
                        .clearAndSetSemantics { contentDescription = row.accessibilityLabel.ifEmpty { row.label } },
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(row.label, style = centraidType("smallStrong"), color = centraidColor("text"))
                    if (row.detail.isNotEmpty()) {
                        Text(row.detail, style = centraidType("mono"), color = centraidColor("textFaint"))
                    }
                }
                // FORGET IS PLAIN AND VISIBLE, and needs no confirmation: it
                // forgets this phone's pairing and nothing the gateway holds,
                // and pairing again undoes it.
                if (model.forgetLabel.isNotEmpty()) {
                    OutlineButton(
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
            OutlineButton(
                label = model.addLabel,
                testTag = "backup-add-destination",
                modifier = Modifier.padding(top = 12.dp),
                onPress = onAddDestination,
            )
        }
    }
}
