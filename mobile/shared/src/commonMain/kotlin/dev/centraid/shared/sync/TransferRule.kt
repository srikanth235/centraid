package dev.centraid.shared.sync

import centraid.core.v1.TransferRule as Wire
import dev.centraid.shared.platform.SecureStore

/**
 * THE MEMBER'S TRANSFER RULE (#1025 S4, D-1025-S7-60; #1080).
 *
 * **One setting for both directions** (#1080, the Backup screen): the pass
 * carries it on `DrainRequest.rule` for what this phone BACKS UP, and the
 * fetch window on `originals` for what it DOWNLOADS. The Home header's sheet
 * and the Backup screen draw the same three choices from one store.
 *
 * WhatsApp's auto-download model, and the reason this product wants it:
 * **bytes are never pushed, they are PLANNED, and the plan is a member's
 * setting.** The gateway has no opinion on what a phone pays for and could not
 * have one — it does not know which SIM is in the device, whether the member
 * is abroad, or what they agreed to. So the phone decides what it pays for,
 * always, and the gateway serves what it is asked for.
 *
 * ## One per DEVICE, not per vault
 *
 * What this governs is a data plan, and a phone has one data plan however many
 * vaults it holds. A per-vault rule would be a member setting the same thing
 * twice and getting it wrong once — and the wrong half is a bill.
 *
 * It lives in [SecureStore] because that is the only durable key-value the
 * shell has. Not because it is a secret: it is small, per-device, and has to
 * survive a relaunch.
 *
 * ## THE SHELL HOLDS THE VALUE AND DOES NONE OF THE ARITHMETIC
 *
 * This enum carries a member's choice onto the wire and nothing else. Which
 * tiers a window may fetch under which rule on which link is
 * `centraid_blobs::Budget::admits_original`, in Rust, in one table — a Kotlin
 * or Swift copy of it would be a second rule deciding a member's bill, and the
 * two would drift the first time either was touched. **No sizes and no
 * ceilings appear anywhere in this file.**
 *
 * ## Thumbnails and previews are not in here
 *
 * That is the shape of the ruling rather than an omission. A thumbnail crosses
 * on any link and ahead of everything, because it is kilobytes and it is the
 * grid, and the grid is the product; a preview crosses on any link too,
 * bounded by the short-refresh budget. Only the originals are worth a member's
 * decision, so only the originals have a setting.
 *
 * ## The fixed rule
 *
 * **A video's original never crosses a metered link.** It is
 * [WIFI_AND_CELLULAR_PHOTOS]'s own body rather than a fourth choice: the two
 * differ by three orders of magnitude, and a member who said "photos on
 * cellular" did not say "a 900 MB video on cellular". No setting turns it off.
 */
