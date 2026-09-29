package dev.centraid.android.screens.locker

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import centraid.screen.v1.LockerBiometry
import centraid.screen.v1.LockerClipboard
import centraid.screen.v1.LockerLockEvent
import centraid.screen.v1.LockerPrompt

/**
 * LOCKER'S PLATFORM SEAM ON ANDROID (#1047, D-5; `LockerLockBridge`'s four
 * duties). Everything here is something a shared machine cannot do — read the
 * phone's lock, raise the OS prompt, put a value on the clipboard — and
 * nothing here decides a phase, a word or whether Locker is open.
 */
internal object LockerSeam {
    /**
     * THE AUTHENTICATORS THE PROMPT ALLOWS: the phone's strong biometric, the
     * device credential as its fallback. `BIOMETRIC_STRONG or DEVICE_CREDENTIAL`
     * is a combination `androidx.biometric` refuses on API 28–29 (it throws at
     * `PromptInfo.build()`), so those two levels take the weak class there —
     * the credential fallback is the same, and D-5's gate is presence.
     */
    fun authenticators(): Int =
        if (Build.VERSION.SDK_INT == Build.VERSION_CODES.P || Build.VERSION.SDK_INT == Build.VERSION_CODES.Q) {
            BIOMETRIC_WEAK or DEVICE_CREDENTIAL
        } else {
            BIOMETRIC_STRONG or DEVICE_CREDENTIAL
        }

