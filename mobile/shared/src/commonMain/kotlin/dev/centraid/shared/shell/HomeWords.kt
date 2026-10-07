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

    public const val BAND_HOME: String = SharedCopy.BAND_HOME
    public const val BAND_MORE: String = SharedCopy.BAND_MORE
    public const val BAND_MORE_SPOKEN: String = SharedCopy.BAND_MORE_SPOKEN

    public const val VAULTS_TITLE: String = SharedCopy.VAULTS_TITLE
    public const val VAULTS_NONE: String = SharedCopy.VAULTS_NONE
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
