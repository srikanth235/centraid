package dev.centraid.android.kit

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import java.util.UUID

/**
 * A SECRET ON THE CLIPBOARD HAS A DEADLINE THAT OUTLIVES THE PROCESS (#1135).
 *
 * The shell's persisted deadline outlives screen-owned callers and the process: a revealed
 * password stayed on the clipboard when the app was killed before its timer fired.
 * `ClipboardSet.clear_after_ms` makes the deadline part of the effect, so this keeps it:
 * [persist] durably commits the deadline, owner vault ID and lease token (never the text, and no
 * digest of it: Locker secrets are often short PINs a stored hash would give away) BEFORE the OS
 * clip is written, so a process death after the write always leaves a lease to sweep. A lease whose
 * clip was never written simply finds no matching token and is spent. The OS clip carries only that
 * random lease token; the token proves ownership, since a clip is immutable once set. An explicit
 * Lock after process recreation can clear its latest copy without Rust retaining the reveal.
 * [activate] schedules expiry while the process lives. [sweep] runs on launch and when the window
 * regains focus. Android can hide clip metadata while this app lacks focus, so cleanup can defer
 * until focus returns. A replacement clip without the matching token is left alone.
 */
internal object ClipboardDeadline {
    private const val PREFS = "centraid.clipboard"
    private const val DEADLINE = "deadline_ms"
    private const val OWNER = "owner_vault_id"
    private const val LEASE = "lease_id"
    /** Older builds persisted an unsalted SHA-256 of the text here; it is deleted on first access. */
    private const val LEGACY_DIGEST = "digest"
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

    /**
     * Durably publish non-plaintext metadata BEFORE the OS clip is written, with the deadline
     * anchored at [issuedAtMs] (taken before the write). Returns false when it could not be saved.
     */
    fun persist(
        context: Context,
        afterMs: Long,
        ownerVaultId: String,
        leaseId: String,
        issuedAtMs: Long = System.currentTimeMillis(),
    ): Boolean {
        val saved = prefs(context)
        val edit = saved.edit().remove(DEADLINE).remove(LEGACY_DIGEST).remove(OWNER).remove(LEASE)
        if (ownerVaultId.isNotBlank() || afterMs > 0L) {
            if (leaseId.isBlank()) return false
            edit.putString(LEASE, leaseId)
            if (ownerVaultId.isNotBlank()) edit.putString(OWNER, ownerVaultId)
            if (afterMs > 0L) edit.putLong(DEADLINE, issuedAtMs + afterMs)
        }
        return edit.commit()
    }

    /** Remove the persisted lease [leaseId] (a copy that did not complete); a newer lease survives. */
    fun discard(context: Context, leaseId: String) {
        if (leaseId.isBlank()) return
        val saved = prefs(context)
        if (saved.getString(LEASE, null) != leaseId) return
        saved.edit().remove(DEADLINE).remove(OWNER).remove(LEASE).commit()
        main.removeCallbacksAndMessages(TOKEN)
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

    /**
     * Clear a clip that carries a Centraid lease marker no persisted lease tracks any more. Only
     * leased copies carry the marker, so such a clip is a secret nothing would ever expire: e.g. the
     * previous copy, whose lease a failed newer copy replaced before its own OS write failed.
     */
    fun clearOrphanedClip(context: Context): Boolean {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val marker = currentOwnership(manager)?.leaseId ?: return false
        if (marker.isBlank() || marker == prefs(context).getString(LEASE, null)) return false
        manager.setPrimaryClip(ClipData.newPlainText("", ""))
        return true
    }

    /** Clear only the clip the core named, and only its matching persisted deadline. */
    fun clearIfMatches(context: Context, expectedText: String) {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clearIfMatches(
            context,
            expectedText,
            readPrimaryText = { manager.primaryClip?.getItemAt(0)?.text?.toString() },
            clearPrimaryClip = { manager.setPrimaryClip(ClipData.newPlainText("", "")) },
        )
    }

    internal fun clearIfMatches(
        context: Context,
        expectedText: String,
        readPrimaryText: () -> String?,
        clearPrimaryClip: () -> Unit,
    ) {
        // A Locker lease is cleared by its typed, vault-owned Lock effect. The older text-bearing
        // timer effect has no vault identity, so it must not clear a same-text copy from another vault.
        val saved = prefs(context)
        if (saved.getString(OWNER, null) != null) return
        // An unreadable clip, or one holding other text, is not the copy this effect named. The
        // latest copy always owns the persisted lease, so only a match may spend it.
        val held = readPrimaryText() ?: return
        if (held != expectedText) return
        clearPrimaryClip()
        val lease = saved.getString(LEASE, null) ?: return
        spendLease(context, null, lease)
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
            primaryReadable = { manager.primaryClip?.getItemAt(0)?.text != null },
            clearPrimaryClip = { manager.setPrimaryClip(ClipData.newPlainText("", "")) },
        )
    }

