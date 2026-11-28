package dev.centraid.android.kit

import android.content.Context
import centraid.core.v1.EffectFailed

/**
 * WHAT A CALENDAR OR CONTACTS READ SAYS WHEN THE PHONE HAS NOT GRANTED IT.
 *
 * A permission this app never asked for is not a refusal: the screens keep offering the import,
 * whose tap asks. Only a permission that was asked for and not granted is `denied`. Android cannot
 * tell the two apart itself, so the asking is recorded in a preferences file of its own.
 */
internal object StoreRefusal {
    fun failure(asked: Boolean, restricted: Boolean = false): EffectFailed = when {
        restricted -> EffectFailed(reason = EffectReason.DENIED, denied = true, restricted = true)
        asked -> EffectFailed(reason = EffectReason.DENIED, denied = true)
        else -> EffectFailed(reason = EffectReason.UNAVAILABLE)
    }

    fun asked(context: Context, permission: String): Boolean =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getBoolean(permission, false)

    fun noteAsked(context: Context, permission: String) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putBoolean(permission, true).commit()
    }

    private const val FILE: String = "centraid.store-asked"
}
