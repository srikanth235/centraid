package dev.centraid.android.kit

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import java.security.MessageDigest
import java.util.UUID

/**
 * A SECRET ON THE CLIPBOARD HAS A DEADLINE THAT OUTLIVES THE PROCESS (#1135).
 *
 * The shell's persisted deadline outlives screen-owned callers and the process: a revealed
 * password stayed on the clipboard when the app was killed before its timer fired.
 * `ClipboardSet.clear_after_ms` makes the deadline part of the effect, so this keeps it:
 * [persist] durably commits the deadline, owner vault ID and a digest of the text (never the text)
 * before this shell reports the copy complete. The OS clip carries only a random lease token, so
 * an explicit Lock after process recreation can clear its latest copy without Rust retaining the
 * reveal. [activate] schedules expiry while the process lives. [sweep] runs on launch and when the
 * window regains focus. Android can hide clip metadata while this app lacks focus, so cleanup can
 * defer until focus returns. A replacement clip without the matching token is left alone.
 */
internal object ClipboardDeadline {
    private const val PREFS = "centraid.clipboard"
    private const val DEADLINE = "deadline_ms"
    private const val DIGEST = "digest"
    private const val OWNER = "owner_vault_id"
    private const val LEASE = "lease_id"
    private const val CLIP_LEASE = "dev.centraid.clipboard.lease"

    private val main = Handler(Looper.getMainLooper())

    /** A random, non-plaintext marker binds Android's current clip to its persisted lease. */
    fun newLeaseId(ownerVaultId: String, afterMs: Long): String =
        if (ownerVaultId.isBlank() && afterMs <= 0L) "" else UUID.randomUUID().toString()

    fun markOwnedClip(clip: ClipData, leaseId: String) {
        if (leaseId.isBlank()) return
        clip.description.extras = (clip.description.extras ?: PersistableBundle()).apply {
            putString(CLIP_LEASE, leaseId)
        }
    }

    /** Durably publish non-plaintext metadata before the effect reports a completed copy. */
    fun persist(
        context: Context,
        text: String,
        afterMs: Long,
        ownerVaultId: String,
        leaseId: String,
        issuedAtMs: Long = System.currentTimeMillis(),
    ): Boolean {
        val saved = prefs(context)
        val edit = saved.edit().remove(DEADLINE).remove(DIGEST).remove(OWNER).remove(LEASE)
        if (ownerVaultId.isNotBlank() || afterMs > 0L) {
            edit.putString(DIGEST, digest(text))
            if (leaseId.isNotBlank()) edit.putString(LEASE, leaseId)
            if (ownerVaultId.isNotBlank()) {
                if (leaseId.isBlank()) return false
                edit.putString(OWNER, ownerVaultId)
            }
            if (afterMs > 0L) edit.putLong(DEADLINE, issuedAtMs + afterMs)
        }
        return edit.commit()
    }

    /** Test/setup convenience: publish, then schedule from the persisted original deadline. */
    fun armed(context: Context, text: String, afterMs: Long, ownerVaultId: String = "", leaseId: String = ""): Boolean {
        if (!persist(context, text, afterMs, ownerVaultId, leaseId)) return false
        activate(context)
        return true
    }

    /** Start the in-process timer only after the matching clip has been installed in Android. */
    fun activate(context: Context) {
        schedule(context, prefs(context).getLong(DEADLINE, 0L))
    }

    /** Verify the just-published lease still exists and schedule its unchanged deadline. */
    fun activate(context: Context, ownerVaultId: String, leaseId: String): Boolean {
        val saved = prefs(context)
        if (leaseId.isBlank() || saved.getString(LEASE, null) != leaseId) return false
        if (saved.getString(OWNER, null) != ownerVaultId.takeIf { it.isNotBlank() }) return false
        val deadline = saved.getLong(DEADLINE, 0L)
        if (deadline > 0L && System.currentTimeMillis() >= deadline) {
            sweep(context)
            return false
        }
        schedule(context, deadline)
        return true
    }

    private fun schedule(context: Context, deadline: Long) {
        main.removeCallbacksAndMessages(TOKEN)
        if (deadline > 0L) {
            val remaining = (deadline - System.currentTimeMillis()).coerceAtLeast(0L)
            main.postAtTime({ sweep(context) }, TOKEN, android.os.SystemClock.uptimeMillis() + remaining)
        }
    }

