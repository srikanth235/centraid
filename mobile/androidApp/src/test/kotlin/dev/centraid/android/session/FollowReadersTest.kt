package dev.centraid.android.session

import android.database.MatrixCursor
import android.provider.ContactsContract
import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.rules.TemporaryFolder
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class FollowReadersTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun failedStoreQueryCannotBecomeAnEmptyCompleteSnapshot() {
        assertThrows(IllegalStateException::class.java) {
            (null as List<String>?).requireStoreRead()
        }
    }

    @Test
    fun aSuccessfulEmptyReadRemainsAnEmptyRead() {
        assertEquals(emptyList<String>(), emptyList<String>().requireStoreRead())
    }

    @Test
    fun clearedAndroidContactScalarsAreExplicitNullAndNamesKeepAValidFormAndTitle() {
        val before = JSONObject(FollowReaders.contacts(RuntimeEnvironment.getApplication(), contactsQuery(includeGraceDetails = true)))
        val after = JSONObject(FollowReaders.contacts(RuntimeEnvironment.getApplication(), contactsQuery(includeGraceDetails = false)))
        val beforeRecords = before.getJSONArray("records")
        val afterRecords = after.getJSONArray("records")
        val graceBefore = beforeRecords.getJSONObject(0).getJSONObject("fields")
        val graceAfter = afterRecords.getJSONObject(0).getJSONObject("fields")
        val organization = afterRecords.getJSONObject(1).getJSONObject("fields")

        assertEquals("person", graceBefore.getString("form"))
        assertEquals("Grace Hopper", graceBefore.getString("title"))
        for (field in listOf("sort_name", "given", "family", "phonetic", "nickname", "org", "role")) {
            assertTrue("initial contact should contain $field", graceBefore.has(field))
            assertTrue("cleared contact must send JSON null for $field", graceAfter.has(field))
            assertTrue("cleared contact must not retain $field", graceAfter.isNull(field))
        }
        assertEquals("person", graceAfter.getString("form"))
        assertEquals("Grace Hopper", graceAfter.getString("title"))
        assertEquals("org", organization.getString("form"))
        assertEquals("US Navy", organization.getString("title"))
    }

    @Test
    fun releasingOneOfTwoVaultRefsKeepsTheSharedOsGrantUntilTheLastRef() {
        val uri = "content://provider/tree/shared"
        val indexFile = File(temporary.root, "grant.android.uri-owners.v1")
        val vaultAIndex = UriGrantOwnershipIndex(indexFile)
        val vaultBIndex = UriGrantOwnershipIndex(indexFile)
        val vaultA = mapOf("grant.folder-vault-a" to uri)
        val vaultB = mapOf("grant.folder-vault-b" to uri)
        vaultAIndex.save(vaultAIndex.addOwner(emptyMap(), uri, "folder-vault-a"))
        vaultBIndex.save(vaultBIndex.addOwner(vaultBIndex.load(), uri, "folder-vault-b"))

        val first = vaultAIndex.withoutOwner(vaultAIndex.load(), uri, "folder-vault-a")
        assertFalse(first.revokeUri)
        assertEquals(setOf("folder-vault-b"), first.owners[uri])
        assertEquals(uri, vaultB["grant.folder-vault-b"])
        vaultAIndex.save(first.owners)

        val last = vaultBIndex.withoutOwner(vaultBIndex.load(), uri, "folder-vault-b")
        assertTrue(last.revokeUri)
        assertFalse(last.owners.containsKey(uri))
    }

    private fun contactsQuery(includeGraceDetails: Boolean): PhoneStoreQuery = { uri, projection, _, _, _ ->
        when (uri) {
            ContactsContract.Contacts.CONTENT_URI -> MatrixCursor(projection).apply {
                addRow(arrayOf<Any?>(9L, "grace", "Grace Hopper", if (includeGraceDetails) "Hopper, Grace" else null, null))
                addRow(arrayOf<Any?>(10L, "navy", "", "", null))
            }
            ContactsContract.Data.CONTENT_URI -> MatrixCursor(projection).apply {
                if (includeGraceDetails) {
                    addRow(arrayOf<Any?>(
                        9L, ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE,
                        null, "Grace", "Hopper", null, null, null, "G", "H", "P",
                    ))
                    addRow(arrayOf<Any?>(
                        9L, ContactsContract.CommonDataKinds.Nickname.CONTENT_ITEM_TYPE,
                        "Amazing Grace", null, null, null, null, null, null, null, null,
                    ))
                    addRow(arrayOf<Any?>(
                        9L, ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE,
                        "US Navy", null, null, "Commander", null, null, null, null, null,
                    ))
                }
                addRow(arrayOf<Any?>(
                    10L, ContactsContract.CommonDataKinds.Organization.CONTENT_ITEM_TYPE,
                    "US Navy", null, null, null, null, null, null, null, null,
                ))
            }
            else -> error("Unexpected Contacts provider URI: $uri")
        }
    }
}