    /**
     * `Attached(available, biometry)`: a lock is set (`canAuthenticate` with the
     * credential allowed), and which biometric the phone has ENROLLED — FACE or
     * FINGERPRINT by its sensor, PASSCODE when there is none enrolled.
     */
    fun attached(context: Context): LockerLockEvent {
        val manager = BiometricManager.from(context)
        val available = manager.canAuthenticate(authenticators()) == BiometricManager.BIOMETRIC_SUCCESS
        val enrolled = manager.canAuthenticate(
            if (authenticators() and BIOMETRIC_WEAK == BIOMETRIC_WEAK) BIOMETRIC_WEAK else BIOMETRIC_STRONG,
        ) == BiometricManager.BIOMETRIC_SUCCESS
        val features = context.packageManager
        val biometry = when {
            !enrolled -> LockerBiometry.LOCKER_BIOMETRY_PASSCODE
            features.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT) -> LockerBiometry.LOCKER_BIOMETRY_FINGERPRINT
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && features.hasSystemFeature(PackageManager.FEATURE_FACE) ->
                LockerBiometry.LOCKER_BIOMETRY_FACE
            else -> LockerBiometry.LOCKER_BIOMETRY_FINGERPRINT
        }
        return LockerLockEvent(attached = LockerLockEvent.Attached(available = available, biometry = biometry))
    }

    /**
     * THE OS PROMPT, once for [prompt]'s token. The callback answers
     * `PromptAnswered(token, outcome)` exactly once: a single unrecognised
     * touch (`onAuthenticationFailed`) is not an answer — the prompt stays up
     * and says so itself — only success or a terminal error is.
     */
    fun raise(
        activity: FragmentActivity,
        prompt: LockerPrompt,
        onAnswer: (LockerLockEvent.PromptAnswered.Outcome) -> Unit,
    ) {
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                onAnswer(LockerLockEvent.PromptAnswered.Outcome.OUTCOME_SUCCEEDED)
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                onAnswer(outcomeOf(errorCode))
            }
        }
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(prompt.title)
            .apply { if (prompt.subtitle.isNotEmpty()) setSubtitle(prompt.subtitle) }
            // NO NEGATIVE BUTTON: `DEVICE_CREDENTIAL` forbids one; the
            // credential itself is the way out of a biometric that fails.
            .setAllowedAuthenticators(authenticators())
            .build()
        val raised = runCatching {
            BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback).authenticate(info)
        }
        if (raised.isFailure) onAnswer(LockerLockEvent.PromptAnswered.Outcome.OUTCOME_FAILED)
    }

    /** `BiometricPrompt`'s error codes, as the seam's table maps them. */
    fun outcomeOf(errorCode: Int): LockerLockEvent.PromptAnswered.Outcome = when (errorCode) {
        BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON ->
            LockerLockEvent.PromptAnswered.Outcome.OUTCOME_CANCELLED
        BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL, BiometricPrompt.ERROR_HW_NOT_PRESENT ->
            LockerLockEvent.PromptAnswered.Outcome.OUTCOME_UNAVAILABLE
        BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_LOCKOUT_PERMANENT ->
            LockerLockEvent.PromptAnswered.Outcome.OUTCOME_LOCKED_OUT
        else -> LockerLockEvent.PromptAnswered.Outcome.OUTCOME_FAILED
    }

    /**
     * PUT [clip] ON THE CLIPBOARD. A sensitive value is marked
     * `EXTRA_IS_SENSITIVE` (Android 13's clipboard preview shows dots, and the
     * keyboard's clipboard strip does not offer it) and is cleared after
     * `expires_in_ms` — only if what is on the clipboard then is still this
     * copy, so a member's own later copy is never wiped.
     */
    fun copy(context: Context, clip: LockerClipboard) {
        val manager = context.getSystemService(ClipboardManager::class.java) ?: return
        val data = ClipData.newPlainText("", clip.value_)
        val mark = "centraid-locker-${clip.token}"
        data.description.extras = PersistableBundle().apply {
            if (clip.sensitive) putBoolean(EXTRA_IS_SENSITIVE, true)
            putString(EXTRA_MARK, mark)
        }
        runCatching { manager.setPrimaryClip(data) }
        lastMark = mark
        if (clip.sensitive && clip.expires_in_ms > 0L) {
            val app = context.applicationContext
            Handler(Looper.getMainLooper()).postDelayed(
                { clear(app, mark) },
                clip.expires_in_ms,
            )
        }
    }

    /**
     * THE WALL'S `clipboard_clear` (the member locked): take Locker's last
     * copy off the clipboard, if it is still the one there.
     */
    fun clearOwn(context: Context) {
        val mark = lastMark ?: return
        lastMark = null
        clear(context.applicationContext, mark)
    }

    /** The mark of the last copy Locker made in this process, or null. */
    private var lastMark: String? = null

    private fun clear(context: Context, mark: String) {
        val manager = context.getSystemService(ClipboardManager::class.java) ?: return
        runCatching {
            // Reading the description (not the text) of our own clip: when
            // the platform will not say (Android 10+ in the background), the
            // copy is cleared anyway — a secret left on the clipboard is the
            // worse failure. A description that IS readable and carries no
            // mark, or another copy's, is the member's own later copy.
            val description = manager.primaryClipDescription
            val ours = description == null || description.extras?.getString(EXTRA_MARK) == mark
            if (ours) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    manager.clearPrimaryClip()
                } else {
                    manager.setPrimaryClip(ClipData.newPlainText("", ""))
                }
            }
        }
    }

    /** `ClipDescription.EXTRA_IS_SENSITIVE`, spelt out: the constant is API 33. */
    private const val EXTRA_IS_SENSITIVE: String = "android.content.extra.IS_SENSITIVE"

    private const val EXTRA_MARK: String = "dev.centraid.locker.copy"
}

/**
 * A SCREEN'S CLIPBOARD INTENT, performed once per token and answered: the
 * value goes on the clipboard, then [onDone] sends the screen's
 * `ClipboardDone(token)`, which drops the value from the state.
 */
@Composable
internal fun LockerClipboardEffect(clipboard: LockerClipboard?, onDone: (Long) -> Unit) {
    val context = LocalContext.current
    val done = rememberUpdatedState(onDone)
    val token = clipboard?.token ?: 0L
    LaunchedEffect(token) {
        val clip = clipboard ?: return@LaunchedEffect
        if (clip.token == 0L) return@LaunchedEffect
        LockerSeam.copy(context, clip)
        done.value(clip.token)
    }
}
