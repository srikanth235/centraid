package dev.centraid.shared.custody

/**
 * A SEED HANDED TO A DEBUG BUILD AT LAUNCH, FOR THE DEMO VAULT (#1047 W2).
 *
 * `seed-demo-vault` seals the demo Locker under the public BIP-39 all-`abandon`
 * words at index 0 and prints the seed as `CENTRAID_DEMO_SEED`;
 * `mobile/scripts/demo-vault.sh` passes it to the app at launch (a
 * `SIMCTL_CHILD_` environment variable on iOS, an intent extra on Android).
 * [Shelf.load][dev.centraid.shared.shell.Shelf.load] stores it where a real
 * seed lives and records [index] for every held vault that has none, so the
 * demo opens keyed through the ordinary path.
 *
 * **Only a debug build ever constructs one.** The iOS read sits under
 * `#if DEBUG` and the Android read behind `FLAG_DEBUGGABLE`; this class holds
 * no words and no seed of its own, so a release binary carries nothing of the
 * demo's. Not a `data class`: a generated `toString` would print the seed.
 */
public class DevSeed(
    /** 128 lowercase hex characters, as `VaultSecrets.rememberSeed` takes. */
    public val seedHex: String,
    /** The index the demo seeder sealed at. */
    public val index: Int = DEMO_INDEX,
) {
    override fun toString(): String = "DevSeed(<redacted>, index=$index)"

    public companion object {
        /** `seed-demo-vault` opens its core `with_seed(demo_seed(), 0)`. */
        public const val DEMO_INDEX: Int = 0

        /** A launch value that is not a seed is no seed: a debug hook never crashes a launch. */
        public fun parse(seedHex: String?): DevSeed? =
            seedHex?.trim()?.lowercase()
                ?.takeIf { it.length == VaultSecrets.SEED_HEX_LENGTH && it.all { c -> c in "0123456789abcdef" } }
                ?.let { DevSeed(it) }
    }
}