public enum class TransferRule(
    /** What [SecureStore] holds. A word, so a dump is readable. */
    public val stored: String,
    /**
     * THE SENTENCE A MEMBER READS, in `commonMain` so both shells draw the
     * same one.
     *
     * A rule spelled in each shell is a rule one shell gets wrong, which is
     * the same reason the window policy was not a branch per platform. These
     * are plain sentences and never a label plus a footnote: a member choosing
     * how their phone spends money is owed a sentence they can act on.
     */
    public val sentence: String,
) {
    /** THE DEFAULT. Its failure mode is a late photograph, not a bill. */
    WIFI_ONLY(
        "wifi-only",
        "Back up and download full-size photos and videos on Wi-Fi only.",
    ),

    /** A photograph's original on cellular; a video's still waits for Wi-Fi. */
    WIFI_AND_CELLULAR_PHOTOS(
        "wifi-and-cellular-photos",
        "Back up and download full-size photos on Wi-Fi and cellular. Videos wait for Wi-Fi.",
    ),

    /**
     * Nothing ARRIVES on its own; the member taps what they want. Backing up
     * has no tap — camera-roll backup is automatic (R-1029-PH-4) — so what
     * this phone sends under it waits for Wi-Fi, as under [WIFI_ONLY]
     * (R-1080-D7; the core's admission is lane C's).
     */
    MANUAL(
        "manual",
        "Download full-size photos only when you tap one. Backups of full-size photos and videos wait for Wi-Fi.",
    ),

    ;

    /**
     * The value the window carries. One conversion, here, so the enum and the
     * proto cannot become two vocabularies.
     */
    public fun toWire(): Wire = when (this) {
        WIFI_ONLY -> Wire.TRANSFER_RULE_WIFI_ONLY
        WIFI_AND_CELLULAR_PHOTOS -> Wire.TRANSFER_RULE_WIFI_AND_CELLULAR_PHOTOS
        MANUAL -> Wire.TRANSFER_RULE_MANUAL
    }

    public companion object {
        /** The heading the sheet draws. */
        public const val TITLE: String = "Wi-Fi and cellular"

        /**
         * What the sheet says under the heading, once, rather than repeating
         * "on this device" in all three sentences.
         */
        public const val SUBTITLE: String =
            "This is set for this phone, not for one vault. Thumbnails cross on any network."

        /** The line the header draws when a rule is holding originals back. */
        public fun waitingSentence(count: Int): String = when {
            count <= 0 -> ""
            count == 1 -> "1 original waiting for Wi-Fi"
            else -> "$count originals waiting for Wi-Fi"
        }

        public val DEFAULT: TransferRule = WIFI_ONLY

        /** The [SecureStore] key, under that store's own `centraid.v1.` prefix. */
        public const val KEY: String = "transfer-rule"

        /**
         * AN UNREADABLE VALUE IS THE DEFAULT, NOT A THROW. A member whose
         * preferences were written by a newer build must still sync, and the
         * default is the conservative one — so the failure mode of an unknown
         * word is a phone that spends less, never one that spends more.
         */
        public fun of(stored: String?): TransferRule =
            entries.firstOrNull { it.stored == stored } ?: DEFAULT

        public suspend fun read(store: SecureStore): TransferRule = of(store.read(KEY))

        public suspend fun write(store: SecureStore, rule: TransferRule) {
            store.write(KEY, rule.stored)
        }

        /**
         * THE SECOND CONTROL: whether video originals are backed up at all
         * (#1080, the Backup screen). Its own key because it answers a
         * different question — what, not over which link — and the rule above
         * already says videos never cross cellular.
         *
         * **Absent is INCLUDED**: the complete backup is the default, which is
         * also why the wire spells it `exclude_videos` (seam contract A3) —
         * proto3's zero value is then the whole library.
         */
        public const val INCLUDE_VIDEOS_KEY: String = "transfer-rule.include-videos"

        public suspend fun includeVideos(store: SecureStore): Boolean =
            store.read(INCLUDE_VIDEOS_KEY) != EXCLUDED

        public suspend fun writeIncludeVideos(store: SecureStore, include: Boolean) {
            // INCLUDED IS STORED AS ABSENCE, so the store holds a key only
            // while the member is spending less than the default.
            store.write(INCLUDE_VIDEOS_KEY, if (include) "" else EXCLUDED)
        }

        private const val EXCLUDED: String = "excluded"
    }
}

/**
 * WHAT THE LINK AND THE MEMBER LAST SAID, FOR THE SCREENS THAT LABEL BY IT
 * (#1025 S4, D-1025-S7-62).
 *
 * A cell's state is a fact about this replica AND about a setting, and the
 * replica's own tables hold only the first half — so the second half has to
 * reach a projection that is handed nothing but a `Row`.
 *
 * **It lives in `sync` and not on the app**, because the shell is not allowed
 * to name an app's types (`PerAppLayoutSpec`) and this is not photographs'
 * business anyway: it is the same window the pass runs under, which is what
 * makes it impossible for a grid to draw a download arrow under one rule while
 * the pass plans under another. [PassConditions.read] writes it at the start
 * of every pass, from the reading that pass is about to carry; a screen reads
 * it.
 *
 * The defaults WITHHOLD NOTHING, so a read that ran before anybody said
 * otherwise labels a cell "still on its way" rather than drawing a download
 * arrow over a photograph no rule is holding back.
 */
public object LinkConditions {
    /** The member's rule for originals, as last read from the secure store. */
    public var rule: TransferRule = TransferRule.DEFAULT

    /** The radio's own answer, as the last window carried it. */
    public var metered: Boolean = false
}
