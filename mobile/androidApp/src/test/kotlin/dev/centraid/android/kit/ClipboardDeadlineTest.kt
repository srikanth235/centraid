package dev.centraid.android.kit

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
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
        prefs.edit().clear().commit()
        clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
    }

    @After
    fun clearState() {
        prefs.edit().clear().commit()
        clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
    }

    @Test
    fun aClearForAnOlderClipPreservesTheNewClipAndItsPersistedDeadline() {
        armOwned(OLD_CLIP, "")
        val newLease = armOwned(NEW_CLIP, "")
        val savedNewDeadline = prefs.getLong("deadline_ms", 0L)

        ClipboardDeadline.clearIfMatches(context, OLD_CLIP)

        assertEquals(NEW_CLIP, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertEquals(newLease.leaseId, prefs.getString("lease_id", null))
        assertTrue(savedNewDeadline > 0L)
        assertEquals(savedNewDeadline, prefs.getLong("deadline_ms", 0L))
        assertFalse(prefs.all.values.contains(NEW_CLIP))
    }

    @Test
    fun aMatchingClearSpendsOnlyItsOwnDeadline() {
        armOwned(OLD_CLIP, "")

        ClipboardDeadline.clearIfMatches(context, OLD_CLIP)

        assertEquals("", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertFalse(prefs.contains("deadline_ms"))
        assertFalse(prefs.contains("lease_id"))
    }

    @Test
    fun anUnobservableClipboardPreservesExpiredCleanupUntilAFocusedSweepCanSeeIt() {
        val lease = armOwned(OLD_CLIP, "")
        prefs.edit().putLong("deadline_ms", NOW - 1).commit()

        ClipboardDeadline.sweep(context, NOW, readOwnership = { null }, primaryReadable = { false })

        assertEquals(lease.leaseId, prefs.getString("lease_id", null))
        assertEquals(OLD_CLIP, clipboard.primaryClip?.getItemAt(0)?.text?.toString())

        ClipboardDeadline.sweep(
            context,
            NOW,
            readOwnership = { ClipboardDeadline.currentOwnership(clipboard) },
            primaryReadable = { true },
        )

        assertEquals("", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertFalse(prefs.contains("deadline_ms"))
        assertFalse(prefs.contains("lease_id"))
    }

    @Test
    fun anUnobservableStaleClearDoesNotAdvanceANewerClipDeadline() {
        prefs.edit().putLong("deadline_ms", NEW_DEADLINE).putString("lease_id", "newer-lease").commit()

        ClipboardDeadline.clearIfMatches(
            context,
            OLD_CLIP,
            readPrimaryText = { null },
            clearPrimaryClip = { clipboard.setPrimaryClip(ClipData.newPlainText("", "")) },
        )

        assertEquals(NEW_DEADLINE, prefs.getLong("deadline_ms", 0L))
        assertEquals("newer-lease", prefs.getString("lease_id", null))
    }

    @Test
    fun theLeaseIsDurableBeforeTheClipIsWrittenAndALeaseWithNoClipIsSpentBySweep() {
        val leaseId = ClipboardDeadline.newLeaseId(VAULT_A, AFTER_MS)

        // The shell persists first; the process may die before the OS write happens.
        assertTrue(ClipboardDeadline.persist(context, AFTER_MS, VAULT_A, leaseId, issuedAtMs = NOW - AFTER_MS - 1))
        assertEquals(leaseId, prefs.getString("lease_id", null))
        assertEquals(VAULT_A, prefs.getString("owner_vault_id", null))
        assertTrue(prefs.contains("deadline_ms"))

        // Next launch: the clip was never written (an unrelated, untagged clip is there).
        clipboard.setPrimaryClip(ClipData.newPlainText("", UNRELATED_CLIP))
        ClipboardDeadline.sweep(
            context,
            NOW,
            readOwnership = { ClipboardDeadline.currentOwnership(clipboard) },
            primaryReadable = { error("an unrelated clip must not be read") },
        )

        assertEquals(UNRELATED_CLIP, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertFalse(prefs.contains("lease_id"))
        assertFalse(prefs.contains("deadline_ms"))
    }

    @Test
    fun aCrashAfterTheClipWriteIsRecoveredByTheNextLaunchSweep() {
        val leaseId = ClipboardDeadline.newLeaseId(VAULT_A, AFTER_MS)
        val clip = ClipData.newPlainText("", LOCKER_CLIP).also { ClipboardDeadline.markOwnedClip(it, leaseId) }
        assertTrue(ClipboardDeadline.persist(context, AFTER_MS, VAULT_A, leaseId, issuedAtMs = NOW - AFTER_MS - 1))
        clipboard.setPrimaryClip(clip)
        // The process dies here: no activate() ran. A fresh launch sweeps from prefs alone.

        ClipboardDeadline.sweep(context, NOW, { ClipboardDeadline.currentOwnership(clipboard) }, { true })

        assertEquals("", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertFalse(prefs.contains("lease_id"))
    }

    @Test
    fun aFailedCopyDiscardsItsLeaseButNotANewerOne() {
        val leaseId = ClipboardDeadline.newLeaseId(VAULT_A, AFTER_MS)
        assertTrue(ClipboardDeadline.persist(context, AFTER_MS, VAULT_A, leaseId))
        ClipboardDeadline.discard(context, "some-other-lease")
        assertEquals(leaseId, prefs.getString("lease_id", null))

        ClipboardDeadline.discard(context, leaseId)

        assertFalse(prefs.contains("lease_id"))
        assertFalse(prefs.contains("owner_vault_id"))
        assertFalse(prefs.contains("deadline_ms"))
    }

    @Test
    fun noDigestOfTheSecretIsPersistedAndAnOldOneIsDeleted() {
        prefs.edit().putString("digest", "0123abcd").commit()
        armOwned(LOCKER_CLIP, VAULT_A)

        assertFalse(prefs.all.values.any { it is String && it.contains("0123abcd") })

        prefs.edit().putString("digest", "0123abcd").putLong("deadline_ms", 5L).commit()
        ClipboardDeadline.sweep(context, NOW, readOwnership = { null }, primaryReadable = { false })

        assertFalse("an old digest is deleted on first access", prefs.contains("digest"))
        assertFalse("an unverifiable digest-only record is dropped", prefs.contains("deadline_ms"))
    }

    @Test
    fun aLockAfterProcessRecreationUsesOnlyThePersistedOwnedClipLease() {
        val lease = ClipOwnership(ClipboardDeadline.newLeaseId(VAULT_A, AFTER_MS))
        val clip = ClipData.newPlainText("", LOCKER_CLIP).also {
            ClipboardDeadline.markOwnedClip(it, lease.leaseId.orEmpty())
        }
        assertTrue(ClipboardDeadline.persist(context, AFTER_MS, VAULT_A, lease.leaseId.orEmpty()))

        assertEquals(VAULT_A, prefs.getString("owner_vault_id", null))
        assertEquals(lease.leaseId, prefs.getString("lease_id", null))
        assertTrue(prefs.contains("deadline_ms"))
        assertFalse(prefs.all.values.contains(LOCKER_CLIP))
        assertEquals(ClipOwnership(null), ClipboardDeadline.currentOwnership(clipboard))

        clipboard.setPrimaryClip(clip)
        assertTrue(ClipboardDeadline.activate(context, VAULT_A, lease.leaseId.orEmpty()))
        assertEquals(lease, ClipboardDeadline.currentOwnership(clipboard))

        // `clearOwned` has no process-local lease state: a recreated activity/Rust board can
        // honor Lock from the persisted owner/lease plus the OS clip marker.
        ClipboardDeadline.clearOwned(
            context,
            VAULT_A,
            nowMs = NOW,
            readOwnership = { ClipboardDeadline.currentOwnership(clipboard) },
            primaryReadable = { clipboard.primaryClip?.getItemAt(0)?.text != null },
            clearPrimaryClip = { clipboard.setPrimaryClip(ClipData.newPlainText("", "")) },
        )

        assertEquals("", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertFalse(prefs.contains("owner_vault_id"))
    }

    @Test
    fun persistenceUsesTheOsWriteTimeAsTheOriginalDeadlineAnchor() {
        val leaseId = ClipboardDeadline.newLeaseId(VAULT_A, AFTER_MS)
        val issuedAt = 1_000L

        assertTrue(ClipboardDeadline.persist(context, AFTER_MS, VAULT_A, leaseId, issuedAt))

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
            primaryReadable = { error("a stale other-vault lock must not read clipboard text") },
            clearPrimaryClip = { error("a stale other-vault lock must not clear the current clipboard") },
        )

        assertEquals(LOCKER_CLIP, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertEquals(VAULT_B, prefs.getString("owner_vault_id", null))
        assertEquals(originalDeadline, prefs.getLong("deadline_ms", 0L))
    }

    @Test
    fun aTextOnlyTimerCannotClearTheSameTextWhenItsVaultIsUnknown() {
        armOwned(LOCKER_CLIP, VAULT_B)
        val originalDeadline = prefs.getLong("deadline_ms", 0L)

        ClipboardDeadline.clearIfMatches(
            context,
            LOCKER_CLIP,
            readPrimaryText = { error("a vault-less timer must not inspect an owner-bound clipboard") },
            clearPrimaryClip = { error("a vault-less timer must not clear an owner-bound clipboard") },
        )

        assertEquals(LOCKER_CLIP, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertEquals(VAULT_B, prefs.getString("owner_vault_id", null))
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
            primaryReadable = { clipboard.primaryClip?.getItemAt(0)?.text != null },
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
            primaryReadable = { error("an unrelated replacement must not be read") },
            clearPrimaryClip = { cleared = true },
        )

        assertFalse(cleared)
        assertEquals(UNRELATED_CLIP, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertFalse(prefs.contains("owner_vault_id"))
    }

    @Test
    fun aLockWithAnUnobservableClipDefersAsDueNowUntilFocusRestoresOwnershipMetadata() {
        armOwned(LOCKER_CLIP, VAULT_A)

        ClipboardDeadline.clearOwned(
            context,
            VAULT_A,
            nowMs = NOW,
            readOwnership = { null },
            primaryReadable = { error("an unobservable clipboard must not be read") },
            clearPrimaryClip = { error("an unobservable clipboard cannot be cleared by guess") },
        )

        assertEquals(NOW, prefs.getLong("deadline_ms", 0L))
        assertEquals(VAULT_A, prefs.getString("owner_vault_id", null))

        ClipboardDeadline.sweep(
            context,
            NOW,
            readOwnership = { null },
            primaryReadable = { error("an unobservable owned clipboard must not be read") },
        )
        assertEquals(LOCKER_CLIP, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertEquals(VAULT_A, prefs.getString("owner_vault_id", null))

        ClipboardDeadline.sweep(
            context,
            NOW,
            readOwnership = { ClipboardDeadline.currentOwnership(clipboard) },
            primaryReadable = { clipboard.primaryClip?.getItemAt(0)?.text != null },
        )

        assertEquals("", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertFalse(prefs.contains("owner_vault_id"))
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
                    .putString("lease_id", newerLeaseId)
                    .putLong("deadline_ms", newerDeadline)
                    .commit()
                null
            },
            primaryReadable = { error("unobservable metadata must not trigger a content read") },
            clearPrimaryClip = { error("an unobservable clipboard must not be cleared by guess") },
        )

        assertTrue(oldLease.leaseId != newerLeaseId)
        assertEquals(newerLeaseId, prefs.getString("lease_id", null))
        assertEquals(newerDeadline, prefs.getLong("deadline_ms", 0L))
    }

    @Test
    fun aVisibleLeaseWithUnreadableTextRemainsPendingUntilFocusCanVerifyIt() {
        armOwned(LOCKER_CLIP, VAULT_A)

        ClipboardDeadline.clearOwned(
            context,
            VAULT_A,
            nowMs = NOW,
            readOwnership = { ClipboardDeadline.currentOwnership(clipboard) },
            primaryReadable = { false },
            clearPrimaryClip = { error("unreadable clip text must not be cleared by guess") },
        )

        assertEquals(NOW, prefs.getLong("deadline_ms", 0L))
        assertEquals(VAULT_A, prefs.getString("owner_vault_id", null))

        ClipboardDeadline.sweep(
            context,
            NOW,
            readOwnership = { ClipboardDeadline.currentOwnership(clipboard) },
            primaryReadable = { false },
        )
        assertEquals(LOCKER_CLIP, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertEquals(NOW, prefs.getLong("deadline_ms", 0L))
        assertEquals(VAULT_A, prefs.getString("owner_vault_id", null))

        ClipboardDeadline.sweep(
            context,
            NOW,
            readOwnership = { ClipboardDeadline.currentOwnership(clipboard) },
            primaryReadable = { clipboard.primaryClip?.getItemAt(0)?.text != null },
        )

        assertEquals("", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertFalse(prefs.contains("owner_vault_id"))
    }

    @Test
    fun aFailedNewerCopyLeavesNoUntrackedPreviousCopyOnTheClipboard() {
        armOwned(OLD_CLIP, VAULT_A)
        // The newer copy's lease replaces the old one, then its OS write fails and it is discarded.
        val failed = ClipboardDeadline.newLeaseId(VAULT_A, AFTER_MS)
        assertTrue(ClipboardDeadline.persist(context, AFTER_MS, VAULT_A, failed))
        ClipboardDeadline.discard(context, failed)

        assertTrue(ClipboardDeadline.clearOrphanedClip(context))

        assertEquals("", clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        assertFalse(prefs.contains("lease_id"))
    }

    @Test
    fun anOrphanSweepLeavesATrackedCopyAndAnUnrelatedClipAlone() {
        armOwned(NEW_CLIP, VAULT_A)
        assertFalse(ClipboardDeadline.clearOrphanedClip(context))
        assertEquals(NEW_CLIP, clipboard.primaryClip?.getItemAt(0)?.text?.toString())

        prefs.edit().clear().commit()
        clipboard.setPrimaryClip(ClipData.newPlainText("", UNRELATED_CLIP))
        assertFalse(ClipboardDeadline.clearOrphanedClip(context))
        assertEquals(UNRELATED_CLIP, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
    }

    private fun armOwned(text: String, vaultId: String): ClipOwnership {
        val lease = ClipOwnership(ClipboardDeadline.newLeaseId(vaultId, AFTER_MS))
        val clip = ClipData.newPlainText("", text).also { ClipboardDeadline.markOwnedClip(it, lease.leaseId.orEmpty()) }
        assertTrue(ClipboardDeadline.persist(context, AFTER_MS, vaultId, lease.leaseId.orEmpty()))
        clipboard.setPrimaryClip(clip)
        assertTrue(ClipboardDeadline.activate(context, vaultId, lease.leaseId.orEmpty()))
        return lease
    }

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
