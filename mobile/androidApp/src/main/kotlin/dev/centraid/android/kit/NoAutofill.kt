package dev.centraid.android.kit

import android.os.Build
import android.view.View
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalView

/**
 * THIS VIEW IS LEFT OUT OF THE AUTOFILL STRUCTURE WHILE THE CALLER IS DRAWN
 * (#1047 E3), and its own setting is put back when it goes.
 *
 * For screens whose fields hold a secret the platform's autofill service must
 * never be offered — the 24 words, and Locker's editor, whose passwords Google
 * Password Manager (or any other service) would otherwise offer to fill and
 * then to save into its own store. Compose reports every text field it draws
 * as a virtual child of the host view; with the host excluded
 * (`IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS`) no service sees them, so
 * nothing is filled, suggested inline or saved. Each field also says
 * `ContentDataType.None`, for the case of a host this effect does not reach.
 */
@Composable
public fun NoAutofill() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val view = LocalView.current
    DisposableEffect(view) {
        val before = view.importantForAutofill
        view.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        onDispose { view.importantForAutofill = before }
    }
}
