package dev.centraid.android.kit

public data class SectionHead(
    val title: String = "",
    val count: Int? = null,
    val verb_label: String = "",
)

public data class SearchField(
    val open_: Boolean = false,
    val term: String = "",
    val answered_term: String = "",
    val corrected: String = "",
    val corrected_label: String = "",
)

public data class Money(
    val minor: Long = 0,
    val currency: String = "",
    val exponent: Int = 0,
    val locale: String = "",
)
