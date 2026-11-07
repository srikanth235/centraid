package dev.centraid.android.kit

import android.content.Context
import android.content.res.Configuration
import androidx.annotation.ColorRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.centraid.android.R
import dev.centraid.android.theme.centraidDark
import dev.centraid.design.CentraidCatalog
import dev.centraid.design.CentraidGeometry

/**
 * A COLOUR RESOURCE IN THE SCHEME THE MEMBER CHOSE (#1173).
 *
 * `colorResource` resolves against the phone's night mode, but the member may have forced the
 * other appearance (`CentraidTheme(dark = ...)`), so the resource is read from a configuration
 * that says which scheme is drawn. Only the colour is read this way: the context every other
 * call sees is untouched, because an activity-bound effect needs the real one.
 */
@Composable
internal fun centraidResource(@ColorRes id: Int): Color {
    val context = LocalContext.current
    val dark = centraidDark()
    val scheme = remember(context, dark) { context.inScheme(dark) }
    return Color(scheme.getColor(id))
}

private fun Context.inScheme(dark: Boolean): Context {
    val config = Configuration(resources.configuration)
    val night = if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
    config.uiMode = (config.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or night
    return createConfigurationContext(config)
}

/**
 * AN APP'S COLOUR, as the three values the design gives it. The one hook for every screen that
 * wears an app: `appAccent("agenda")`. The shell's places (`home`, `chat`, `backup`) and any id
 * this table does not know wear the shell's teal.
 *
 * - [fill] is the colour under white glyphs: the filled `+`, a button, a selected state. In dark
 *   it is the deeper value, so white on it stays 4.5:1 or more.
 * - [text] is the colour as text or an icon on the page or a card: a title, a star, a link. In
 *   light it equals [fill].
 * - [tile] is the bright colour on a tile or an icon where the accent is not that (Notes'
 *   yellow). It does not change in dark.
 *
 * Stars use [text], never amber: amber only means a state.
 */
@Immutable
public data class AppAccent(val appId: String, val fill: Color, val text: Color, val tile: Color) {
    /** The tint behind an app's glyph: the fill at the icon chip's own strength. */
    public fun wash(dark: Boolean): Color =
        fill.copy(alpha = (if (dark) CentraidGeometry.ICON_CHIP_TINT_DARK else CentraidGeometry.ICON_CHIP_TINT_LIGHT).toFloat())
}

@Composable
public fun appAccent(appId: String): AppAccent {
    val ids = accentResources(appId)
    return AppAccent(
        appId = appId,
        fill = centraidResource(ids[0]),
        text = centraidResource(ids[1]),
        tile = centraidResource(ids[2]),
    )
}

/** The accent of the app the view is drawn in, stated once by an app's place. */
public val LocalAppAccentId = compositionLocalOf { "" }

/** The accent in force: the enclosing place's app, or the shell's. */
@Composable
public fun appAccent(): AppAccent = appAccent(LocalAppAccentId.current)

/** The fill, text and tile resources for an app id (fill, text, tile). */
private fun accentResources(appId: String): IntArray = when (appId) {
    "agenda" -> intArrayOf(R.color.centraid_app_agenda, R.color.centraid_app_agenda_text, R.color.centraid_app_agenda_tile)
    "docs" -> intArrayOf(R.color.centraid_app_docs, R.color.centraid_app_docs_text, R.color.centraid_app_docs_tile)
    "health" -> intArrayOf(R.color.centraid_app_health, R.color.centraid_app_health_text, R.color.centraid_app_health_tile)
    "locker" -> intArrayOf(R.color.centraid_app_locker, R.color.centraid_app_locker_text, R.color.centraid_app_locker_tile)
    "money" -> intArrayOf(R.color.centraid_app_money, R.color.centraid_app_money_text, R.color.centraid_app_money_tile)
    "notes" -> intArrayOf(R.color.centraid_app_notes, R.color.centraid_app_notes_text, R.color.centraid_app_notes_tile)
    "people" -> intArrayOf(R.color.centraid_app_people, R.color.centraid_app_people_text, R.color.centraid_app_people_tile)
    "photos" -> intArrayOf(R.color.centraid_app_photos, R.color.centraid_app_photos_text, R.color.centraid_app_photos_tile)
    else -> intArrayOf(R.color.centraid_shell, R.color.centraid_shell_text, R.color.centraid_shell)
}

/**
 * AN APP'S TILE (#1173): its glyph in white on the app's own solid colour, the way the boards
 * draw a row that names an app (Backup's "In this backup").
 */
@Composable
public fun AppTile(appId: String, size: Dp = 32.dp) {
    val app = CentraidCatalog.byId[appId] ?: return
    KitTile(iconKey = app.iconKey, size = size, fill = appAccent(appId).tile)
}
