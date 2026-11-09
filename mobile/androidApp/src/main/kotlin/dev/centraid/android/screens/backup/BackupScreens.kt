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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.shape.RoundedCornerShape
import centraid.core.v1.BackupCondition
import centraid.core.v1.BackupLine
import dev.centraid.android.R
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.KitTile
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.tokenSp
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import centraid.core.v1.BackupAppRow
import centraid.core.v1.BackupHomeData
import centraid.core.v1.BackupHomeEvent
import centraid.core.v1.BackupHomeState
import centraid.core.v1.BackupInk
import centraid.core.v1.Route
import dev.centraid.android.kit.AppTile
import dev.centraid.android.kit.FailureView
import dev.centraid.android.kit.InkButton
import dev.centraid.android.kit.KitProgressBar
import dev.centraid.android.kit.KitSpinner
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.kitTextStyle
import androidx.compose.ui.text.font.FontWeight
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry

// THE BACKUP SCREEN (`backup.home`; #1080, #1135). Home's half of the backup is
// the vault lockup's status line (`VaultHeader`, R-ONBOARD-11).
//
// **THESE VIEWS DECIDE NOTHING** (R-1047-K1). Every sentence — the line and its
// detail, each reason something waits, each gateway's last word, every control's
// label, the rule's three choices and which is picked, what the last act did, why
// the phone will not wake Centraid — arrives in `BackupHomeState`, and so do the
// page's one Ink button and whether "Back up now" may be pressed. What is the
// shell's is what only a platform can do: ask for the notification grant when
// "Back up now" is tapped, say whether the system is holding Centraid back to
// save battery, and hand pairing a new gateway and the recovery key to their
// pages. The iOS twin is `mobile/iosApp/Sources/BackupViews.swift`; the two read
// the same names.

/**
 * THE BACKUP SCREEN: where the backup stands, the three controls, the gateways this
 * phone backs up to and where the recovery key is.
 *
 * The rule is written, and the pass service told, by the Backup screen in Rust
 * (`RuleChosen`); pairing and the recovery key are the routes its view carries
 * (`add_destination`, `key_show`), pushed by [onOpen].
 */
