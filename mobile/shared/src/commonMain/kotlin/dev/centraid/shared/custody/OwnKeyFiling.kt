package dev.centraid.shared.custody

import centraid.core.v1.Command
import centraid.core.v1.CommandStatus
import centraid.core.v1.Envelope
import centraid.core.v1.Request
import dev.centraid.core.CentraidCore
import dev.centraid.core.CoreOutcome
import dev.centraid.design.copy.WordsCopy
import dev.centraid.shared.kit.jsonString
import dev.centraid.shared.shell.HomeSession
import okio.ByteString.Companion.encodeUtf8

/**
 * A VAULT ON ITS OWN KEY, FILED IN THE MAIN VAULT'S LOCKER (R-ONBOARD-10).
 *
 * A vault kept on its own recovery key is otherwise reached only by that key,
 * and a second key to keep safe is one more a member loses. Filed as a Locker
 * note in a vault on the member's own key, it comes back whenever that vault
 * does — the one place inside a vault a recovery key belongs, because the key
 * that opens that Locker is a different one.
 *
 * **It waits for an unlock.** The core seals a Locker secret only while that
 * vault's Locker session is open (`locker::phone::seal_command`), and making a
 * vault never opens one — nor should it: the session is the member's presence,
 * proved by the phone's owner check. So [Enrollment.make] records the key as
 * pending ([VaultSecrets.addPendingFiling]) and [filePending] runs each time a
 * Locker unlocks (`LockerGate`); it files into the vault in front only when
 * that vault is on the member's own key, and clears what the core took.
 *
 * `locker.add_item` seals `content` like every Locker secret. The invoke key
 * names the item, never the content: an invoke key is logged.
 */
public object OwnKeyFiling {
    private const val COMMAND: String = "locker.add_item"

    /** File every pending key into [session]'s vault in front, if it is a main vault. Answers how many were filed. */
    public suspend fun filePending(session: HomeSession, secrets: VaultSecrets, id: () -> ByteArray): Int {
        val pending = secrets.pendingFilings()
        if (pending.isEmpty()) return 0
        val front = session.shelf.foregroundHolding() ?: return 0
        // A VAULT ON ITS OWN KEY is no main vault: its Locker needs its own
        // key to reach, so a key filed there is lost with it.
        if (secrets.ownSeedOf(front.vaultId) != null || secrets.vaultIndex(front.vaultId) == null) return 0
        val core = front.core ?: return 0
        var filed = 0
        for ((own, name) in pending) {
            val words = secrets.ownWords(own)
            if (words == null) {
                // NOTHING HERE TO FILE (the words were never kept on this
                // phone): the entry is dropped rather than retried forever.
                secrets.clearPendingFiling(own)
                continue
            }
            if (file(core, id(), name, words)) {
                secrets.clearPendingFiling(own)
                filed += 1
            }
        }
        return filed
    }

    /** One `locker.add_item` note; true only when the core executed it. */
    internal suspend fun file(core: CentraidCore, id: ByteArray, name: String, words: List<String>): Boolean {
        val itemId = id.joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
        val title = WordsCopy.OWN_KEY_FILED_TITLE.replace("{name}", name)
        val input = "{\"item_id\":${jsonString(itemId)},\"type\":\"note\"," +
            "\"title\":${jsonString(title)},\"content\":${jsonString(words.joinToString(" "))},\"tags\":[]}"
        val answer = runCatching {
            core.call(
                Envelope(
                    request = Request(
                        command = Command(name = COMMAND, invoke_key = "$COMMAND:$itemId", input = input.encodeUtf8()),
                    ),
                ),
            )
        }.getOrNull()
        val status = (answer as? CoreOutcome.Answered)?.value?.response?.command?.status
        return status == CommandStatus.COMMAND_STATUS_EXECUTED
    }
}
