package dev.centraid.android.kit

import android.util.TypedValue
import androidx.annotation.DimenRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp

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
