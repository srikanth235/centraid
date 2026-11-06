package dev.centraid.android.kit

import androidx.annotation.ColorRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import dev.centraid.android.R

/**
 * An app's colour (#1173), by the app id Rust sends (`ChatCard.app`,
 * `ChatPending.app`): anything shown from another app is drawn in THAT app's
 * colour. The values are the generated resources (`centraid_app_<id>` for the
 * fill, `centraid_app_<id>_text` for text), so light and dark are the design
 * source's; this only says which resource an id is. An empty or unknown id is
 * the shell's own teal, which is what a thing that belongs to no app wears.
 */
@Composable
public fun appAccentFill(appId: String): Color = tokenColor(fillRes(appId))

/** The app's colour as text or an icon: lighter in dark. */
@Composable
public fun appAccentText(appId: String): Color = tokenColor(textRes(appId))

@ColorRes
private fun fillRes(appId: String): Int =
    when (appId) {
        "agenda" -> R.color.centraid_app_agenda
        "notes" -> R.color.centraid_app_notes
        "people" -> R.color.centraid_app_people
        "docs" -> R.color.centraid_app_docs
        "money" -> R.color.centraid_app_money
        "locker" -> R.color.centraid_app_locker
        "health" -> R.color.centraid_app_health
        "photos" -> R.color.centraid_app_photos
        else -> R.color.centraid_shell
    }

@ColorRes
private fun textRes(appId: String): Int =
    when (appId) {
        "agenda" -> R.color.centraid_app_agenda_text
        "notes" -> R.color.centraid_app_notes_text
        "people" -> R.color.centraid_app_people_text
        "docs" -> R.color.centraid_app_docs_text
        "money" -> R.color.centraid_app_money_text
        "locker" -> R.color.centraid_app_locker_text
        "health" -> R.color.centraid_app_health_text
        "photos" -> R.color.centraid_app_photos_text
        else -> R.color.centraid_shell_text
    }
