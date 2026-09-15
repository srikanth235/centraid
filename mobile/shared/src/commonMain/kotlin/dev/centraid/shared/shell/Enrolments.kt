package dev.centraid.shared.shell

import dev.centraid.core.PairingRecord
import dev.centraid.shared.platform.PlatformServices

/**
 * ONE ENROLMENT PER VAULT, AND ONE ENTRY IN THE STORE (#1025 S7-13).
 *
 * ## What this replaces, and why it had to collapse
 *
 * There were two objects and three secure-store entries for one relationship:
 * `EndpointKeys` kept `endpoint.<vaultId>`, `Pairings` kept `pairing.<vaultId>`,
 * and [Replicas] kept the file. Each was written under a PAIRING name first and
 * renamed to the vault id once the gateway named one — three renames, in a row,
 * with no transaction over them.
 *
 * Three renames is three chances to settle by halves, and the shapes that
 * produces are all real: an identity for a vault whose address is gone, an
 * address for a vault whose identity was never kept, a replica filed under a
 * vault id whose key is still under the pairing name. The last of those is a
 * seat that dials with a stranger's identity on its very next launch — and it
 * had a second, quieter cause in `EndpointKeys.settle`, which refused to
 * overwrite its destination and so silently ABANDONED the freshly enrolled key
 * whenever anything had already written one there.
 *
 * So: **one record, one name, one rename**. [settle] moves the whole enrolment
 * or none of it.
 *
 * ## The granularity is the VAULT, on every axis (#1025 S7-13, ruling A)
 *
 * Identity key, endpoint, core, replica, byte store, enrolment record, state:
 * every one of them is per vault. Never per gateway — "gateway" is not a noun
 * this device has; two vaults behind one machine is a coincidence nothing here
 * surfaces or acts on — and never per device.
 *
 * That is the rule, and the correlation property people usually cite for it is
 * a CONSEQUENCE: because the identity is per vault, two households' gateways
 * cannot tell they are talking to one phone. `D-1025-S5-5` justified per-vault
 * keys by revocation instead — "revoking this phone from one gateway would
 * revoke it from the other's" — and that was never the real reason, because
 * enrolment rows are per gateway and a shared key would already have been two
 * rows. The rule needs no consequence to stand on.
 *
 * ## It holds a credential, and the store is the right place for all of it
 *
 * [PairingRecord.secret] is the one unrecoverable secret on this device. The
 * rest — an endpoint id, a uuid, a label, dialling hints — is not a credential
 * at all. They are one entry because they are one fact, and the platform store
 * is where this shell keeps what must survive a launch and be cleared with the
 * vault.
 */
public object Enrolments {
    /**
     * The name a device enrols under before it knows what it is enrolling with.
     *
     * [settle]d under the vault id the moment the gateway names one. The
     * replica moves with it ([Replicas.settle]), and those are now the only two
     * moves — a record filed under the pairing name while the replica is filed
     * under a vault id is a vault nothing can open as itself.
     */
    public const val PAIRING: String = "pairing"

    /** 32 bytes. `crates/core-ffi` refuses anything else, by length, at the door. */
    public const val SECRET_BYTES: Int = 32

    private fun nameOf(name: String) = "enrolment.$name"

    /** The enrolment filed under [name], or null when this device has none. */
    public suspend fun of(services: PlatformServices, name: String): PairingRecord? =
        services.secureStore.read(nameOf(name))?.let(::decode)

    /**
     * THE RECORD A DEVICE PAIRS WITH, minting its identity the first time.
     *
     * Reading and minting are one call on purpose. Two — `read` then `mint` —
     * is a race with itself the moment anything opens a session twice, and the
     * loser writes a second secret over the first: the device would then be
     * enrolled under a key it no longer has.
     *
     * It carries no gateway address and, deliberately, a NULL relay url, which
     * is what makes it the TRANSIENT record: `crates/core` reads the null as
     * "this device has not been told what deployment it is joining" and leaves
     * relay mode on. A device that guessed relays off could not pair over the
     * internet at all; a device that read null as "" would do exactly that.
     */
    public suspend fun minted(services: PlatformServices): PairingRecord {
        of(services, PAIRING)?.takeIf { it.secret.length == SECRET_BYTES * 2 }?.let { return it }
        val record = PairingRecord(
            secret = hex(services.secureRandom.bytes(SECRET_BYTES)),
            gatewayAddress = "",
            vaultId = "",
            vaultName = "",
        )
        keep(services, PAIRING, record)
        return record
    }

