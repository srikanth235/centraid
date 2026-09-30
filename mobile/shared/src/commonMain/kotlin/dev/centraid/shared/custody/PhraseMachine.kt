package dev.centraid.shared.custody

import dev.centraid.shared.platform.SyncedSecrets

/**
 * THE CHECK A MEMBER PASSES AFTER THE WORDS ARE SHOWN (#1029 §0, §5, W5B-3;
 * #1047 E1).
 *
 * The rules the make-vault screen ([VaultWordsMachine]) applies, in one place.
 * Its words are in `WordsCopy` (`copy/words.json`); none are here.
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
 * ## WHERE THE PHRASE IS
 *
 * The core mints it (`phone.proto`'s `PhraseRequest`) and it crosses into this
 * process to be SHOWN — a view cannot draw words it was not given. The
 * make-vault machine holds it, redacted from every `toString`, from the mint
 * until the core has turned it into the seed the synchronised store keeps, and
 * then drops it; it is never written anywhere by this shell.
 */
public object PhraseMachine {
    /** How many positions a setup check asks. See the header. */
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

    /**
     * Whether [typed] is the word at 1-based [position] of [phrase].
     *
     * Whitespace and case are forgiven, because they are not the thing being
     * checked: a member who wrote "Abandon" on paper has the phrase. An empty
     * answer is never right.
     */
    public fun matches(phrase: List<String>, position: Int, typed: String): Boolean {
        val normalised = typed.trim().lowercase()
        return normalised.isNotEmpty() && phrase.getOrNull(position - 1) == normalised
    }

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
