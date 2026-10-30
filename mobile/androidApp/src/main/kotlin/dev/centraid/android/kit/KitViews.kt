package dev.centraid.android.kit

import centraid.core.v1.SearchAsk
import centraid.core.v1.SearchContainer

/**
 * THE KIT'S OWN PARAMETER SHAPES (#1135): what a kit composable takes when no Rust view message
 * has that exact shape. Each is filled field for field from a `ViewState` by the screen that draws
 * it, and decides nothing; every word in one is Rust's.
 */

/** A section's heading, its count when it has one, and its verb. */
public data class SectionHead(
    val title: String = "",
    val count: Int? = null,
    val verb_label: String = "",
)

/**
 * A search field's state: open, the term typed, the term answered, a correction, the answer's containers.
 * [corrected_label] is Rust's finished "Including results for ..." sentence where the screen's state
 * carries one (Chat's drawer, Docs); the other screens' states carry the bare [corrected] term only.
 */
public data class SearchField(
    val open_: Boolean = false,
    val term: String = "",
    val answered_term: String = "",
    val corrected: String = "",
    val corrected_label: String = "",
    val containers: List<SearchContainer> = emptyList(),
    val ask_row: SearchAsk? = null,
)

/** An amount in minor units, in its currency, at its exponent, in a locale (empty: the device's). */
public data class Money(
    val minor: Long = 0,
    val currency: String = "",
    val exponent: Int = 0,
    val locale: String = "",
)
