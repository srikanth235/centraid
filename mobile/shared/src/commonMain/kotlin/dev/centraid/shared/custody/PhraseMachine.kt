package dev.centraid.shared.custody

import dev.centraid.shared.platform.SyncedSecrets

/**
 * THE 24 WORDS, SHOWN ONCE AND RE-CHECKABLE FOREVER (#1029 §0, §5, W5B-3).
 *
 * Two screens and one machine, because they are one promise seen twice:
 *
 * * **setup** — the phrase is shown once, the member is asked to confirm three
 *   of it, and only then does the shell move on;
 * * **settings** — the same phrase, shown again on demand behind the device's
 *   own authentication, so a member who wrote it down badly can fix it.
 *
 * ## WHY THE CHECK IS THREE WORDS AND NOT TWENTY-FOUR
 *
 * A confirmation screen exists to catch "I did not write it down", not to catch
 * a typo. Twenty-four boxes is a wall a member taps through by copying from the
 * screen above, which proves nothing and trains them to treat the phrase as
 * ceremony. Three positions, asked by index, cannot be answered by somebody who
 * did not write the phrase somewhere — and a member who has it written down
 * answers in seconds.
 *
 * The positions are drawn from the platform's CSPRNG
 * (`dev.centraid.shared.platform.SecureRandom`) and are an ARGUMENT here, for
 * `commonMain`'s standing reason: `kotlin.random.Random` is a clock-seeded
 * shuffler, and a confirmation whose positions were predictable is one a
 * malicious build could pre-answer.
 *
 * ## THIS MACHINE NEVER HOLDS THE PHRASE
 *
 * It holds the WORDS THE MEMBER TYPED and the positions being asked, and it
 * compares against an answer function the caller supplies. The phrase itself
 * stays where it was derived — in Rust, behind the ABI — so a screen state
 * captured in a crash report or a screenshot of a state dump does not carry it.
 */
public class PhraseMachine(
    /** The positions being asked, 1-based, in the order they are asked. */
    public val asking: List<Int>,
    /**
     * Whether the word at a 1-based position is what was typed. The caller
     * holds the phrase; this machine does not.
     */
    private val matches: (position: Int, typed: String) -> Boolean,
) {
    private val answered = mutableMapOf<Int, Boolean>()

    /** How many of [asking] have been answered correctly. */
    public val correct: Int get() = answered.count { it.value }

    /** Whether every asked position is answered correctly. */
    public val confirmed: Boolean get() = asking.isNotEmpty() && asking.all { answered[it] == true }

    /**
     * Answer one position.
     *
     * Whitespace and case are forgiven, because they are not the thing being
     * checked: a member who wrote "Abandon" on paper has the phrase. A wrong
     * word is not forgiven and does not advance.
     */
    public fun answer(position: Int, typed: String): Boolean {
        val normalised = typed.trim().lowercase()
        val ok = normalised.isNotEmpty() && matches(position, normalised)
        answered[position] = ok
        return ok
    }

    /** Whether this position has been answered, and how. */
    public fun verdict(position: Int): Boolean? = answered[position]

    /** Start the check again — what "try again" does. */
    public fun reset() {
        answered.clear()
    }

    public companion object {
        /** How many positions a setup check asks. See the class comment. */
        public const val POSITIONS_ASKED: Int = 3

        /** How many words a phrase has. */
        public const val WORDS: Int = 24

        /**
         * Pick the positions to ask, from platform entropy.
         *
         * [draw] is handed a bound and answers a value below it — the shape
         * `SecureRandom` can satisfy without this file knowing how. Distinct,
         * sorted, 1-based.
         */
        public fun positions(draw: (bound: Int) -> Int): List<Int> {
            val picked = linkedSetOf<Int>()
            var guard = 0
            while (picked.size < POSITIONS_ASKED && guard < WORDS * 8) {
                picked.add(draw(WORDS) + 1)
                guard += 1
            }
            // A DRAW THAT WILL NOT YIELD ENOUGH IS FILLED IN ORDER rather than
            // looped over forever: a setup screen that hung because entropy was
            // being uncooperative would be worse than one that asks positions 1,
            // 2 and 3. The guard is what makes this reachable at all.
            var next = 1
            while (picked.size < POSITIONS_ASKED) {
                picked.add(next)
                next += 1
            }
            return picked.sorted()
        }

        /** The heading the setup screen draws. */
        public const val SETUP_TITLE: String = "Your 24 words"

        /**
         * What the setup screen says under the heading.
         *
         * It says what the words ARE FOR and what losing them costs, in that
         * order, because a member skips a screen that opens with an
         * instruction.
         */
        public const val SETUP_BODY: String =
            "These 24 words are your vaults. Anyone who has them has everything in Centraid, " +
                "and nobody can give them back to you — not us, not your gateway. " +
                "Write them down on paper and keep them somewhere safe."

        /** The heading the confirmation step draws. */
        public const val CHECK_TITLE: String = "Check your words"

        /** What the confirmation step asks. */
        public fun checkBody(asking: List<Int>): String =
            "Type word ${asking.joinToString(", ")} from what you wrote down."

        /** The prompt for one position. */
        public fun prompt(position: Int): String = "Word $position"

        /** What a wrong word says. Never "invalid". */
        public const val WRONG_WORD: String = "That is not the word at this position. Check again."

        /** The heading in settings. */
        public const val SETTINGS_TITLE: String = "Show my 24 words"

        /** What settings says before showing them. */
        public const val SETTINGS_BODY: String =
            "Centraid will show your 24 words after you unlock this phone. " +
                "Do not photograph them and do not put them in a password manager " +
                "you would lose with this phone."

        /**
         * The custody sentence for a platform, which is the one place the two
         * platforms differ and must be seen to.
         *
         * It takes the platform's own answer rather than a build flag, because
         * a member with iCloud Keychain switched off is on iOS and is in
         * Android's situation.
         */
        public fun custodySentence(availability: SyncedSecrets.Availability): String =
            availability.sentence
    }
}