    /** Write [record] under [name]. */
    public suspend fun keep(
        services: PlatformServices,
        name: String,
        record: PairingRecord,
    ) {
        services.secureStore.write(nameOf(name), encode(record))
    }

    /**
     * FILE THE WHOLE ENROLMENT UNDER THE VAULT THE GATEWAY NAMED — one rename.
     *
     * [answered] is what the `PairOk` said; the secret is the one this device
     * already minted and the gateway already enrolled, so it is carried across
     * rather than taken from the answer, which never contains it.
     *
     * **The destination IS overwritten**, and the predecessor's refusal to was
     * a defect rather than a safeguard. The reasoning was "re-pairing the same
     * vault must not replace the key it is already enrolled under" — but by the
     * time this runs the ticket is burned and the gateway has enrolled the NEW
     * key; keeping the old one files a credential the gateway no longer knows
     * and throws away the one it does. `Shelf.admit` refuses a vault this
     * device already holds before any of this, which is where that concern
     * actually belongs.
     *
     * The pairing name is DELETED rather than left behind, and the interface's
     * own rule is how: writing `""` deletes.
     */
    public suspend fun settle(
        services: PlatformServices,
        vaultId: String,
        answered: PairingRecord,
    ) {
        if (vaultId.isEmpty() || vaultId == PAIRING) return
        val secret = of(services, PAIRING)?.secret.orEmpty()
        keep(services, vaultId, answered.copy(secret = secret, vaultId = vaultId))
        services.secureStore.write(nameOf(PAIRING), "")
    }

    /**
     * Drop this device's enrolment with [vaultId] (#1025 S7-9).
     *
     * Part of `Shelf.forget`. **The gateway is not told**: the enrolment row
     * stays there until someone with the vault revokes it, and a phone that
     * could revoke itself from a household's gateway by tapping a row on its
     * own screen would be a phone that can lock a member out. What this deletes
     * is the secret half, so the identity cannot be presented again from here.
     */
    public suspend fun forget(services: PlatformServices, vaultId: String) {
        if (vaultId.isEmpty()) return
        services.secureStore.write(nameOf(vaultId), "")
    }

    /**
     * Seven fields, separated by a character none of them can contain.
     *
     * NOT JSON, for the reason every other reader in this module gives: the
     * store holds a string, and a multiplatform JSON dependency in `commonMain`
     * to write seven fields would be a dependency for nothing.
     */
    private fun encode(record: PairingRecord): String = listOf(
        record.secret,
        record.gatewayAddress,
        record.vaultId,
        record.vaultName,
        record.relayUrl ?: UNTOLD,
        record.directAddrs.joinToString(HINT),
        record.enrolledPublicKey,
    ).joinToString(FIELD)

    private fun decode(text: String): PairingRecord? {
        val fields = text.split(FIELD)
        if (fields.size < 7) return null
        // A RECORD THAT SAYS NOTHING IS NO RECORD. An entry with neither an
        // identity nor a gateway is a leftover, not an enrolment.
        if (fields[0].isEmpty() && fields[1].isEmpty()) return null
        return PairingRecord(
            secret = fields[0],
            gatewayAddress = fields[1],
            vaultId = fields[2],
            vaultName = fields[3],
            relayUrl = fields[4].takeIf { it != UNTOLD },
            directAddrs = fields[5].split(HINT).filter { it.isNotEmpty() },
            enrolledPublicKey = fields[6],
        )
    }

    /**
     * "NOT TOLD", which is a different thing from "no relay" (#1025 S7-13).
     *
     * A record that has not been told leaves relay mode on; one that stated an
     * empty relay turns it off. Two states in one string field need a value no
     * URL can be, and a group separator is one.
     */
    private const val UNTOLD: String = "\u001d"

    private const val FIELD: String = "\u001f"
    private const val HINT: String = "\u001e"

    private const val DIGITS = "0123456789abcdef"

    /**
     * Lowercase hex, which is what `centraid_open` parses.
     *
     * Written out rather than taken from a dependency: `commonMain` has one hex
     * encoder available to it (okio's, over a `ByteString`) and reaching for a
     * byte-string wrapper to render 32 bytes would be the larger thing.
     */
    private fun hex(bytes: ByteArray): String = buildString(bytes.size * 2) {
        bytes.forEach { byte ->
            val value = byte.toInt() and 0xff
            append(DIGITS[value shr 4])
            append(DIGITS[value and 0x0f])
        }
    }
}
