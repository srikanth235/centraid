package dev.centraid.shared.shell

import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.platform.SecureStore

/**
 * THE MEMBER'S APPEARANCE: follow the phone, or hold light or dark
 * (R-CHROME-7). Home's header carries the one control for it, beside the
 * search key.
 *
 * ## One per DEVICE, not per vault
 *
 * Switching vaults must not repaint the phone. It lives in [SecureStore] for
 * the reason [dev.centraid.shared.sync.TransferRule] does: it is the shell's only
 * durable key-value, and both shells parse it here, once.
 *
 * ## ONE TAP, AND NO HIDDEN THIRD STATE
 *
 * The key flips what the screen shows. When the flip lands on what the phone
 * itself shows, the choice is stored as [SYSTEM] rather than pinned, so a
 * member who taps twice is back to following the phone — including its
 * evening switch — without a setting to find. A pin exists only while it
 * disagrees with the phone.
 */
public enum class Appearance(
    /** What [SecureStore] holds. A word, so a dump is readable. */
    public val stored: String,
) {
    SYSTEM("system"),
    LIGHT("light"),
    DARK("dark"),
    ;

    /** Whether the screen is drawn dark, given what the phone itself shows. */
    public fun dark(phoneDark: Boolean): Boolean = held ?: phoneDark

    /** The scheme this holds the window to — null follows the phone. */
    public val held: Boolean? get() = when (this) {
        SYSTEM -> null
        LIGHT -> false
        DARK -> true
    }

    /** The key's tap: the other scheme, or [SYSTEM] when that is the phone's. */
    public fun toggled(phoneDark: Boolean): Appearance {
        val toDark = !dark(phoneDark)
        return when {
            toDark == phoneDark -> SYSTEM
            toDark -> DARK
            else -> LIGHT
        }
    }

    public companion object {
        public val DEFAULT: Appearance = SYSTEM

        /** The [SecureStore] key, under that store's own `centraid.v1.` prefix. */
        public const val KEY: String = "appearance"

        /** An unknown word follows the phone: the failure mode is the default, never a throw. */
        public fun of(stored: String?): Appearance = entries.firstOrNull { it.stored == stored } ?: DEFAULT

        public suspend fun read(store: SecureStore): Appearance = of(store.read(KEY))

        /** [SYSTEM] IS STORED AS ABSENCE, so the store holds a key only while a pin exists. */
        public suspend fun write(store: SecureStore, appearance: Appearance) {
            store.write(KEY, if (appearance == SYSTEM) "" else appearance.stored)
        }

        /**
         * THE KEY AS DRAWN: the glyph and spoken label of where a tap goes.
         * Dark now shows the sun ("Switch to light"); light shows the moon.
         */
        public fun key(dark: Boolean): AppearanceKey =
            if (dark) {
                AppearanceKey(iconKey = "Sun", label = SharedCopy.APPEARANCE_TO_LIGHT)
            } else {
                AppearanceKey(iconKey = "Moon", label = SharedCopy.APPEARANCE_TO_DARK)
            }
    }
}

/** Home's appearance key: a glyph from the catalogue and its spoken label. */
public data class AppearanceKey(
    public val iconKey: String,
    public val label: String,
)
