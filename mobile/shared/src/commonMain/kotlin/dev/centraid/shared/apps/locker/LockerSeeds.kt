package dev.centraid.shared.apps.locker

import dev.centraid.design.copy.LockerCopy

/**
 * WHAT A MEMBER PASTES AS A ONE-TIME-CODE SEED, CHECKED BEFORE SAVE (#1047,
 * Q-1047-16) — so the editor can say why in the member's words.
 *
 * **The core is the authority.** `crates/apps/locker::totp::seed_of` reads the
 * entry again when `locker.add_item`/`edit_item` reach `seal_command`, stores
 * it as upper-case base32, and refuses anything this accepts that it does not.
 * This is the same rule — a bare base32 key (spaces, `=` padding and `-`
 * grouping ignored, case folded) or an `otpauth://totp/…?secret=…` link whose
 * `algorithm`, `digits` and `period` are RFC 6238's defaults when present — so
 * a refusal is said on the field rather than as a generic write failure. It
 * never normalises and never keeps the value.
 */
public object LockerSeeds {
    private const val ALPHABET: String = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

    /** The member's sentence for why [entry] cannot make codes, or null when it can. */
    public fun refusal(entry: String): String? {
        val trimmed = entry.trim()
        val secret = if (trimmed.startsWith("otpauth://", ignoreCase = true)) {
            when (val read = secretOfLink(trimmed.substring("otpauth://".length))) {
                is Read.Refused -> return read.sentence
                is Read.Secret -> read.value
            }
        } else {
            trimmed
        }
        return if (isBase32(secret)) null else LockerCopy.OTP_NOT_A_SEED
    }

    private sealed interface Read {
        class Secret(val value: String) : Read

        class Refused(val sentence: String) : Read
    }

    private fun secretOfLink(rest: String): Read {
        val slash = rest.indexOf('/')
        if (slash < 0) return Read.Refused(LockerCopy.OTP_NOT_A_SEED)
        val kind = rest.substring(0, slash)
        if (kind.equals("hotp", ignoreCase = true)) return Read.Refused(LockerCopy.OTP_COUNTER_BASED)
        if (!kind.equals("totp", ignoreCase = true)) return Read.Refused(LockerCopy.OTP_NOT_A_SEED)
        val query = rest.substringAfter('?', "")
        var secret: String? = null
        for (pair in query.split('&')) {
            val key = pair.substringBefore('=').lowercase()
            val value = decoded(pair.substringAfter('=', "")) ?: return Read.Refused(LockerCopy.OTP_NOT_A_SEED)
            when {
                key == "secret" -> secret = value
                key == "algorithm" && !value.equals("SHA1", ignoreCase = true) -> return Read.Refused(LockerCopy.OTP_UNSUPPORTED)
                key == "digits" && value != "6" -> return Read.Refused(LockerCopy.OTP_UNSUPPORTED)
                key == "period" && value != "30" -> return Read.Refused(LockerCopy.OTP_UNSUPPORTED)
            }
        }
        return secret?.takeIf { it.isNotEmpty() }?.let { Read.Secret(it) } ?: Read.Refused(LockerCopy.OTP_NOT_A_SEED)
    }

    private fun decoded(value: String): String? {
        val out = StringBuilder()
        var at = 0
        while (at < value.length) {
            val character = value[at]
            if (character == '%') {
                if (at + 3 > value.length) return null
                val code = value.substring(at + 1, at + 3).toIntOrNull(16) ?: return null
                out.append(code.toChar())
                at += 3
            } else {
                out.append(character)
                at += 1
            }
        }
        return out.toString()
    }

    /** At least one whole byte of base32, and nothing else but the ignored separators. */
    private fun isBase32(secret: String): Boolean {
        val letters = secret.filterNot { it.isWhitespace() || it == '=' || it == '-' }.uppercase()
        return letters.length * 5 >= 8 && letters.all { it in ALPHABET }
    }
}
