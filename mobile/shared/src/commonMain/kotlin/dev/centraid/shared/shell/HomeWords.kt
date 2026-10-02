package dev.centraid.shared.shell

import dev.centraid.design.copy.SharedCopy

/**
 * THE FRAME'S OWN WORDS — Home, the band and the vault switcher (#1047: views
 * decide nothing). No machine state carries them because none of them varies
 * with state; they lived as literals in `HomeView.swift`, `Band.swift` and
 * their Compose twins, and are in `copy/shared.json` now. The two sentences
 * that fill a slot are composed here, once for both shells.
 */
public object HomeWords {
    public const val ALL_APPS: String = SharedCopy.HOME_ALL_APPS
    public const val LOADING: String = SharedCopy.HOME_LOADING
    public const val PHOTOS_ABSENT: String = SharedCopy.HOME_PHOTOS_ABSENT
    public const val DAY_ONE_TITLE: String = SharedCopy.HOME_DAY_ONE_TITLE
    public const val DAY_ONE_BODY: String = SharedCopy.HOME_DAY_ONE_BODY
    public const val FIRST_MOVES: String = SharedCopy.HOME_FIRST_MOVES

    /**
     * THE BACKUP NUDGE'S WORDS. They ride `HomeData.backup_nudge` — `HomeMachine`
     * writes them — so a view draws the message it is handed and names none.
     */
    public const val NO_BACKUP: String = SharedCopy.HOME_NO_BACKUP
    public const val NO_BACKUP_ACTION: String = SharedCopy.HOME_NO_BACKUP_ACTION
    public const val NO_BACKUP_DISMISS: String = SharedCopy.HOME_NO_BACKUP_DISMISS

    /** THE FIRST-LAUNCH GATE (a device that holds no vault): one sentence, two actions. */
    public const val FIRST_LAUNCH_BODY: String = SharedCopy.FIRST_LAUNCH_BODY
    public const val FIRST_LAUNCH_HOUSE_TITLE: String = SharedCopy.FIRST_LAUNCH_HOUSE_TITLE
    public const val FIRST_LAUNCH_HOUSE_BODY: String = SharedCopy.FIRST_LAUNCH_HOUSE_BODY
    public const val FIRST_LAUNCH_KEY_TITLE: String = SharedCopy.FIRST_LAUNCH_KEY_TITLE
    public const val FIRST_LAUNCH_KEY_BODY: String = SharedCopy.FIRST_LAUNCH_KEY_BODY
    public const val FIRST_LAUNCH_COPY_TITLE: String = SharedCopy.FIRST_LAUNCH_COPY_TITLE
    public const val FIRST_LAUNCH_COPY_BODY: String = SharedCopy.FIRST_LAUNCH_COPY_BODY
    public const val FIRST_LAUNCH_NEXT: String = SharedCopy.FIRST_LAUNCH_NEXT
    public const val FIRST_LAUNCH_SKIP: String = SharedCopy.FIRST_LAUNCH_SKIP
    public const val FIRST_LAUNCH_MAKE: String = SharedCopy.FIRST_LAUNCH_MAKE
    public const val FIRST_LAUNCH_RESTORE: String = SharedCopy.FIRST_LAUNCH_RESTORE

    /**
     * THE SAMPLE VAULT'S WORDS: the one sentence Day One and the deck say about
     * it, and its two verbs. The vault's own name is `Shelf.SAMPLE_VAULT_NAME`,
     * because it is written into the vault rather than drawn beside it.
     */
    public const val SAMPLE_LINE: String = SharedCopy.SAMPLE_LINE
    public const val SAMPLE_REMOVE: String = SharedCopy.SAMPLE_REMOVE
    public const val SAMPLE_ADD: String = SharedCopy.SAMPLE_ADD

    /** "Add sample" while the scenario is still being seeded: the row's quiet, disabled label. */
    public const val SAMPLE_ADDING: String = SharedCopy.SAMPLE_ADDING

    /**
     * "Remove sample"'s confirmation: the destructive verb and the one
     * sentence under it. Removal deletes a vault, so it is confirmed even
     * though nothing of the member's goes with it.
     */
    public const val SAMPLE_REMOVE_CONFIRM: String = SharedCopy.SAMPLE_REMOVE_CONFIRM
    public const val SAMPLE_REMOVE_BODY: String = SharedCopy.SAMPLE_REMOVE_BODY

    public const val BAND_HOME: String = SharedCopy.BAND_HOME
    public const val BAND_MORE: String = SharedCopy.BAND_MORE
    public const val BAND_MORE_SPOKEN: String = SharedCopy.BAND_MORE_SPOKEN

    public const val VAULTS_TITLE: String = SharedCopy.VAULTS_TITLE
    public const val VAULTS_ONE: String = SharedCopy.VAULTS_ONE
    public const val VAULTS_MAKE: String = SharedCopy.VAULTS_MAKE
    public const val VAULTS_MAKE_SPOKEN: String = SharedCopy.VAULTS_MAKE_SPOKEN
    public const val VAULTS_KEEP: String = SharedCopy.VAULTS_KEEP
    public const val VAULTS_CURRENT: String = SharedCopy.VAULTS_CURRENT
    public const val VAULTS_FORGET: String = SharedCopy.VAULTS_FORGET
    public const val VAULTS_FORGET_BODY: String = SharedCopy.VAULTS_FORGET_BODY

    /** A switcher row's name: the vault's own, or "Unnamed vault". */
    public fun vaultName(name: String): String = name.ifBlank { SharedCopy.VAULTS_UNNAMED }

    /** The Forget alert's title: "Forget Tahoe?", or "Forget this vault?" for an unnamed one. */
    public fun forgetTitle(name: String): String =
        SharedCopy.VAULTS_FORGET_TITLE.replace("{name}", name.ifBlank { SharedCopy.VAULTS_FORGET_THIS })
}
