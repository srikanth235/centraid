package dev.centraid.shared.shell

/**
 * THE APPS, IN THE ORDER HOME PLACES THEM (#1135).
 *
 * The truth is `crates/screens/src/shell/policy.rs` (`ORDER`), which grades and
 * packs the springboard; `FirstLaunchRosterSpec` holds this copy to it. It stays
 * only because the first-launch gate (custody's lane) lists the same house.
 */
public object SpringboardPolicy {
    public val SPRINGBOARD_ORDER: List<String> = listOf(
        "photos",
        "docs",
        // WIDE TILES FIRST, so the packer never has to pull a small forward:
        // Agenda went wide with its due line (#1128).
        "agenda",
        "notes",
        "money",
        "health",
        "people",
        "locker",
    )
}