@Composable
internal fun BackupHomeScreen(
    state: BackupHomeState,
    onEvent: (BackupHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
) {
    val data = state.data_
    val failure = state.failure
    when {
        data != null -> BackupPage(data, onEvent, onOpen)
        failure != null -> FailureView(
            sentence = failure.sentence,
            remedy = failure.remedy,
            onRetry = { onEvent(BackupHomeEvent(retry = BackupHomeEvent.Retry())) },
        )
        else -> RowSkeleton()
    }
}

@Composable
private fun BackupPage(
    model: BackupHomeData,
    onEvent: (BackupHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
) {
    val onAddDestination = { model.add_destination?.let(onOpen); Unit }
    val onShowWords = { model.key_show?.let(onOpen); Unit }
    val context = LocalContext.current
    // "BACK UP NOW" IS RUST'S: the event asks for a pass. The shell's part is the
    // notification grant, asked for at the tap and never before; the event goes once
    // the grant is answered either way (a refused grant hides the notification, not
    // the backup), so the job that keeps the process alive starts from a visible app.
    val backUpNow = { onEvent(BackupHomeEvent(back_up_now = BackupHomeEvent.BackUpNow())) }
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { backUpNow() }
    val onBackUpNow: () -> Unit = {
        if (needsNotificationGrant(context)) notifications.launch(Manifest.permission.POST_NOTIFICATIONS) else backUpNow()
    }
    val line = model.line
    var ruleOpen by remember { mutableStateOf(false) }
    // WHETHER THE SYSTEM IS HOLDING CENTRAID BACK is the platform's to say; WHEN it
    // matters (a backlog that stood a day) is the screen's.
    val batteryHeld = model.battery_sentence.isNotEmpty() && !ignoresBatteryOptimizations(context)
    Column(
        Modifier
            .fillMaxWidth()
            .background(Surface.page)
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp, vertical = 16.dp)
            .testTag("backup-screen"),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            model.title,
            style = centraidType("title"),
            color = Surface.ink,
            modifier = Modifier.padding(horizontal = 4.dp).testTag("backup-title").semantics { heading() },
        )
        // THE STATUS CARD: where the backup stands, and the one act that moves it (iOS `statusCard`).
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(CardRadius)).background(Surface.card).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.padding(top = 6.dp).size(10.dp).clip(CircleShape).background(conditionTint(model)))
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(line?.sentence.orEmpty(), style = centraidType("title").copy(fontSize = tokenSp(R.dimen.centraid_text_section)), color = Surface.ink)
                    if (!line?.detail.isNullOrEmpty()) Sentence(line?.detail.orEmpty())
                    if (model.last_good.isNotEmpty()) Sentence(model.last_good, "backup-last-good")
                    if (model.reason.isNotEmpty()) Sentence(model.reason, "backup-reason")
                }
            }
            if (model.progress.isNotEmpty()) {
                if (model.progress_known) {
                    // THE RUN'S BAR (BackupRunning): what a gateway has acknowledged of the whole,
                    // and the bytes still to go under it.
                    Column(
                        Modifier.padding(top = 6.dp).testTag("backup-progress").semantics(mergeDescendants = true) { },
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        KitProgressBar(model.progress_fraction, height = 6.dp, fill = appAccent("").text)
                        Text(
                            model.progress,
                            style = kitTextStyle(KitType.Meta).copy(fontWeight = FontWeight.SemiBold),
                            color = appAccent("").text,
                        )
                    }
                } else {
                    Row(
                        Modifier.testTag("backup-progress").semantics(mergeDescendants = true) { },
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) { KitSpinner(model.progress) }
                }
            }
            line?.waiting.orEmpty().map { it.sentence }.filter { it.isNotEmpty() }.forEach { Sentence(it) }
            if (model.background_notice.isNotEmpty()) Sentence(model.background_notice, "backup-background-notice")
            if (batteryHeld) {
                Sentence(model.battery_sentence)
                if (model.battery_label.isNotEmpty()) {
                    OutlineButton(label = model.battery_label, testTag = "backup-battery") { openBatterySettings(context) }
                }
            }
            if (model.notice.isNotEmpty()) Sentence(model.notice, "backup-notice")
            if (model.back_up_now_label.isNotEmpty()) {
                if (model.ink == BackupInk.BACKUP_INK_BACK_UP_NOW) {
                    InkButton(label = model.back_up_now_label, testTag = "backup-now", enabled = model.back_up_now_enabled, onPress = onBackUpNow)
                } else {
                    OutlineButton(label = model.back_up_now_label, testTag = "backup-now", enabled = model.back_up_now_enabled, onPress = onBackUpNow)
                }
            } else if (model.destinations.isEmpty() && model.add_destination_label.isNotEmpty()) {
                InkButton(label = model.add_destination_label, testTag = "backup-add-destination", onPress = onAddDestination)
            }
        }
        if (model.apps.isNotEmpty()) Group(model.apps_heading) { Apps(model.apps) }
        if (model.apps_waiting.isNotEmpty()) Group(model.waiting_heading) { Apps(model.apps_waiting) }
        if (model.destinations.isNotEmpty()) {
            Group(model.devices_heading) { Destinations(model, onEvent, onAddDestination) }
        } else if (model.add_destination_label.isNotEmpty()) {
            Group("") { AddDevice(model.add_destination_label, onAddDestination) }
        }
        if (model.rule_choices.isNotEmpty()) {
            Group(model.travel_heading) {
                // "BACK UP OVER": the picked rule's short word, opening the sentences it can be.
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 52.dp)
                        .clickable { ruleOpen = !ruleOpen }
                        .padding(horizontal = 16.dp)
                        .testTag("backup-over")
                        .semantics(mergeDescendants = true) { contentDescription = model.over_label + ", " + model.over_value },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(model.over_label, style = centraidType("body"), color = Surface.ink, modifier = Modifier.weight(1f))
                    Text(model.over_value, style = centraidType("body"), color = Surface.meta)
                    CentraidIcon(iconKey = if (ruleOpen) "ChevronDown" else "ChevronRight", tint = Surface.meta, size = 16.dp)
                }
                if (ruleOpen) {
                    model.rule_choices.forEach { choice ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(min = 44.dp)
                                .clickable {
                                    onEvent(BackupHomeEvent(rule_chosen = BackupHomeEvent.RuleChosen(stored = choice.stored)))
                                }
                                .padding(horizontal = 16.dp, vertical = 8.dp)
                                .testTag("backup-rule-" + choice.stored)
                                .semantics(mergeDescendants = true) {
                                    contentDescription = choice.sentence
                                    if (choice.picked) this.selected = true
                                },
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            RuleMark(choice.picked)
                            Text(choice.sentence, style = centraidType("annotLabel"), color = if (choice.picked) Surface.ink else Surface.meta)
                        }
                    }
                }
                if (model.include_videos_label.isNotEmpty()) {
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 16.dp).testTag("backup-include-videos"),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text(model.include_videos_label, style = centraidType("body"), color = Surface.ink, modifier = Modifier.weight(1f))
                        Switch(
                            checked = model.include_videos,
                            onCheckedChange = {
                                onEvent(BackupHomeEvent(set_include_videos = BackupHomeEvent.SetIncludeVideos(include = it)))
                            },
                            colors = SwitchDefaults.colors(checkedTrackColor = appAccent("").fill),
                            modifier = Modifier.semantics { contentDescription = model.include_videos_label },
                        )
                    }
                }
            }
        }
        if (model.key_heading.isNotEmpty() || model.restore_label.isNotEmpty()) {
            Group(model.key_heading) {
                if (model.key_heading.isNotEmpty()) {
                    val open = model.key_show_label.isNotEmpty()
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 56.dp)
                            .clickable(enabled = open, onClick = onShowWords)
                            .padding(horizontal = 12.dp)
                            .testTag("backup-show-key")
                            .semantics(mergeDescendants = true) { contentDescription = model.key_show_label + ". " + model.key_summary },
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        KitTile(iconKey = "Key", size = 32.dp)
                        Column(Modifier.weight(1f)) {
                            Text(model.key_heading, style = centraidType("body"), color = Surface.ink)
                            Text(
                                model.key_summary,
                                style = centraidType("annotLabel"),
                                color = if (model.key_warning) StateColor.Amber.text else Surface.meta,
                            )
                        }
                        if (open) CentraidIcon(iconKey = "ChevronRight", tint = Surface.meta, size = 16.dp)
                    }
                    Box(Modifier.padding(horizontal = 16.dp, vertical = 10.dp).testTag("backup-key-line")) {
                        Text(model.key_line, style = centraidType("annotLabel"), color = Surface.meta)
                    }
                    if (model.key_sync_label.isNotEmpty()) {
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
                                .clickable(role = Role.Button) {
                                    onEvent(BackupHomeEvent(set_key_sync = BackupHomeEvent.SetKeySync(on = !model.key_synced)))
                                }
                                .padding(horizontal = 16.dp)
                                .testTag("backup-key-sync"),
                            contentAlignment = Alignment.CenterStart,
                        ) {
                            Text(model.key_sync_label, style = centraidType("body"), color = appAccent("").text)
                        }
                    }
                }
                if (model.restore_label.isNotEmpty()) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 56.dp)
                            .clickable { onEvent(BackupHomeEvent(restore_pressed = BackupHomeEvent.RestorePressed())) }
                            .padding(horizontal = 12.dp)
                            .testTag("backup-restore"),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        KitTile(iconKey = "History", size = 32.dp)
                        Text(model.restore_label, style = centraidType("body"), color = Surface.ink, modifier = Modifier.weight(1f))
                        CentraidIcon(iconKey = "ChevronRight", tint = Surface.meta, size = 16.dp)
                    }
                }
            }
        }
    }
}

