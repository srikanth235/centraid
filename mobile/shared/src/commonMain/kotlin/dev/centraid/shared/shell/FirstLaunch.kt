package dev.centraid.shared.shell

/**
 * THE FIRST-LAUNCH GATE'S HOUSE: the apps it shows a phone that holds no vault (#1129).
 *
 * **It is Home's roster, not a list of its own.** Both shells used to type the marks by hand, and
 * Money and Health were never added when they reached Home: a fresh install was shown a house
 * with two rooms missing. Reading [SpringboardPolicy.SPRINGBOARD_ORDER] means an app that gets a
 * tile is in the house the same day, in the same order. `FirstLaunchRosterSpec` is the claim.
 *
 * The gate shows the apps and asks for nothing: a phone permission (HealthKit, Health Connect,
 * the address book) is asked only by that app's own button.
 */
public object FirstLaunch {
    /** Every app Home draws a tile for, in Home's order: the ids the house's marks are drawn from. */
    public val APPS: List<String> get() = SpringboardPolicy.SPRINGBOARD_ORDER
}
