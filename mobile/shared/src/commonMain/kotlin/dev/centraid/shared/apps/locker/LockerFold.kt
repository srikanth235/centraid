package dev.centraid.shared.apps.locker

import centraid.core.v1.LockerItemRow
import centraid.screen.v1.LockerRow
import centraid.screen.v1.StatusChip
import dev.centraid.design.copy.LockerCopy

/**
 * THE WORDS AND KEYS EVERY LOCKER SCREEN SHARES (#1047): a type's name, its
 * chip, its icon key, and an item row. Pure.
 */
public object LockerFold {
    /** The fifteen types, in the vault's CHECK order, with their words. */
    public val TYPES: List<String> = listOf(
        "login", "card", "note", "identity", "wifi", "password",
        "ssh_key", "api_credential", "passport", "bank_account", "driving_licence",
        "software_licence", "crypto_wallet", "membership", "document",
    )

    /** The types whose secret-free subtitle is the item's own (`subtitle_of`). */
    private val SUBTITLED: Set<String> = setOf("login", "identity", "wifi")

    /** The six a phone creates (the handoff's "six types today"). */
    public val CREATABLE: List<String> = listOf("login", "card", "note", "identity", "wifi", "password")

    public fun typeLabel(type: String): String = when (type) {
        "login" -> LockerCopy.TYPE_LOGIN
        "card" -> LockerCopy.TYPE_CARD
        "note" -> LockerCopy.TYPE_NOTE
        "identity" -> LockerCopy.TYPE_IDENTITY
        "wifi" -> LockerCopy.TYPE_WIFI
        "password" -> LockerCopy.TYPE_PASSWORD
        "ssh_key" -> LockerCopy.TYPE_SSH_KEY
        "api_credential" -> LockerCopy.TYPE_API_CREDENTIAL
        "passport" -> LockerCopy.TYPE_PASSPORT
        "bank_account" -> LockerCopy.TYPE_BANK_ACCOUNT
        "driving_licence" -> LockerCopy.TYPE_DRIVING_LICENCE
        "software_licence" -> LockerCopy.TYPE_SOFTWARE_LICENCE
        "crypto_wallet" -> LockerCopy.TYPE_CRYPTO_WALLET
        "membership" -> LockerCopy.TYPE_MEMBERSHIP
        "document" -> LockerCopy.TYPE_DOCUMENT
        else -> LockerCopy.TYPE_NOTE
    }

    /** The plural a filter chip says ("Logins"). */
    public fun typePlural(type: String): String = when (type) {
        "login" -> LockerCopy.TYPES_LOGIN
        "card" -> LockerCopy.TYPES_CARD
        "note" -> LockerCopy.TYPES_NOTE
        "identity" -> LockerCopy.TYPES_IDENTITY
        "wifi" -> LockerCopy.TYPES_WIFI
        "password" -> LockerCopy.TYPES_PASSWORD
        else -> typeLabel(type)
    }

    /** The chip's two letters, from the type's own word ("Login" → "LO", "Wi-Fi" → "WI"). */
    public fun typeChip(type: String): String =
        typeLabel(type).filter { it.isLetter() }.take(2).uppercase()

    /** A `design/native-catalog.json` icon key for the type. */
    public fun typeIcon(type: String): String = when (type) {
        "login", "password" -> "Key"
        "card", "bank_account" -> "Coin"
        "note", "document", "software_licence" -> "FileText"
        "identity", "passport", "driving_licence", "membership" -> "User"
        "wifi" -> "Wifi"
        else -> "Lock"
    }

    /** One list row, secret-free, with its chips and its spoken label. */
    public fun row(item: LockerItemRow): LockerRow {
        val chips = buildList {
            if (item.compromised) add(StatusChip(label = LockerCopy.CHIP_COMPROMISED, tone = StatusChip.Tone.TONE_NET))
            if (item.archived) add(StatusChip(label = LockerCopy.CHIP_ARCHIVED, tone = StatusChip.Tone.TONE_SEAM))
        }
        // ONLY A LOGIN, AN IDENTITY AND A WI-FI HAVE A SUBTITLE OF THEIR OWN;
        // the core fills every other type's with a type word ("Secure note",
        // "Card"), which beside the type read it twice (the #1047 walk).
        val subtitle = if (item.type in SUBTITLED) item.subtitle.takeIf { it != "—" } ?: "" else ""
        val meta = listOf(typeLabel(item.type), subtitle, item.tags.joinToString(", "))
            .filter { it.isNotEmpty() }
            .joinToString(" · ")
        val spoken = listOfNotNull(
            item.title,
            meta,
            LockerCopy.STARRED.takeIf { item.starred },
            chips.joinToString(", ") { it.label }.ifEmpty { null },
        ).joinToString(", ")
        return LockerRow(
            item_id = item.item_id,
            title = item.title,
            meta = meta,
            type_chip = typeChip(item.type),
            type_key = typeIcon(item.type),
            starred = item.starred,
            chips = chips,
            accessibility_label = spoken,
        )
    }

    /** `{n}` filled into a template. */
    public fun fill(template: String, vararg values: Pair<String, String>): String =
        values.fold(template) { text, (key, value) -> text.replace("{$key}", value) }

    /** "1 item" / "12 items". */
    public fun items(count: Int): String =
        fill(if (count == 1) LockerCopy.COUNT_ONE else LockerCopy.COUNT_MANY, "n" to count.toString())
}