private val CardRadius = 16.dp

@Composable
private fun conditionTint(model: BackupHomeData) = when (model.condition) {
    BackupCondition.BACKUP_CONDITION_UP_TO_DATE -> StateColor.Green.text
    BackupCondition.BACKUP_CONDITION_RUNNING -> Surface.meta
    BackupCondition.BACKUP_CONDITION_NOT_REACHED -> StateColor.Amber.text
    else -> if (model.line?.tone == BackupLine.Tone.TONE_URGENT) StateColor.Red.text else StateColor.Amber.text
}

private fun needsNotificationGrant(context: Context): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
        PackageManager.PERMISSION_GRANTED

/**
 * WHETHER THE SYSTEM IS HOLDING CENTRAID BACK TO SAVE BATTERY. A platform fact only
 * the shell can read; the screen says WHEN it matters (a backlog that has stood for a
 * day), this says WHETHER it applies.
 */
private fun ignoresBatteryOptimizations(context: Context): Boolean =
    context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) ?: true

/**
 * The system's own list, where the member chooses. Not the direct per-app request:
 * that needs a permission the store polices, and the choice is the member's to make
 * on the system's page.
 */
private fun openBatterySettings(context: Context) {
    runCatching {
        context.startActivity(
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}

/** ONE GROUP: its name in the small caps rung over one card of rows. */
@Composable
private fun Group(heading: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (heading.isNotEmpty()) {
            Text(
                heading.uppercase(),
                style = centraidType("eyebrow"),
                color = Surface.meta,
                modifier = Modifier.padding(start = 4.dp, top = 12.dp).semantics { heading() },
            )
        }
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(CardRadius)).background(Surface.card)) { content() }
    }
}

