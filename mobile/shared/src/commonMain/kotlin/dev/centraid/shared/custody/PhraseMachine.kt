package dev.centraid.shared.custody

import dev.centraid.shared.platform.SyncedSecrets

/**
 * THE RULES OF THE WORDS SCREEN (#1029 §0, §5, W5B-3; #1047 E1).
 *
 * The rules the make-vault screen ([VaultWordsMachine]) applies, in one place.
 * Its words are in `WordsCopy` (`copy/words.json`); none are here.
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
    /** How many words a phrase has. */
    public const val WORDS: Int = 24

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