    /** Injectable form keeps ownership, replacement, and unreadable-read cases deterministic in tests. */
    internal fun clearOwned(
        context: Context,
        ownerVaultId: String,
        nowMs: Long,
        readOwnership: () -> ClipOwnership?,
        primaryReadable: () -> Boolean,
        clearPrimaryClip: () -> Unit,
    ) {
        if (ownerVaultId.isBlank()) return
        val saved = prefs(context)
        val expectedLease = saved.getString(LEASE, null) ?: return
        if (saved.getString(OWNER, null) != ownerVaultId) return

        val held = readOwnership() ?: run {
            markDueNow(context, nowMs, ownerVaultId, expectedLease)
            return
        }
        if (held.leaseId == expectedLease) {
            if (!primaryReadable()) {
                markDueNow(context, nowMs, ownerVaultId, expectedLease)
                return
            }
            val stillOwned = readOwnership()?.leaseId == expectedLease
            if (stillOwned) clearPrimaryClip()
        }
        // A different or untagged current clip replaced this app's lease. Do not read or clear its
        // text; retire only the exact lease we observed so a concurrent newer copy survives.
        spendLease(context, ownerVaultId, expectedLease)
    }

    /** Clear a stale clip: the deadline passed and the clipboard still holds what we put there. */
    fun sweep(context: Context) {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        sweep(
            context,
            System.currentTimeMillis(),
            readOwnership = { currentOwnership(manager) },
            primaryReadable = { manager.primaryClip?.getItemAt(0)?.text != null },
        )
    }

    internal fun sweep(
        context: Context,
        nowMs: Long,
        readOwnership: () -> ClipOwnership?,
        primaryReadable: () -> Boolean,
    ) {
        val saved = prefs(context)
        val deadline = saved.getLong(DEADLINE, 0L)
        val expectedLease = saved.getString(LEASE, null)
        if (deadline == 0L || expectedLease == null) return
        if (nowMs < deadline) {
            val remaining = deadline - nowMs
            main.removeCallbacksAndMessages(TOKEN)
            main.postAtTime({ sweep(context) }, TOKEN, android.os.SystemClock.uptimeMillis() + remaining)
            return
        }
        val ownerVaultId = saved.getString(OWNER, null)
        // No visible metadata: Android may be hiding it while unfocused. Keep the due lease for
        // the next focus sweep instead of spending cleanup we could not verify.
        val held = readOwnership() ?: return
        if (held.leaseId == expectedLease) {
            // Metadata can be visible while the clip's content is withheld; wait for focus.
            if (!primaryReadable()) return
            if (readOwnership()?.leaseId == expectedLease) {
                val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                manager.setPrimaryClip(ClipData.newPlainText("", ""))
            }
        }
        // Whether we cleared it, or the token never reached the clipboard (the process died
        // between the lease and the write) or a newer clip replaced it, the lease is now spent.
        spendLease(context, ownerVaultId, expectedLease)
    }

    private fun spendLease(context: Context, expectedOwner: String?, expectedLease: String) {
        val saved = prefs(context)
        if (saved.getString(OWNER, null) != expectedOwner || saved.getString(LEASE, null) != expectedLease) return
        saved.edit().remove(DEADLINE).remove(OWNER).remove(LEASE).apply()
        main.removeCallbacksAndMessages(TOKEN)
    }

    private fun markDueNow(context: Context, nowMs: Long, expectedOwner: String, expectedLease: String) {
        val saved = prefs(context)
        if (saved.getString(OWNER, null) != expectedOwner || saved.getString(LEASE, null) != expectedLease) return
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

    /** The preferences, with any digest an older build persisted deleted (and its lease, unverifiable, dropped). */
    private fun prefs(context: Context): SharedPreferences {
        val saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (saved.contains(LEGACY_DIGEST)) {
            val edit = saved.edit().remove(LEGACY_DIGEST)
            if (!saved.contains(LEASE)) edit.remove(DEADLINE).remove(OWNER)
            edit.commit()
        }
        return saved
    }

    private val TOKEN = Any()
}

internal data class ClipOwnership(val leaseId: String?)