    /** A failed platform set removes only the lease token that this effect installed. */
    fun clearClipIfLeaseMatches(context: Context, leaseId: String): Boolean {
        if (leaseId.isBlank()) return false
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        if (manager.primaryClipDescription?.let(::ownership)?.leaseId != leaseId) return false
        manager.setPrimaryClip(ClipData.newPlainText("", ""))
        return true
    }

    /** Clear only the clip the core named, and only its matching persisted deadline. */
    fun clearIfMatches(context: Context, expectedText: String) {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clearIfMatches(
            context,
            expectedText,
            nowMs = System.currentTimeMillis(),
            readPrimaryText = { manager.primaryClip?.getItemAt(0)?.text?.toString() },
            clearPrimaryClip = { manager.setPrimaryClip(ClipData.newPlainText("", "")) },
        )
    }

    internal fun clearIfMatches(
        context: Context,
        expectedText: String,
        nowMs: Long,
        readPrimaryText: () -> String?,
        clearPrimaryClip: () -> Unit,
    ) {
        // A Locker lease is cleared by its typed, vault-owned Lock effect. The older text-bearing
        // timer effect has no vault identity, so it must not clear a same-text copy from another vault.
        if (prefs(context).getString(OWNER, null) != null) return
        val held = readPrimaryText() ?: run {
            markDueNow(context, digest(expectedText), nowMs)
            return
        }
        if (held == expectedText) clearPrimaryClip()
        spent(context, expectedText)
    }

    /** A clear for an older value must not spend a newer clip's deadline. */
    fun spent(context: Context, expectedText: String) {
        spendDigest(context, digest(expectedText))
    }

    /** Explicit Lock: clear only the latest OS clip lease owned by [ownerVaultId]. */
    fun clearOwned(context: Context, ownerVaultId: String) {
        if (ownerVaultId.isBlank()) return
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clearOwned(
            context = context,
            ownerVaultId = ownerVaultId,
            nowMs = System.currentTimeMillis(),
            readOwnership = { currentOwnership(manager) },
            readPrimaryDigest = { manager.primaryClip?.getItemAt(0)?.text?.toString()?.let(::digest) },
            clearPrimaryClip = { manager.setPrimaryClip(ClipData.newPlainText("", "")) },
        )
    }

    /** Injectable form keeps ownership, replacement, and unreadable-read cases deterministic in tests. */
    internal fun clearOwned(
        context: Context,
        ownerVaultId: String,
        nowMs: Long,
        readOwnership: () -> ClipOwnership?,
        readPrimaryDigest: () -> String?,
        clearPrimaryClip: () -> Unit,
    ) {
        if (ownerVaultId.isBlank()) return
        val saved = prefs(context)
        val expectedDigest = saved.getString(DIGEST, null) ?: return
        if (saved.getString(OWNER, null) != ownerVaultId) return
        val expectedLease = saved.getString(LEASE, null)

        val held = readOwnership() ?: run {
            markDueNow(context, expectedDigest, nowMs, ownerVaultId, expectedLease)
            return
        }
        if (expectedLease != null && held.leaseId == expectedLease) {
            val currentDigest = readPrimaryDigest()
            if (currentDigest == null) {
                markDueNow(context, expectedDigest, nowMs, ownerVaultId, expectedLease)
                return
            }
            val stillOwned = readOwnership()?.leaseId == expectedLease
            if (stillOwned && currentDigest == expectedDigest) clearPrimaryClip()
        }
        // A different or untagged current clip replaced this app's lease. Do not read or clear its
        // text; retire only the exact owner/digest we observed so a concurrent newer copy survives.
        spendLease(context, ownerVaultId, expectedDigest, expectedLease)
    }

    /** Clear a stale clip: the deadline passed and the clipboard still holds what we put there. */
    fun sweep(context: Context) {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        sweep(
            context,
            System.currentTimeMillis(),
            readPrimaryText = { manager.primaryClip?.getItemAt(0)?.text?.toString() },
            readOwnership = { currentOwnership(manager) },
            readPrimaryDigest = { manager.primaryClip?.getItemAt(0)?.text?.toString()?.let(::digest) },
        )
    }

    internal fun sweep(context: Context, nowMs: Long, readPrimaryText: () -> String?) {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        sweep(
            context,
            nowMs,
            readPrimaryText,
            readOwnership = { currentOwnership(manager) },
            readPrimaryDigest = { manager.primaryClip?.getItemAt(0)?.text?.toString()?.let(::digest) },
        )
    }

