package dev.centraid.shared.shell

/**
 * The mount (#1020, D-1020-E4; #1025 S5, D-1025-S5-2;
 * `docs/mobile-offline.md:9-13`, `:249-251`).
 *
 * **One replica file per vault, exactly one open — the active vault's.** The
 * mount is keyed on the VAULT, so **switching vaults IS the remount**: nothing
 * is evicted, nothing is capped, and only revocation deletes bytes.
 *
 * A navigation model that treated the vault as a FILTER rather than a mount
 * would reintroduce the mount plane #996 deleted, including the question "which
 * vault is this row from" — which one open file cannot answer twice. So the
 * vault is not a navigation parameter anywhere in [dev.centraid.shared.nav];
 * it is this.
 *
 * ## Why there is no gateway in the key
 *
 * This was `MountKey(gatewayId, vaultId)`, and the file it named was
 * `"$gatewayId.$vaultId.replica.db"`. [D-1025-S1-1] deleted that pairing from
 * the core: a gateway id is an ADDRESS a vault is reachable at and never a name
 * a copy is filed under, `sha256(gateway_id ‖ vault_id)` is gone, and
 * `Role::Seat` no longer carries a gateway at all. A shell that kept naming its
 * replica after the gateway would be the last place in the product where one
 * vault reached through two addresses is two files — which is two copies of one
 * authority's rows, each with its own cursor and its own outbox.
 *
 * The census §E seam 2 defect the old key was built against — the literal
 * `"manual"` standing in for an unresolved gateway id, naming a file whose path
 * moved the moment a real endpoint arrived — cannot be written at all now,
 * because there is no gateway half to stand in for. What replaces the guard is
 * the fact that a vault id is not a thing a device can invent: it arrives in the
 * pairing response (`PairOk.vault_id`) or it does not arrive, and until it does
 * the mount is [Mount.Waiting], which names no file.
 */
public sealed interface Mount {
    /**
     * WAITING, and naming no file.
     *
     * This state carries no key at all, which is what makes "a mount never
     * names a file it does not have an id for" a fact about the type rather
     * than a rule somebody enforces.
     *
     * The next reachability wake retries. This is a screen a member can read,
     * not a spinner with no end.
     */
    public data class Waiting(val because: Reason) : Mount {
        public enum class Reason {
            /** Not paired to any gateway yet, so there is no vault id. */
            NOT_PAIRED,

            /**
             * Paired, and the first copy has not landed.
             *
             * Was `RESOLVING_ENDPOINT`, which described the old key's missing
             * half. A paired seat HAS its vault id; what it may not have yet is
             * the blob — `crates/seat-link`'s `bootstrap`, which is the
             * "bootstrapping" step of S1's lifecycle.
             */
            BOOTSTRAPPING,

            /** The app is locked; decrypted material is cleared. */
            LOCKED,
        }
    }

    public data class Mounted(val key: MountKey) : Mount

    /**
     * Revoked. **The one state that deletes bytes** — and it deletes them
     * because revocation is the only thing that may: a cache that freed
     * canonical rows to make room would be the regression the copy and the
     * device contract test pin.
     */
    public data class Revoked(val key: MountKey) : Mount
}

/**
 * The vault a replica file is named after.
 *
 * A wrapper around one string rather than the string itself, because the file
 * name is derived here and in one place; a `String` parameter would be a file
 * name every caller spells for itself.
 */
public data class MountKey(val vaultId: String) {
    init {
        require(vaultId.isNotBlank()) { "a mount needs a vault id" }
        require(vaultId != PLACEHOLDER) {
            "\"$PLACEHOLDER\" is the literal that orphaned every queued write in v0; " +
                "it is refused by construction here (docs/mobile-offline.md:249-251)"
        }
    }

    /**
     * The replica file's name. One file per vault, and the vault is IN the name
     * so two vaults can never resolve to one path.
     *
     * **THE SPELLING IS `centraid_seat::identity`'s**, verbatim:
     * `centraid-replica-<vaultId>.sqlite3`. A shell that named the same thing
     * differently would be a second spelling of one name — the defect this whole
     * file is about, one level up — and a member moving a vault between a
     * desktop seat and a phone would find two files that are the same file.
     */
    public val fileName: String get() = "$PREFIX$vaultId$SUFFIX"

    public companion object {
        /** The exact string v0 used, kept here so it can be refused by name. */
        public const val PLACEHOLDER: String = "manual"

        /** `centraid_seat::identity::database_name`'s two halves. */
        public const val PREFIX: String = "centraid-replica-"
        public const val SUFFIX: String = ".sqlite3"
    }
}

/**
 * Switching vaults is a remount, expressed as a function that cannot do
 * anything else.
 *
 * It takes a mount and a new key and returns a mount; there is no "switch the
 * active vault id" that leaves the file open, because that is the API shape a
 * filter would have.
 */
public fun remount(current: Mount, to: MountKey): Mount =
    if (current is Mount.Mounted && current.key == to) current else Mount.Mounted(to)
