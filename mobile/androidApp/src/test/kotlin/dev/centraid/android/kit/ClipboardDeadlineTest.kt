package dev.centraid.android.kit

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import java.security.MessageDigest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** A delayed clear for an older clip must leave a newer sensitive clip and its deadline intact. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ClipboardDeadlineTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private val prefs get() = context.getSharedPreferences("centraid.clipboard", Context.MODE_PRIVATE)
    private val clipboard get() = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    @Before
    fun clearPriorState() {
        ClipboardDeadline.spent(context, OLD_CLIP)
        ClipboardDeadline.spent(context, NEW_CLIP)
        prefs.edit().clear().commit()
        clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
    }

    @After
    fun clearState() {
        ClipboardDeadline.spent(context, OLD_CLIP)
        ClipboardDeadline.spent(context, NEW_CLIP)
        ClipboardDeadline.spent(context, LOCKER_CLIP)
        prefs.edit().clear().commit()
        clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
    }

    @Test
    fun aClearForAnOlderClipPreservesTheNewClipAndItsPersistedDeadline() {
        clipboard.setPrimaryClip(ClipData.newPlainText("", OLD_CLIP))
        ClipboardDeadline.armed(context, OLD_CLIP, AFTER_MS)
        clipboard.setPrimaryClip(ClipData.newPlainText("", NEW_CLIP))
        ClipboardDeadline.armed(context, NEW_CLIP, AFTER_MS)
        val savedNewDeadline = prefs.getLong("deadline_ms", 0L)

        ClipboardDeadline.clearIfMatches(context, OLD_CLIP)

        assertEquals(NEW_CLIP, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertEquals(sha256(NEW_CLIP), prefs.getString("digest", null))
        assertTrue(savedNewDeadline > 0L)
        assertEquals(savedNewDeadline, prefs.getLong("deadline_ms", 0L))
        assertFalse(prefs.all.values.contains(NEW_CLIP))
    }

    @Test
    fun aMatchingClearSpendsOnlyItsOwnDeadline() {
        clipboard.setPrimaryClip(ClipData.newPlainText("", OLD_CLIP))
        ClipboardDeadline.armed(context, OLD_CLIP, AFTER_MS)

        ClipboardDeadline.clearIfMatches(context, OLD_CLIP)

        assertEquals("", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertFalse(prefs.contains("deadline_ms"))
        assertFalse(prefs.contains("digest"))
    }

    @Test
    fun anUnobservableClipboardPreservesExpiredCleanupUntilAFocusedSweepCanSeeIt() {
        clipboard.setPrimaryClip(ClipData.newPlainText("", OLD_CLIP))
        prefs.edit().putLong("deadline_ms", NEW_DEADLINE).putString("digest", sha256(OLD_CLIP)).commit()

        ClipboardDeadline.clearIfMatches(
            context,
            OLD_CLIP,
            nowMs = NOW,
            readPrimaryText = { null },
            clearPrimaryClip = { clipboard.setPrimaryClip(ClipData.newPlainText("", "")) },
        )
        ClipboardDeadline.sweep(context, NOW) { null }

        assertEquals(NOW, prefs.getLong("deadline_ms", 0L))
        assertEquals(sha256(OLD_CLIP), prefs.getString("digest", null))
        assertEquals(OLD_CLIP, clipboard.primaryClip?.getItemAt(0)?.text?.toString())

        ClipboardDeadline.sweep(context, NOW) {
            clipboard.primaryClip?.getItemAt(0)?.text?.toString()
        }

        assertEquals("", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertFalse(prefs.contains("deadline_ms"))
        assertFalse(prefs.contains("digest"))
    }

    @Test
    fun anUnobservableStaleClearDoesNotAdvanceANewerClipDeadline() {
        prefs.edit().putLong("deadline_ms", NEW_DEADLINE).putString("digest", sha256(NEW_CLIP)).commit()

        ClipboardDeadline.clearIfMatches(
            context,
            OLD_CLIP,
            nowMs = NOW,
            readPrimaryText = { null },
            clearPrimaryClip = { clipboard.setPrimaryClip(ClipData.newPlainText("", "")) },
        )

        assertEquals(NEW_DEADLINE, prefs.getLong("deadline_ms", 0L))
        assertEquals(sha256(NEW_CLIP), prefs.getString("digest", null))
    }

    @Test
    fun aLockAfterProcessRecreationUsesOnlyThePersistedOwnedClipLease() {
        val lease = ClipOwnership(ClipboardDeadline.newLeaseId(VAULT_A, AFTER_MS))
        val clip = ClipData.newPlainText("", LOCKER_CLIP).also {
            ClipboardDeadline.markOwnedClip(it, lease.leaseId.orEmpty())
        }
        assertTrue(ClipboardDeadline.persist(context, LOCKER_CLIP, AFTER_MS, VAULT_A, lease.leaseId.orEmpty()))

        assertEquals(VAULT_A, prefs.getString("owner_vault_id", null))
        assertEquals(lease.leaseId, prefs.getString("lease_id", null))
        assertEquals(sha256(LOCKER_CLIP), prefs.getString("digest", null))
        assertTrue(prefs.contains("deadline_ms"))
        assertFalse(prefs.all.values.contains(LOCKER_CLIP))
        assertEquals(ClipOwnership(null), ClipboardDeadline.currentOwnership(clipboard))

        clipboard.setPrimaryClip(clip)
        assertTrue(ClipboardDeadline.activate(context, VAULT_A, lease.leaseId.orEmpty()))
        assertEquals(lease, ClipboardDeadline.currentOwnership(clipboard))

        // `clearOwned` has no process-local lease state: a recreated activity/Rust board can
        // honor Lock from the persisted owner/digest plus the OS clip marker.
        ClipboardDeadline.clearOwned(
            context,
            VAULT_A,
            nowMs = NOW,
            readOwnership = { ClipboardDeadline.currentOwnership(clipboard) },
            readPrimaryDigest = { clipboard.primaryClip?.getItemAt(0)?.text?.toString()?.let(::sha256) },
            clearPrimaryClip = { clipboard.setPrimaryClip(ClipData.newPlainText("", "")) },
        )

        assertEquals("", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertFalse(prefs.contains("owner_vault_id"))
        assertFalse(prefs.contains("digest"))
    }

    @Test
    fun persistenceUsesTheOsWriteTimeAsTheOriginalDeadlineAnchor() {
        val leaseId = ClipboardDeadline.newLeaseId(VAULT_A, AFTER_MS)
        val issuedAt = 1_000L

        assertTrue(ClipboardDeadline.persist(context, LOCKER_CLIP, AFTER_MS, VAULT_A, leaseId, issuedAt))

        assertEquals(issuedAt + AFTER_MS, prefs.getLong("deadline_ms", 0L))
    }

    @Test
    fun aLockFromAnotherVaultDoesNotInspectOrClearTheCurrentVaultCopy() {
        armOwned(LOCKER_CLIP, VAULT_B)
        val originalDeadline = prefs.getLong("deadline_ms", 0L)

        ClipboardDeadline.clearOwned(
            context,
            VAULT_A,
            nowMs = NOW,
            readOwnership = { error("a stale other-vault lock must not inspect the current clipboard") },
            readPrimaryDigest = { error("a stale other-vault lock must not read clipboard text") },
            clearPrimaryClip = { error("a stale other-vault lock must not clear the current clipboard") },
        )

        assertEquals(LOCKER_CLIP, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertEquals(VAULT_B, prefs.getString("owner_vault_id", null))
        assertEquals(sha256(LOCKER_CLIP), prefs.getString("digest", null))
        assertEquals(originalDeadline, prefs.getLong("deadline_ms", 0L))
    }

    @Test
    fun aTextOnlyTimerCannotClearTheSameTextWhenItsVaultIsUnknown() {
        armOwned(LOCKER_CLIP, VAULT_B)
        val originalDeadline = prefs.getLong("deadline_ms", 0L)

        ClipboardDeadline.clearIfMatches(
            context,
            LOCKER_CLIP,
            nowMs = NOW,
            readPrimaryText = { error("a vault-less timer must not inspect an owner-bound clipboard") },
            clearPrimaryClip = { error("a vault-less timer must not clear an owner-bound clipboard") },
        )

        assertEquals(LOCKER_CLIP, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertEquals(VAULT_B, prefs.getString("owner_vault_id", null))
        assertEquals(sha256(LOCKER_CLIP), prefs.getString("digest", null))
        assertEquals(originalDeadline, prefs.getLong("deadline_ms", 0L))
    }

    @Test
    fun aLockClearsTheLatestSensitiveCopyButLeavesAnUnrelatedReplacementAlone() {
        armOwned(OLD_CLIP, VAULT_A)
        armOwned(NEW_CLIP, VAULT_A)

        ClipboardDeadline.clearOwned(
            context,
            VAULT_A,
            nowMs = NOW,
            readOwnership = { ClipboardDeadline.currentOwnership(clipboard) },
            readPrimaryDigest = { clipboard.primaryClip?.getItemAt(0)?.text?.toString()?.let(::sha256) },
            clearPrimaryClip = { clipboard.setPrimaryClip(ClipData.newPlainText("", "")) },
        )

        assertEquals("", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertFalse(prefs.contains("owner_vault_id"))

        armOwned(LOCKER_CLIP, VAULT_A)
        clipboard.setPrimaryClip(ClipData.newPlainText("", UNRELATED_CLIP))
        var cleared = false

        ClipboardDeadline.clearOwned(
            context,
            VAULT_A,
            nowMs = NOW,
            readOwnership = { ClipboardDeadline.currentOwnership(clipboard) },
            readPrimaryDigest = { error("an unrelated replacement must not be read") },
            clearPrimaryClip = { cleared = true },
        )

        assertFalse(cleared)
        assertEquals(UNRELATED_CLIP, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertFalse(prefs.contains("owner_vault_id"))
        assertFalse(prefs.contains("digest"))
    }

    @Test
    fun aLockWithAnUnobservableClipDefersAsDueNowUntilFocusRestoresOwnershipMetadata() {
        armOwned(LOCKER_CLIP, VAULT_A)

        ClipboardDeadline.clearOwned(
            context,
            VAULT_A,
            nowMs = NOW,
            readOwnership = { null },
            readPrimaryDigest = { error("an unobservable clipboard must not be read") },
            clearPrimaryClip = { error("an unobservable clipboard cannot be cleared by guess") },
        )

        assertEquals(NOW, prefs.getLong("deadline_ms", 0L))
        assertEquals(VAULT_A, prefs.getString("owner_vault_id", null))
        assertEquals(sha256(LOCKER_CLIP), prefs.getString("digest", null))

        ClipboardDeadline.sweep(
            context,
            NOW,
            readPrimaryText = { error("owned clipboard cleanup must not read its plaintext") },
            readOwnership = { null },
            readPrimaryDigest = { error("an unobservable owned clipboard must not be read") },
        )
        assertEquals(LOCKER_CLIP, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertEquals(VAULT_A, prefs.getString("owner_vault_id", null))

        ClipboardDeadline.sweep(
            context,
            NOW,
            readPrimaryText = { error("owned clipboard cleanup must not read its plaintext") },
            readOwnership = { ClipboardDeadline.currentOwnership(clipboard) },
            readPrimaryDigest = { clipboard.primaryClip?.getItemAt(0)?.text?.toString()?.let(::sha256) },
        )

        assertEquals("", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertFalse(prefs.contains("owner_vault_id"))
        assertFalse(prefs.contains("digest"))
    }

    @Test
    fun aStaleNullReadCannotShortenANewerSameTextLeaseDeadline() {
        val oldLease = armOwned(LOCKER_CLIP, VAULT_A)
        val newerLeaseId = ClipboardDeadline.newLeaseId(VAULT_A, AFTER_MS)
        val newerDeadline = NEW_DEADLINE + 10_000L

        ClipboardDeadline.clearOwned(
            context,
            VAULT_A,
            nowMs = NOW,
            readOwnership = {
                // A newer copy with identical text is published after this clear captured its
                // lease identity but before its metadata-only clipboard read completes.
                prefs.edit()
                    .putString("owner_vault_id", VAULT_A)
                    .putString("digest", sha256(LOCKER_CLIP))
                    .putString("lease_id", newerLeaseId)
                    .putLong("deadline_ms", newerDeadline)
                    .commit()
                null
            },
            readPrimaryDigest = { error("unobservable metadata must not trigger a content read") },
            clearPrimaryClip = { error("an unobservable clipboard must not be cleared by guess") },
        )

        assertTrue(oldLease.leaseId != newerLeaseId)
        assertEquals(newerLeaseId, prefs.getString("lease_id", null))
        assertEquals(newerDeadline, prefs.getLong("deadline_ms", 0L))
        assertEquals(sha256(LOCKER_CLIP), prefs.getString("digest", null))
    }

    @Test
    fun aVisibleLeaseWithUnreadableTextRemainsPendingUntilFocusCanVerifyIt() {
        armOwned(LOCKER_CLIP, VAULT_A)

        ClipboardDeadline.clearOwned(
            context,
            VAULT_A,
            nowMs = NOW,
            readOwnership = { ClipboardDeadline.currentOwnership(clipboard) },
            readPrimaryDigest = { null },
            clearPrimaryClip = { error("unreadable clip text must not be cleared by guess") },
        )

        assertEquals(NOW, prefs.getLong("deadline_ms", 0L))
        assertEquals(VAULT_A, prefs.getString("owner_vault_id", null))
        assertEquals(sha256(LOCKER_CLIP), prefs.getString("digest", null))

        ClipboardDeadline.sweep(
            context,
            NOW,
            readPrimaryText = { error("owned clipboard cleanup must not read through the legacy path") },
            readOwnership = { ClipboardDeadline.currentOwnership(clipboard) },
            readPrimaryDigest = { null },
        )
        assertEquals(LOCKER_CLIP, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertEquals(NOW, prefs.getLong("deadline_ms", 0L))
        assertEquals(VAULT_A, prefs.getString("owner_vault_id", null))

        ClipboardDeadline.sweep(
            context,
            NOW,
            readPrimaryText = { error("owned clipboard cleanup must not read through the legacy path") },
            readOwnership = { ClipboardDeadline.currentOwnership(clipboard) },
            readPrimaryDigest = { clipboard.primaryClip?.getItemAt(0)?.text?.toString()?.let(::sha256) },
        )

        assertEquals("", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertFalse(prefs.contains("owner_vault_id"))
        assertFalse(prefs.contains("digest"))
    }

    private fun armOwned(text: String, vaultId: String): ClipOwnership {
        val lease = ClipOwnership(ClipboardDeadline.newLeaseId(vaultId, AFTER_MS))
        val clip = ClipData.newPlainText("", text).also { ClipboardDeadline.markOwnedClip(it, lease.leaseId.orEmpty()) }
        assertTrue(ClipboardDeadline.persist(context, text, AFTER_MS, vaultId, lease.leaseId.orEmpty()))
        clipboard.setPrimaryClip(clip)
        assertTrue(ClipboardDeadline.activate(context, vaultId, lease.leaseId.orEmpty()))
        return lease
    }

    private fun sha256(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }

    private companion object {
        const val OLD_CLIP = "AX2211 old locker copy"
        const val NEW_CLIP = "AX2211 newer sensitive copy"
        const val LOCKER_CLIP = "AX2211 process-restored locker copy"
        const val UNRELATED_CLIP = "QA unrelated Notes clipboard"
        const val VAULT_A = "vault-a-fixture"
        const val VAULT_B = "vault-b-fixture"
        const val AFTER_MS = 60_000L
        const val NEW_DEADLINE = 3_000L
        const val NOW = 2_000L
    }
}