    internal fun sweep(
        context: Context,
        nowMs: Long,
        readPrimaryText: () -> String?,
        readOwnership: () -> ClipOwnership?,
        readPrimaryDigest: () -> String?,
    ) {
        val saved = prefs(context)
        val deadline = saved.getLong(DEADLINE, 0L)
        val digest = saved.getString(DIGEST, null)
        if (deadline == 0L || digest == null) return
        if (nowMs < deadline) {
            val remaining = deadline - nowMs
            main.removeCallbacksAndMessages(TOKEN)
            main.postAtTime({ sweep(context) }, TOKEN, android.os.SystemClock.uptimeMillis() + remaining)
            return
        }
        val ownerVaultId = saved.getString(OWNER, null)
        val expectedLease = saved.getString(LEASE, null)
        if (expectedLease != null) {
            val held = readOwnership() ?: return
            if (held.leaseId == expectedLease) {
                val currentDigest = readPrimaryDigest()
                // Android can expose clip metadata while withholding its text. Keep the due lease
                // for the next focus sweep instead of spending cleanup we could not verify.
                if (currentDigest == null) return
                val stillOwned = readOwnership()?.leaseId == expectedLease
                if (stillOwned && currentDigest == digest) {
                    val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    manager.setPrimaryClip(ClipData.newPlainText("", ""))
                }
            }
            if (ownerVaultId != null) {
                spendLease(context, ownerVaultId, digest, expectedLease)
            } else {
                spendTimedLease(context, digest, expectedLease)
            }
            return
        }
        if (ownerVaultId != null) return
        val held = readPrimaryText() ?: return
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        if (digest(held) == digest) {
            manager.setPrimaryClip(ClipData.newPlainText("", ""))
        }
        // This sweep may have observed an old deadline before a newer clip was armed.
        spendDigest(context, digest)
    }

    private fun spendDigest(context: Context, expectedDigest: String) {
        val saved = prefs(context)
        if (saved.getString(DIGEST, null) != expectedDigest) return
        saved.edit().remove(DEADLINE).remove(DIGEST).remove(OWNER).remove(LEASE).apply()
        main.removeCallbacksAndMessages(TOKEN)
    }

    private fun spendLease(
        context: Context,
        ownerVaultId: String,
        expectedDigest: String,
        expectedLease: String? = null,
    ) {
        val saved = prefs(context)
        if (saved.getString(OWNER, null) != ownerVaultId || saved.getString(DIGEST, null) != expectedDigest) return
        if (expectedLease != null && saved.getString(LEASE, null) != expectedLease) return
        saved.edit().remove(DEADLINE).remove(DIGEST).remove(OWNER).remove(LEASE).apply()
        main.removeCallbacksAndMessages(TOKEN)
    }

    private fun spendTimedLease(context: Context, expectedDigest: String, expectedLease: String) {
        val saved = prefs(context)
        if (saved.getString(OWNER, null) != null ||
            saved.getString(DIGEST, null) != expectedDigest ||
            saved.getString(LEASE, null) != expectedLease
        ) return
        saved.edit().remove(DEADLINE).remove(DIGEST).remove(LEASE).apply()
        main.removeCallbacksAndMessages(TOKEN)
    }

    private fun markDueNow(
        context: Context,
        expectedDigest: String,
        nowMs: Long,
        expectedOwner: String? = null,
        expectedLease: String? = null,
    ) {
        val saved = prefs(context)
        if (saved.getString(DIGEST, null) != expectedDigest) return
        if (expectedOwner != null &&
            (saved.getString(OWNER, null) != expectedOwner || saved.getString(LEASE, null) != expectedLease)
        ) return
        saved.edit().putLong(DEADLINE, nowMs).apply()
        main.removeCallbacksAndMessages(TOKEN)
        main.postAtTime({ sweep(context) }, TOKEN, android.os.SystemClock.uptimeMillis())
    }

    internal fun ownership(description: ClipDescription): ClipOwnership {
        val extras = description.extras
        return ClipOwnership(extras?.getString(CLIP_LEASE))
    }

    /** Read only OS clip metadata; callers fetch content only after this token matches. */
    internal fun currentOwnership(manager: ClipboardManager): ClipOwnership? =
        manager.primaryClipDescription?.let(::ownership)

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun digest(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }

    private val TOKEN = Any()
}

internal data class ClipOwnership(val leaseId: String?)
