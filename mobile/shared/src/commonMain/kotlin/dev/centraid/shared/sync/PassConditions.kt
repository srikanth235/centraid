package dev.centraid.shared.sync

import dev.centraid.shared.platform.PlatformServices

/**
 * WHY A PASS RUNS (#1080, the shells). Every trigger on both shells names one,
 * so a pass is never anonymous and [wantsSnapshot] and [asked] are decided by
 * the reason rather than by each caller.
 *
 * A snapshot is forced only where the member or the platform is about to stop
 * looking: "Back up now", the app leaving the screen, and a restore that has
 * just finished. Every other pass leaves "is a snapshot due" to the core,
 * which takes one hourly on an unmetered link with a gateway reachable.
 *
 * **Only "Back up now" is the member asking** (#1080 A24, `DrainRequest.asked`).
 * It alone lets an original be sealed under MANUAL and a video's original be
 * sealed off the charger; leaving the screen and a finished restore time a
 * snapshot and decide nothing else, because the member did not ask for either.
 */
public enum class WakeReason(
    public val wantsSnapshot: Boolean,
    /** The member tapped "Back up now" for this pass (A24). */
    public val asked: Boolean = false,
) {
    /** The session opened: the first pass of a launch. */
    SESSION_OPENED(false),

    /** The app came back to the screen. */
    BECAME_ACTIVE(false),

    /** A commit landed (debounced in [ShelfDrain]). */
    AFTER_COMMIT(false),

    /** A camera-roll pass imported something. */
    AFTER_IMPORT(false),

    /** The link came back or changed (debounced in [ShelfDrain]). */
    CONNECTIVITY(false),

    /** A background window the OS granted. */
    SCHEDULED(false),

    /** The member pressed "Back up now": the one reason that is the member asking. */
    BACK_UP_NOW(wantsSnapshot = true, asked = true),

    /** The app is leaving the screen; the platform's grace bounds the pass. */
    ENTERED_BACKGROUND(true),

    /** A restore finished laying a vault down. */
    RESTORED(true),
}

/**
 * THE MEMBER'S RULE AND THE PLATFORM'S READING, AS ONE VALUE (#1080,
 * `DrainRequest`; D-1025-S7-60, D-1025-S7-74).
 *
 * Read before EVERY pass and never cached across passes: a phone that leaves
 * Wi-Fi between two passes must carry the new answer into the second.
 */
public data class PassConditions(
    public val rule: TransferRule,
    public val includeVideos: Boolean,
    /** The platform's answer, or null when it would not say. */
    public val metered: Boolean?,
    /** The platform's answer, or null when it would not say. */
    public val charging: Boolean?,
) {
    /**
     * The request this pass carries. **The one place null becomes the
     * expensive answer**: metered, and not charging (`phone.proto`'s own
     * defaults for an unknown link).
     */
    public fun input(deadlineMs: Long, reason: WakeReason): DrainInput = DrainInput(
        deadlineMs = deadlineMs,
        rule = rule,
        includeVideos = includeVideos,
        metered = metered ?: true,
        charging = charging ?: false,
        wantsSnapshot = reason.wantsSnapshot,
        asked = reason.asked,
    )

    public companion object {
        /**
         * What a pass carries when nothing has been read: the default rule over
         * a link nobody vouched for.
         */
        public val UNKNOWN: PassConditions = PassConditions(
            rule = TransferRule.DEFAULT,
            includeVideos = true,
            metered = null,
            charging = null,
        )

        /**
         * Read the rule out of the secure store and the link off the
         * platform, and leave the same reading on [LinkConditions] so a grid
         * labels its cells by the rule this pass is about to plan under.
         */
        public suspend fun read(services: PlatformServices): PassConditions {
            val read = PassConditions(
                rule = TransferRule.read(services.secureStore),
                includeVideos = TransferRule.includeVideos(services.secureStore),
                metered = services.powerAndLink.metered(),
                charging = services.powerAndLink.charging(),
            )
            LinkConditions.rule = read.rule
            LinkConditions.metered = read.metered ?: true
            return read
        }
    }
}
