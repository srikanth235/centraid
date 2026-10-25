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
import centraid.core.v1.BackupHomeData
import centraid.core.v1.BackupHomeEvent
import centraid.core.v1.BackupHomeState
import centraid.core.v1.BackupInk
import centraid.core.v1.Route
import dev.centraid.android.kit.FailureView
import dev.centraid.android.kit.InkButton
import dev.centraid.android.kit.KitSpinner
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
    val paired = model.destinations.isNotEmpty()
    val line = model.line
    // WHETHER THE SYSTEM IS HOLDING CENTRAID BACK is the platform's to say; WHEN it
    // matters (a backlog that stood a day) is the screen's.
    val batteryHeld = model.battery_sentence.isNotEmpty() && !ignoresBatteryOptimizations(context)
    Column(
        Modifier
            .fillMaxWidth()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = CentraidGeometry.PAGE_MARGIN.dp, vertical = 24.dp)
            .testTag("backup-screen"),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        // WHERE THE BACKUP STANDS, and the one act that moves it: with nothing paired
        // that act is adding a backup device, drawn as the page's primary; once one is
        // paired it is "Back up now" (iOS `BackupHomeView`).
        Head(model.title, line?.sentence.orEmpty())
        if (!line?.detail.isNullOrEmpty()) Sentence(line?.detail.orEmpty())
        line?.waiting.orEmpty().map { it.sentence }.filter { it.isNotEmpty() }.forEach { Sentence(it) }
        // WHY THE PHONE WILL NOT WAKE CENTRAID, when it will not.
        if (model.background_notice.isNotEmpty()) Sentence(model.background_notice, "backup-background-notice")
        if (batteryHeld) {
            Sentence(model.battery_sentence)
            if (model.battery_label.isNotEmpty()) {
                OutlineButton(label = model.battery_label, testTag = "backup-battery") { openBatterySettings(context) }
            }
        }
        // ONE INK BUTTON AT A TIME, and the screen names it (`ink`); a verb that is not
        // the page's one thing to do is the outline.
        if (!paired && model.add_destination_label.isNotEmpty()) {
            if (model.ink == BackupInk.BACKUP_INK_ADD_DESTINATION) {
                InkButton(label = model.add_destination_label, testTag = "backup-add-destination", onPress = onAddDestination)
            } else {
                OutlineButton(label = model.add_destination_label, testTag = "backup-add-destination", onPress = onAddDestination)
            }
        }
        // BACK UP NOW, only once there is somewhere to back up to (the screen draws no
        // label before). Pressable when the screen says so; while a run goes, its
        // progress sentence stands beside it.
        if (model.back_up_now_label.isNotEmpty()) {
            if (model.ink == BackupInk.BACKUP_INK_BACK_UP_NOW) {
                InkButton(
                    label = model.back_up_now_label,
                    testTag = "backup-now",
                    enabled = model.back_up_now_enabled,
                    onPress = onBackUpNow,
                )
            } else {
                OutlineButton(
                    label = model.back_up_now_label,
                    testTag = "backup-now",
                    enabled = model.back_up_now_enabled,
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
        // A KEY ON THIS PHONE ALONE IS THE PAGE'S FIRST CONCERN: a lost phone takes
        // every vault with it, whatever is backed up.
        if (model.key_warning) RecoveryKey(model, onEvent, onShowWords)
        if (paired) Section(model.devices_heading) { Destinations(model, onEvent, onAddDestination) }
        if (model.rule_choices.isNotEmpty()) {
            Section(model.rule_label) {
                model.rule_choices.forEach { choice ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 44.dp)
                            .clickable {
                                onEvent(BackupHomeEvent(rule_chosen = BackupHomeEvent.RuleChosen(stored = choice.stored)))
                            }
                            .padding(vertical = 8.dp)
                            .testTag("backup-rule-" + choice.stored)
                            .semantics(mergeDescendants = true) {
                                contentDescription = choice.sentence
                                if (choice.picked) this.selected = true
                            },
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        RuleMark(choice.picked)
                        Text(
                            choice.sentence,
                            style = centraidType("small"),
                            color = centraidColor(if (choice.picked) "text" else "textSoft"),
                        )
                    }
                }
            }
        }
        if (model.include_videos_label.isNotEmpty()) {
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
                    model.include_videos_label,
                    style = centraidType("body"),
                    color = centraidColor("text"),
                    modifier = Modifier.weight(1f),
                )
                Switch(
                    checked = model.include_videos,
                    onCheckedChange = {
                        onEvent(BackupHomeEvent(set_include_videos = BackupHomeEvent.SetIncludeVideos(include = it)))
                    },
                    colors = SwitchDefaults.colors(checkedTrackColor = centraidColor("accent")),
                    modifier = Modifier.semantics { contentDescription = model.include_videos_label },
                )
            }
        }
        // THE RECOVERY KEY BELONGS HERE: it is the other half of getting a vault back,
        // beside the backup device that holds the copy.
        if (!model.key_warning) RecoveryKey(model, onEvent, onShowWords)
    }
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

