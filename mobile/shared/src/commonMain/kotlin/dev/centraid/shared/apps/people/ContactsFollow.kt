package dev.centraid.shared.apps.people

import dev.centraid.core.CentraidCore
import dev.centraid.shared.sync.phone.OriginGone
import dev.centraid.shared.sync.phone.PhoneFollowPass
import dev.centraid.shared.sync.phone.PhoneFollowReads
import dev.centraid.shared.sync.phone.PhoneFollowSource
import dev.centraid.shared.sync.phone.PhoneOriginRef
import dev.centraid.shared.sync.phone.PhoneSource

/** WHAT THE SHELL READ OF THE ADDRESS BOOK for a following pass: [ContactsImportBridge.sync]'s arguments. */
public data class ContactsRead(
    public val contacts: List<PhoneContact>,
    public val origins: List<PhoneOriginRef>,
    public val complete: Boolean,
)

/** THE SHELL'S ADDRESS-BOOK READER: iOS `CNContactStore`, Android `ContactsContract`. */
public interface ContactsReader {
    /**
     * Read the address book and hand it to [deliver], off the main thread; **null when contacts
     * access is not already granted**: a following pass never asks the OS for permission.
     */
    public fun read(deliver: (ContactsRead?) -> Unit)
}

/**
 * CONTACTS → PEOPLE, FOLLOWED (#1127): the shell hands this to the follower with its [reader]. A
 * pass sends the address book to the vault, which merges it ([ContactsImport.run]); nothing is held
 * for a question, because the vault decides what a record gone from a read does (a person the
 * member never edited goes to the trash, one they did keeps the row and stops following).
 */
public class ContactsFollow(private val reader: ContactsReader) : PhoneFollowSource {
    override val source: PhoneSource = PhoneSource.CONTACTS

    override fun bind(core: CentraidCore): PhoneFollowPass = object : PhoneFollowPass {
        override suspend fun imported(): Boolean? = PhoneFollowReads.imported(core, PhoneSource.CONTACTS)

        override suspend fun run(): List<OriginGone>? {
            val read = PhoneFollowReads.await<ContactsRead> { reader.read(it) } ?: return null
            ContactsImport.run(core, read.contacts, read.origins, read.complete)
            return emptyList()
        }

        override suspend fun resolve(gone: OriginGone, keep: Boolean) = Unit
    }
}
