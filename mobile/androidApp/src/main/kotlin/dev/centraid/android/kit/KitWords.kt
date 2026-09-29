package dev.centraid.android.kit

/**
 * THE KIT'S OWN FIXED WORDS (K5, #1029) — now the shared kit's
 * (`dev.centraid.shared.kit.KitWords`, over `copy/shared.json`), so Compose
 * and SwiftUI say the same thing and neither spells it (#1047). Every kit
 * composable still takes each word as a parameter defaulting to these, so a
 * screen whose machine carries the word passes it.
 */
public typealias KitWords = dev.centraid.shared.kit.KitWords
