package dev.centraid.android.kit

import android.content.res.Configuration
import android.util.TypedValue
import androidx.annotation.ColorRes
import androidx.annotation.DimenRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import dev.centraid.android.theme.centraidDark

/**
 * A redesign colour (#1173) from the generated `res/values{,-night}/colors.xml`,
 * resolved for the scheme in force.
 *
 * `colorResource` answers for the PHONE's night mode; the member's appearance
 * (R-CHROME-7) can differ from it, and the screen must follow the member's. So the
 * lookup runs against a configuration whose night bit is the screen's own.
 */
@Composable
public fun tokenColor(@ColorRes id: Int): Color {
    val dark = centraidDark()
    val context = LocalContext.current
    return remember(id, dark, context) {
        val configuration = Configuration(context.resources.configuration)
        val night = if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
        configuration.uiMode = (configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or night
        Color(context.createConfigurationContext(configuration).getColor(id))
    }
}

/**
 * A step of the redesign's type scale (`res/values/dimens.xml`, `centraid_text_*`),
 * as the `sp` number the file holds. Compose applies the font scale to an `sp`
 * itself, so this reads the raw number and not a resolved pixel size.
 */
@Composable
public fun tokenSp(@DimenRes id: Int): TextUnit {
    val resources = LocalContext.current.resources
    return remember(id) {
        val value = TypedValue()
        resources.getValue(id, value, true)
        TypedValue.complexToFloat(value.data).sp
    }
}
