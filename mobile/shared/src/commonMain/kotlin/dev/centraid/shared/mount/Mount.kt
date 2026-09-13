package dev.centraid.shared.mount

/**
 * The mount (#1020, D-1020-E4; `docs/mobile-offline.md:9-13`, `:249-251`).
 *
 * **One replica file per vault, exactly one open — the active vault's.** The
 * mount is keyed on `(gateway, vault)`, so **switching vaults IS the remount**:
 * nothing is evicted, nothing is capped, and only revocation deletes bytes.
 *
 * A navigation model that treated the vault as a FILTER rather than a mount
 * would reintroduce the mount plane #996 deleted, including the question "which
 * vault is this row from" — which one open file cannot answer twice. So the
 * vault is not a navigation parameter anywhere in [dev.centraid.shared.nav];
 * it is this.
 */
public sealed interface Mount {
    /**
     * WAITING FOR A GATEWAY ID, and naming no file.
     *
     * **There is no stand-in for a gateway id** (census §E seam 2). The literal
     * `"manual"` once filled this gap and named a file whose path moved the
     * moment a real endpoint arrived, orphaning every write queued under it. So
     * this state carries no key at all: a `MountKey("manual", vault)` is
     * unrepresentable, not merely discouraged.
     *
     * The next reachability wake retries. This is a screen a member can read,
     * not a spinner with no end.
     */
    public data class Waiting(val because: Reason) : Mount {
        public enum class Reason {
            /** Not paired to any gateway yet. */
            NOT_PAIRED,

            /** Paired, and the endpoint has not resolved on this network. */
            RESOLVING_ENDPOINT,

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
 * The `(gateway, vault)` pair a replica file is named after.
 *
 * Both halves are required and both are validated non-blank, which is the whole
 * mechanism behind "there is no stand-in for a gateway id": the only way to get
 * a [MountKey] is to have two real ids.
 */
public data class MountKey(val gatewayId: String, val vaultId: String) {
    init {
        require(gatewayId.isNotBlank()) {
            "a mount waits for a real gateway id and never names a placeholder " +
                "(docs/mobile-offline.md:249)"
        }
        require(vaultId.isNotBlank()) { "a mount needs a vault id" }
        require(gatewayId != PLACEHOLDER && vaultId != PLACEHOLDER) {
            "\"$PLACEHOLDER\" is the literal that orphaned every queued write in v0; " +
                "it is refused by construction here (docs/mobile-offline.md:249-251)"
        }
    }

    /**
     * The replica file's name. One file per pair, and the pair is IN the name
     * so two vaults can never resolve to one path.
     */
    public val fileName: String get() = "$gatewayId.$vaultId.replica.db"

    public companion object {
        /** The exact string v0 used, kept here so it can be refused by name. */
        public const val PLACEHOLDER: String = "manual"
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
