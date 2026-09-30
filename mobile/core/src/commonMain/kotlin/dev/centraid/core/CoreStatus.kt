package dev.centraid.core

/**
 * The ABI's status codes, from `crates/core-ffi/include/centraid.h`.
 *
 * Written out rather than read from the header: cinterop does hand these over
 * as constants on iOS, but JNA does not hand over anything from a header at
 * all, and two spellings of the same five numbers on two platforms is worse
 * than one spelling in `commonMain`. [CoreStatusCodesMatchTheHeaderSpec] in
 * `jvmTest` reads the committed header and asserts every value, so the copy is
 * checked rather than trusted.
 *
 * `TIMEOUT` is **not an error** (`CONTRACT.md` clause 6). It is negative only
 * because every non-`OK` code is, and a caller that treats it as a failure
 * restarts the core once a second.
 */
public enum class CoreStatus(public val code: Int) {
    OK(0),
    BAD_ARGUMENT(-1),
    MALFORMED(-2),
    CLOSED(-3),
    PANICKED(-4),
    TIMEOUT(-5),
    ;

    public companion object {
        /**
         * A code the header does not define is [UNKNOWN_STATUS]-shaped: it is
         * returned as `null` and the binding turns it into
         * [CoreFailure.UnknownStatus] naming the number, rather than mapping it
         * onto the nearest known code. A core one version ahead of a shell that
         * invented a sixth code must not have it read as `CLOSED`.
         */
        public fun of(code: Int): CoreStatus? = entries.firstOrNull { it.code == code }

        public const val UNKNOWN_STATUS: String = "an ABI status this build does not define"
    }
}
