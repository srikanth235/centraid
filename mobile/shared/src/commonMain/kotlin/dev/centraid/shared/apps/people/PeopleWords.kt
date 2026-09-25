package dev.centraid.shared.apps.people

import centraid.screen.v1.PeopleAvatar
import centraid.screen.v1.PeopleChannelIntent
import dev.centraid.design.copy.PeopleCopy
import dev.centraid.shared.design.PartyHueWheel
import dev.centraid.shared.kit.time.CivilWords

/**
 * PEOPLE'S WORDS, COMPOSED ONCE (#1029 app port).
 *
 * Every sentence a People view draws is built here from [PeopleCopy]'s
 * strings, so the four machines and the folds say one thing one way. Pure, and
 * no clock: every day is the core's (`today`, `in_days`, `days_since_contact`).
 */
public object PeopleWords {
    /** Fill `{key}` holes in a copy string. A hole with no value stays as written. */
    public fun fill(template: String, vararg values: Pair<String, Any>): String =
        values.fold(template) { text, (key, value) -> text.replace("{$key}", value.toString()) }

    /**
     * A person's initials: one letter for one word, first and last for more
     * (`HomeReads`' rule, v0's). "?" for a name that is only spaces.
     */
    public fun initials(name: String): String {
        val words = name.trim().split(" ").filter { it.isNotEmpty() }
        return when (words.size) {
            0 -> "?"
            1 -> words[0].take(1).uppercase()
            else -> (words.first().take(1) + words.last().take(1)).uppercase()
        }
    }

    /**
     * THE AVATAR'S HUE IS A KEY, NEVER THE STORED TEXT. v0 printed a stored
     * `var(--c-rose)` into the merge screen as words (audit defect); a stored
     * value the wheel cannot name falls back to the id's own hue.
     *
     * EVERY HUE PEOPLE EMITS IS THE THEME'S COLOUR ROLE (`cRose`), the name a
     * view looks a colour up by — so no view keeps a table from the wheel's
     * word (`rose`) to the role, and an unknown key cannot reach one.
     */
    public fun avatar(partyId: String, name: String, avatarColor: String?): PeopleAvatar = PeopleAvatar(
        initials = initials(name),
        hue_key = hueKey(partyId, avatarColor),
    )

    public fun hueKey(partyId: String, avatarColor: String?): String =
        role(PartyHueWheel.partyHueKey(partyId, avatarColor) ?: PartyHueWheel.identityHueKey(partyId))

    /** A wheel key as the theme's colour role: `rose` → `cRose`. */
    public fun role(wheelKey: String): String =
        if (wheelKey.isEmpty()) "" else "c" + wheelKey.replaceFirstChar { it.uppercaseChar() }

    /** The wheel key inside a colour role: `cRose` → `rose`; empty for anything else. */
    public fun wheelKey(role: String): String {
        val key = role.removePrefix("c").replaceFirstChar { it.lowercaseChar() }
        return if (role.startsWith("c") && key in PartyHueWheel.HUE_KEYS) key else ""
    }

    /** The stored form of a colour role: `var(--c-<wheel key>)`. */
    public fun storedHue(hueRole: String): String = "var(--c-${wheelKey(hueRole)})"

    /** The colour role of a stored `var(--c-<key>)`, or empty for anything else. */
    public fun hueKeyOf(stored: String?): String {
        val value = (stored ?: "").trim()
        if (!value.startsWith("var(--c-") || !value.endsWith(")")) return ""
        val key = value.substring("var(--c-".length, value.length - 1)
        return if (key in PartyHueWheel.HUE_KEYS) role(key) else ""
    }

    /** "Last touch 12 days ago" / "No touch logged yet". */
    public fun lastTouch(everContacted: Boolean, daysSince: Long): String = when {
        !everContacted -> PeopleCopy.META_NEVER
        daysSince <= 0 -> PeopleCopy.META_TODAY
        daysSince == 1L -> PeopleCopy.META_YESTERDAY
        else -> fill(PeopleCopy.META_DAYS, "n" to daysSince)
    }

    /** "Every 14 days" / "No cadence". 0 is no cadence. */
    public fun cadence(days: Long): String =
        if (days <= 0) PeopleCopy.CADENCE_NONE else fill(PeopleCopy.CADENCE_EVERY, "n" to days)

    /** "1 day over" / "3 days over". */
    public fun daysOver(days: Long): String =
        if (days == 1L) PeopleCopy.DAYS_OVER_ONE else fill(PeopleCopy.DAYS_OVER, "n" to days)

    /** "Today" / "Tomorrow" / "In 12 days", from the core's `in_days`. */
    public fun inDays(days: Long): String = when {
        days <= 0 -> dev.centraid.design.copy.SharedCopy.TODAY
        days == 1L -> dev.centraid.design.copy.SharedCopy.TOMORROW
        else -> fill(PeopleCopy.IN_DAYS, "n" to days)
    }

