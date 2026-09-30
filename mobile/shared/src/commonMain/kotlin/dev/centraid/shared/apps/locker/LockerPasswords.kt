package dev.centraid.shared.apps.locker

import kotlin.math.ln
import kotlin.math.roundToInt

/**
 * THE GENERATOR'S ARITHMETIC (#1047), pure over bytes a platform CSPRNG drew.
 *
 * `commonMain` has no CSPRNG (`platform/SecureRandom`'s header): the bridge
 * attaches fresh bytes to each event and this maps them to characters by
 * REJECTION SAMPLING — a byte at or above the largest multiple of the
 * alphabet's size is discarded — so no character is likelier than another.
 * `kotlin.random` is never involved.
 *
 * Look-alikes (0 O o 1 l I | ` ' ") are never in an alphabet: a password a
 * member may one day read aloud or type from paper must not hinge on a glyph.
 */
public object LockerPasswords {
    public const val MIN_LENGTH: Int = 8
    public const val MAX_LENGTH: Int = 40
    public const val DEFAULT_LENGTH: Int = 20
    public const val PIN_MIN: Int = 4
    public const val PIN_MAX: Int = 12
    public const val PIN_DEFAULT: Int = 6

    private const val LETTERS: String = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"
    private const val DIGITS: String = "23456789"
    private const val SYMBOLS: String = "!#$%&*+-=?@^_~"
    private const val PIN_DIGITS: String = "0123456789"

    /** The alphabet for these options. */
    public fun alphabet(pin: Boolean, digits: Boolean, symbols: Boolean): String = when {
        pin -> PIN_DIGITS
        else -> LETTERS + (if (digits) DIGITS else "") + (if (symbols) SYMBOLS else "")
    }

    /**
     * [length] characters from [alphabet], or null when [entropy] ran out
     * first — the caller asks again rather than padding with something
     * predictable.
     */
    public fun generate(entropy: ByteArray, alphabet: String, length: Int): String? {
        val size = alphabet.length
        val ceiling = 256 - (256 % size)
        val out = StringBuilder(length)
        for (byte in entropy) {
            if (out.length == length) break
            val value = byte.toInt() and 0xff
            if (value < ceiling) out.append(alphabet[value % size])
        }
        return if (out.length == length) out.toString() else null
    }

    /** Bits of strength of a random string of [length] over [alphabet]. */
    public fun bits(alphabetSize: Int, length: Int): Int =
        if (alphabetSize < 2) 0 else (length * ln(alphabetSize.toDouble()) / ln(2.0)).roundToInt()

    /**
     * A TYPED password's rough strength — the same shape as `watchtower`'s
     * `strength_score` (length and character classes), never a claim about a
     * breach.
     */
    public fun typedBits(password: String): Int {
        if (password.isEmpty()) return 0
        var pool = 0
        if (password.any { it.isLowerCase() }) pool += 26
        if (password.any { it.isUpperCase() }) pool += 26
        if (password.any { it.isDigit() }) pool += 10
        if (password.any { !it.isLetterOrDigit() }) pool += 20
        return bits(pool, password.length)
    }
}
