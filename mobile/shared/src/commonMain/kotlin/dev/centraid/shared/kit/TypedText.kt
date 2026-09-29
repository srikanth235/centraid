package dev.centraid.shared.kit

/**
 * A TEXT FIELD'S TYPING AGAINST THE MACHINE'S ECHOES.
 *
 * The member's text lives in the view (the only place a keystroke exists
 * before the machine hears it) and each change goes over as the screen's edit
 * event. The machine's value comes back later — an echo of an earlier
 * keystroke, a save that landed with an older draft, or a value the member
 * never typed (a load, a splice, a clear after submit). Only the last kind may
 * replace what is typed; an echo taken back drops every keystroke since
 * ("Body of the alk note", the #1047 walk). One per field, remembered with it.
 */
public class TypedText(initial: String) {
    /** Sent and not yet heard back, oldest first. */
    private val inFlight = ArrayDeque<String>()

    /** The value the machine last said that the field had typed or adopted. */
    private var heard = initial

    /** What the machine was last told, or last adopted from it. */
    private var last = initial

    /** The member typed [next]: `true` when it is to be sent as the edit. */
    public fun edited(next: String): Boolean {
        if (next == last) return false
        last = next
        inFlight.addLast(next)
        return true
    }

    /**
     * The machine now says [value] while the field shows [shown]: the text the
     * field adopts, or `null` to keep what it shows. [open] is the screen's own
     * "this came from the vault" gate (an autosave editor's reload while
     * CLEAN); a field with no such signal leaves it open.
     */
    public fun answer(value: String, shown: String, open: Boolean = true): String? {
        // AN ECHO. The machine answers in order, so the newest keystroke heard
        // means every one before it was heard too (the states between may
        // have been conflated away).
        if (value == last) {
            inFlight.clear()
            heard = value
            return null
        }
        val at = inFlight.indexOf(value)
        if (at >= 0) {
            repeat(at + 1) { inFlight.removeFirst() }
            heard = value
            return null
        }
        if (value == shown || !open) return null
        // A SAVE THAT LANDED BEFORE THE NEWEST KEYSTROKES WERE HEARD: its
        // value is the last one heard, and the keystrokes since are on their way.
        if (inFlight.isNotEmpty() && value == heard) return null
        inFlight.clear()
        heard = value
        last = value
        return value
    }
}
