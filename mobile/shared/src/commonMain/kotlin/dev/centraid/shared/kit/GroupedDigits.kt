package dev.centraid.shared.kit

/** Thousands separated, so a six-figure row count is readable at a glance. */
public fun groupedDigits(value: Long): String = value.toString()
    .reversed()
    .chunked(3)
    .joinToString(",")
    .reversed()
