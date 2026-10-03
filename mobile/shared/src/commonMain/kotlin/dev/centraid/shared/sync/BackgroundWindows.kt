package dev.centraid.shared.sync

/**
 * WHICH WINDOWS ANDROID ASKS WORKMANAGER FOR, AND UNDER WHAT CONSTRAINTS
 * (#1080, the shells: "periodic WorkManager under constraints derived from the
 * rule").
 *
 * Platform-free so `BackgroundSchedulingSpec` proves it on the JVM; the Android
 * actual only maps [Link] onto `NetworkType` and [requiresCharging] onto
 * `setRequiresCharging`. iOS has no constraint per window beyond the
 * processing request's, which is fixed (`IosBackgroundTasks`).
 *
 * **The core still decides every item.** A window's constraint is a floor that
 * saves waking the phone for nothing, never the rule itself: a window that ran
 * on cellular under [TransferRule.WIFI_ONLY] would move thumbnails and leave
 * originals and the snapshot to the core's own refusal.
 */
public object BackgroundWindows {

    /** The network a window may start on. */
    public enum class Link {
        /** Any connected network. */
        CONNECTED,

        /** A network the member is not paying for. */
        UNMETERED,
    }

    public data class Window(
        public val name: String,
        public val link: Link,
        public val requiresCharging: Boolean,
        /** The period of a periodic window; zero for a one-off. */
        public val periodMinutes: Long = 0,
    )

    /**
     * The periodic window. **UNMETERED unless the rule lets photographs cross
     * cellular**: under Wi-Fi only and manual the originals and the snapshot
     * wait for Wi-Fi, so a cellular window would wake the phone to move
     * thumbnails a foreground pass moves anyway.
     */
    public fun periodic(rule: TransferRule): Window = Window(
        name = PERIODIC,
        link = if (rule == TransferRule.WIFI_AND_CELLULAR_PHOTOS) Link.CONNECTED else Link.UNMETERED,
        requiresCharging = false,
        periodMinutes = PERIOD_MINUTES,
    )

    /**
     * THE NIGHT SHIFT: charging and unmetered, where a camera roll's first
     * backup and every video's original actually move (`WAIT_REASON_CHARGER`
     * items wait for this one). Hourly: the periodic window already runs on a
     * charger, so this one only buys the long idle windows WorkManager grants
     * a charging phone.
     */
    public val NIGHT_SHIFT: Window =
        Window(name = NIGHT, link = Link.UNMETERED, requiresCharging = true, periodMinutes = NIGHT_PERIOD_MINUTES)

    /** After a capture or an import: as soon as the rule's own floor allows. */
    public fun nudge(rule: TransferRule): Window = periodic(rule).copy(name = NUDGE, periodMinutes = 0)

    /**
     * v0's unique name for the periodic work, kept: a rename would orphan what a
     * shipped build scheduled, and `UPDATE` migrates the request in place.
     */
    public const val PERIODIC: String = "centraid-sync-pass"
    public const val NIGHT: String = "centraid-night-shift"
    public const val NUDGE: String = "centraid-nudge"

    /** WorkManager's periodic floor. */
    public const val PERIOD_MINUTES: Long = 15
    public const val NIGHT_PERIOD_MINUTES: Long = 60
}