@Composable
private fun RowRule() {
    Box(Modifier.fillMaxWidth().padding(start = 56.dp).height(CentraidGeometry.HAIRLINE.dp).background(Surface.line))
}

/** THE RULE'S CHOICE MARK: a ring, filled when picked. */
@Composable
private fun RuleMark(picked: Boolean) {
    Box(
        Modifier.size(20.dp).border(1.5.dp, if (picked) Surface.ink else Surface.border, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        if (picked) Box(Modifier.size(10.dp).background(Surface.ink, CircleShape))
    }
}

/** One of the screen's sentences, drawn quietly. */
@Composable
private fun Sentence(text: String, testTag: String? = null) {
    Text(
        text,
        style = centraidType("annotLabel"),
        color = Surface.meta,
        modifier = if (testTag == null) Modifier else Modifier.testTag(testTag),
    )
}

@Composable
private fun AddDevice(label: String, onAddDestination: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .clickable(onClick = onAddDestination)
            .padding(horizontal = 12.dp)
            .testTag("backup-add-destination"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(32.dp), contentAlignment = Alignment.Center) {
            CentraidIcon(iconKey = "Plus", tint = appAccent("").text, size = 18.dp)
        }
        Text(label, style = centraidType("body"), color = appAccent("").text)
    }
}

@Composable
private fun Destinations(model: BackupHomeData, onEvent: (BackupHomeEvent) -> Unit, onAddDestination: () -> Unit) {
    model.destinations.forEach { row ->
        Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            KitTile(iconKey = "Monitor", size = 32.dp)
            Column(
                Modifier.weight(1f).clearAndSetSemantics { contentDescription = row.accessibility_label.ifEmpty { row.label } },
                verticalArrangement = Arrangement.spacedBy(1.dp),
            ) {
                Text(row.label, style = centraidType("body"), color = Surface.ink)
                if (row.held.isNotEmpty()) Sentence(row.held)
                if (row.detail.isNotEmpty()) Sentence(row.detail)
            }
            // FORGET IS PLAIN AND VISIBLE, and needs no confirmation: it forgets this phone's pairing and
            // nothing the backup device holds, and pairing again undoes it.
            if (model.forget_label.isNotEmpty()) {
                OutlineButton(
                    label = model.forget_label,
                    testTag = "backup-forget-" + row.gateway_id,
                    modifier = Modifier.semantics { contentDescription = model.forget_label + " " + row.label },
                ) {
                    onEvent(BackupHomeEvent(forget_destination = BackupHomeEvent.ForgetDestination(gateway_id = row.gateway_id)))
                }
            }
        }
        RowRule()
    }
    if (model.add_destination_label.isNotEmpty()) AddDevice(model.add_destination_label, onAddDestination)
}

/** "IN THIS BACKUP" and "Not backed up yet": one row per app, its mark, what it holds, whether it is backed up. */
@Composable
private fun Apps(rows: List<BackupAppRow>) {
    rows.forEachIndexed { index, row ->
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .padding(horizontal = 12.dp, vertical = 8.dp)
                .testTag("backup-app-" + row.app_id)
                .clearAndSetSemantics { contentDescription = row.accessibility_label.ifEmpty { row.name } },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            AppTile(appId = row.app_id, size = 32.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(row.name, style = centraidType("body"), color = Surface.ink)
                if (row.detail.isNotEmpty()) Sentence(row.detail)
                if (row.note.isNotEmpty()) Sentence(row.note)
            }
            if (row.status.isNotEmpty()) {
                Text(
                    row.status,
                    style = centraidType("annotLabel"),
                    color = if (row.waiting) StateColor.Amber.text else Surface.meta,
                )
            }
        }
        if (index < rows.size - 1) RowRule()
    }
}