/** The page's head: its title and the line. */
@Composable
private fun Head(title: String, lead: String) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (title.isNotEmpty()) {
            Text(
                title,
                style = centraidType("title"),
                color = centraidColor("text"),
                modifier = Modifier.testTag("backup-title").semantics { heading() },
            )
        }
        if (lead.isNotEmpty()) Text(lead, style = centraidType("body"), color = centraidColor("textSoft"))
    }
}

/**
 * WHERE THE RECOVERY KEY IS, and what can be done about it (iOS
 * `BackupHomeView.recoveryKey`). A warning carries the attention mark Home's line
 * uses, and the screen makes "Show recovery key" the page's Ink button (`ink`);
 * otherwise it is one quiet sentence and an outline button. Moving the key into or
 * out of the keychain is a plain link: a choice made once, not a thing to do.
 */
@Composable
private fun RecoveryKey(model: BackupHomeData, onEvent: (BackupHomeEvent) -> Unit, onShowKey: () -> Unit) {
    if (model.key_heading.isEmpty()) return
    Section(model.key_heading) {
        if (model.key_warning) {
            Row(
                Modifier.height(IntrinsicSize.Min).testTag("backup-key-line").semantics(mergeDescendants = true) { },
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(Modifier.width(2.dp).fillMaxHeight().background(centraidColor("attention")))
                Text(model.key_line, style = centraidType("body"), color = centraidColor("text"))
            }
        } else {
            Sentence(model.key_line, "backup-key-line")
        }
        if (model.key_show_label.isNotEmpty()) {
            if (model.ink == BackupInk.BACKUP_INK_SHOW_KEY) {
                InkButton(label = model.key_show_label, testTag = "backup-show-key", onPress = onShowKey)
            } else {
                OutlineButton(label = model.key_show_label, testTag = "backup-show-key", onPress = onShowKey)
            }
        }
        if (model.key_sync_label.isNotEmpty()) {
            Box(
                Modifier
                    .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
                    .clickable(role = Role.Button) {
                        onEvent(BackupHomeEvent(set_key_sync = BackupHomeEvent.SetKeySync(on = !model.key_synced)))
                    }
                    .testTag("backup-key-sync"),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text(model.key_sync_label, style = centraidType("small"), color = centraidColor("link"))
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

/** One of the screen's sentences, drawn quietly. */
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
    model: BackupHomeData,
    onEvent: (BackupHomeEvent) -> Unit,
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
                        .clearAndSetSemantics { contentDescription = row.accessibility_label.ifEmpty { row.label } },
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(row.label, style = centraidType("smallStrong"), color = centraidColor("text"))
                    if (row.detail.isNotEmpty()) {
                        Text(row.detail, style = centraidType("mono"), color = centraidColor("textFaint"))
                    }
                }
                // FORGET IS PLAIN AND VISIBLE, and needs no confirmation: it forgets this
                // phone's pairing and nothing the gateway holds, and pairing again undoes it.
                if (model.forget_label.isNotEmpty()) {
                    OutlineButton(
                        label = model.forget_label,
                        testTag = "backup-forget-" + row.gateway_id,
                        modifier = Modifier.semantics { contentDescription = model.forget_label + " " + row.label },
                    ) {
                        onEvent(
                            BackupHomeEvent(
                                forget_destination = BackupHomeEvent.ForgetDestination(gateway_id = row.gateway_id),
                            ),
                        )
                    }
                }
            }
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(CentraidGeometry.HAIRLINE.dp)
                    .background(centraidColor("line")),
            )
        }
        if (model.add_destination_label.isNotEmpty()) {
            OutlineButton(
                label = model.add_destination_label,
                testTag = "backup-add-destination",
                modifier = Modifier.padding(top = 12.dp),
                onPress = onAddDestination,
            )
        }
    }
}
