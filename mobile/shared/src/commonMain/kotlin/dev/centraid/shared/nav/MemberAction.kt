package dev.centraid.shared.nav

/**
 * A SECRET ACTION THE ASSISTANT OFFERS AND THE MEMBER COMPLETES (#1135).
 *
 * The assistant never holds a sealed value, so a reveal, a code or a secret to type is offered as
 * a card: an ordinary chat card for a Locker item whose `qualifier` is `<action>:<column>`,
 *
 * | action | column | the tap opens |
 * | --- | --- | --- |
 * | `reveal` | `password`, `card_number`, `cvv`, `content` | the item, and reveals that field (Locker's gate and receipt) |
 * | `code` | `otp_seed` | the item, and shows its one-time code (never the seed) |
 * | `edit_secret` | any sealed column | Locker's editor on the item |
 * | `export` | empty | Locker's export (the card's item id may be empty) |
 *
 * It is parsed once, here, at the card edge. A qualifier of any other shape is no action: the
 * card is the plain "open the item" card, never a crash. The value a tap reveals is Locker's and
 * never rides the chat.
 */
public data class MemberAction(
    public val kind: Kind,
    public val itemId: String,
    public val column: String,
) {
    public enum class Kind(public val word: String) {
        Reveal("reveal"),
        Code("code"),
        EditSecret("edit_secret"),
        Export("export"),
    }

    /** The qualifier this action is spelled as on a card. */
    public val qualifier: String get() = "${kind.word}:$column"

    public companion object {
        /** The action a Locker item card carries, or null for a card that is only a reference. */
        public fun parse(app: String, entity: String, id: String, qualifier: String): MemberAction? {
            if (app != AppIds.LOCKER || entity != "locker_item") return null
            val (word, column) = qualifier.split(':', limit = 2).let { it[0] to it.getOrElse(1) { "" } }
            val kind = Kind.entries.firstOrNull { it.word == word } ?: return null
            if (kind != Kind.Export && (id.isEmpty() || column.isEmpty())) return null
            return MemberAction(kind, id, column)
        }
    }
}
