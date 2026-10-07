package dev.centraid.shared.shell

import centraid.screen.v1.HomeTile
import dev.centraid.design.CentraidCatalog
import dev.centraid.design.copy.SharedCopy

/**
 * WHAT A SCREEN READER SAYS FOR A HOME TILE (#1047: views decide nothing).
 * Both shells spelled "Open {name}, {count} {noun}" themselves; the words are
 * computed here once, from the catalogue's name and the tile's own count.
 */
internal object HomeTileWords {
    /** `(open_label, accessibility_label)`: "Open People", "Open People, 5 people". */
    fun spoken(tile: HomeTile): Pair<String, String> {
        val name = CentraidCatalog.byId[tile.app_id]?.name ?: tile.app_id.replaceFirstChar { it.uppercase() }
        val open = SharedCopy.OPEN_APP.replace("{name}", name)
        // The withheld glyph (an absent count) is never spoken: the noun alone.
        val count = tile.count
        val said = when {
            count == null -> tile.count_label
            count.capped -> "${count.value_}+ ${tile.count_label}"
            else -> "${count.value_} ${tile.count_label}"
        }.trim()
        return open to if (said.isEmpty()) open else "$open, $said"
    }
}