    /** "14 August" from `MM-DD`, or the input when it is not one. */
    public fun monthDay(monthDay: String): String {
        val parts = monthDay.split("-")
        if (parts.size != 2) return monthDay
        val month = parts[0].toIntOrNull() ?: return monthDay
        val day = parts[1].toIntOrNull() ?: return monthDay
        val name = CivilWords.monthName(month).ifEmpty { return monthDay }
        return "$day $name"
    }

    /**
     * IS THIS A REAL `MM-DD`? The command only checks the pattern, so v0 took
     * `13-45` (audit defect). 29 February is a real annual date.
     */
    public fun validMonthDay(text: String): Boolean {
        if (!Regex("""^\d{2}-\d{2}$""").matches(text)) return false
        val month = text.substring(0, 2).toInt()
        val day = text.substring(3, 5).toInt()
        val longest = when (month) {
            2 -> 29
            4, 6, 9, 11 -> 30
            in 1..12 -> 31
            else -> return false
        }
        return day in 1..longest
    }

    /**
     * A logged instant's day in words, from the civil day the core read it on
     * in the request's zone (`occurred_local_day`, `created_local_day`) against
     * the core's `today`. Empty when the core answered no day.
     */
    public fun whenLogged(localDay: String, today: String): String {
        if (localDay.length < DAY) return ""
        val day = localDay.take(DAY)
        return if (today.isEmpty()) CivilWords.dayMonth(day) else CivilWords.relativeDay(day, today)
    }

    /**
     * BOTH SPELLINGS OF A TOUCH KIND land on one noun (v0's table): the word
     * this phone writes and the notation another writer stored. An unknown
     * value is shown as itself — a value the vault holds is a fact.
     */
    public fun touchKind(kind: String): String = when (kind.trim().lowercase()) {
        "message" -> PeopleCopy.KIND_MESSAGE
        "call" -> PeopleCopy.KIND_CALL
        "visit", "met up", "met-up", "met_up" -> PeopleCopy.KIND_MET_UP
        "note" -> PeopleCopy.KIND_NOTE
        "", "touch", "interaction" -> PeopleCopy.KIND_TOUCH
        else -> kind.replaceFirstChar { it.uppercase() }
    }

    public fun channelKind(kind: String): String = when (kind) {
        "phone" -> PeopleCopy.CHANNEL_PHONE
        "email" -> PeopleCopy.CHANNEL_EMAIL
        "address" -> PeopleCopy.CHANNEL_ADDRESS
        "handle" -> PeopleCopy.CHANNEL_HANDLE
        else -> kind.replaceFirstChar { it.uppercase() }
    }

    public fun channelIntent(kind: String): PeopleChannelIntent = when (kind) {
        "phone" -> PeopleChannelIntent.PEOPLE_CHANNEL_INTENT_CALL
        "email" -> PeopleChannelIntent.PEOPLE_CHANNEL_INTENT_MAIL
        "address" -> PeopleChannelIntent.PEOPLE_CHANNEL_INTENT_MAP
        else -> PeopleChannelIntent.PEOPLE_CHANNEL_INTENT_COPY
    }

    public fun channelAction(intent: PeopleChannelIntent): String = when (intent) {
        PeopleChannelIntent.PEOPLE_CHANNEL_INTENT_CALL -> PeopleCopy.ACTION_CALL
        PeopleChannelIntent.PEOPLE_CHANNEL_INTENT_MAIL -> PeopleCopy.ACTION_MAIL
        PeopleChannelIntent.PEOPLE_CHANNEL_INTENT_MAP -> PeopleCopy.ACTION_MAP
        else -> PeopleCopy.ACTION_COPY
    }

    /** The touch kinds the Log sheet offers, as the vault stores them. */
    public val LOG_KINDS: List<Pair<String, String>> = listOf(
        "message" to PeopleCopy.KIND_MESSAGE,
        "call" to PeopleCopy.KIND_CALL,
        "met up" to PeopleCopy.KIND_MET_UP,
        "note" to PeopleCopy.KIND_NOTE,
    )

    /** The channel kinds `save_contact_channel` accepts. */
    public val CHANNEL_KINDS: List<Pair<String, String>> = listOf(
        "phone" to PeopleCopy.CHANNEL_PHONE,
        "email" to PeopleCopy.CHANNEL_EMAIL,
        "address" to PeopleCopy.CHANNEL_ADDRESS,
        "handle" to PeopleCopy.CHANNEL_HANDLE,
    )

    /** `Never` is the zero: zero is never overdue. v0's chips. */
    public val CADENCES: List<Long> = listOf(0, 7, 14, 30, 90)

    private const val DAY: Int = 10
}
