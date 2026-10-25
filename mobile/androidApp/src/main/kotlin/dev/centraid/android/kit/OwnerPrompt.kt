package dev.centraid.android.kit

import android.content.Context
import android.content.ContextWrapper
import android.content.pm.PackageManager
import android.os.Build
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import centraid.core.v1.Biometry
import centraid.core.v1.EffectResult
import centraid.core.v1.OwnerCheck
import centraid.core.v1.OwnerChecked
import kotlinx.coroutines.CompletableDeferred

/**
 * THE PHONE'S OWNER CHECK ON ANDROID (#1047, D-5; #1135): the `OwnerCheck`
 * effect Rust sends, performed through `BiometricPrompt`. Everything here is
 * something Rust cannot do — read the phone's lock, raise the OS prompt — and
 * nothing here decides whether Locker is open: it answers `OwnerChecked` and
 * Rust opens, or does not.
 *
 * The prompt hosts itself in a fragment of the activity it is given, which is
 * why `MainActivity` is a `FragmentActivity`.
 */
internal object OwnerPrompt {
    /**
     * THE AUTHENTICATORS THE PROMPT ALLOWS: the phone's strong biometric, the
     * device credential as its fallback. `BIOMETRIC_STRONG or DEVICE_CREDENTIAL`
     * is a combination `androidx.biometric` refuses on API 28-29 (it throws at
     * `PromptInfo.build()`), so those two levels take the weak class there; the
     * credential fallback is the same, and D-5's gate is presence.
     */
    fun authenticators(): Int =
        if (Build.VERSION.SDK_INT == Build.VERSION_CODES.P || Build.VERSION.SDK_INT == Build.VERSION_CODES.Q) {
            BIOMETRIC_WEAK or DEVICE_CREDENTIAL
        } else {
            BIOMETRIC_STRONG or DEVICE_CREDENTIAL
        }

    /** The activity under a (possibly wrapped) context, or null. */
    fun activityOf(context: Context): FragmentActivity? {
        var current: Context? = context
        while (current is ContextWrapper) {
            if (current is FragmentActivity) return current
            current = current.baseContext
        }
        return null
    }

    /**
     * What this phone can do: a lock is set (`canAuthenticate` with the
     * credential allowed), and which biometric is ENROLLED: face or fingerprint
     * by its sensor, passcode when there is none enrolled.
     */
    private fun capability(context: Context): Pair<Boolean, Biometry> {
        val manager = BiometricManager.from(context)
        val available = manager.canAuthenticate(authenticators()) == BiometricManager.BIOMETRIC_SUCCESS
        val enrolled = manager.canAuthenticate(
            if (authenticators() and BIOMETRIC_WEAK == BIOMETRIC_WEAK) BIOMETRIC_WEAK else BIOMETRIC_STRONG,
        ) == BiometricManager.BIOMETRIC_SUCCESS
        val features = context.packageManager
        val biometry = when {
            !enrolled -> Biometry.BIOMETRY_PASSCODE
            features.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT) -> Biometry.BIOMETRY_FINGERPRINT
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && features.hasSystemFeature(PackageManager.FEATURE_FACE) -> Biometry.BIOMETRY_FACE
            else -> Biometry.BIOMETRY_FINGERPRINT
        }
        return available to biometry
    }

    /**
     * THE EFFECT'S ANSWER. `ask` false only reports what the phone can do; true
     * raises the prompt once and answers its terminal outcome. A single
     * unrecognised touch is not an answer: the prompt stays up and says so itself.
     */
    suspend fun check(context: Context, ask: OwnerCheck): EffectResult {
        val (available, biometry) = capability(context)
        fun answer(outcome: OwnerChecked.Outcome) =
            EffectResult(owner_checked = OwnerChecked(available = available, biometry = biometry, outcome = outcome))
        if (!ask.ask) return answer(OwnerChecked.Outcome.OUTCOME_NOT_ASKED)
        if (!available) return answer(OwnerChecked.Outcome.OUTCOME_UNAVAILABLE)
        val activity = activityOf(context) ?: return answer(OwnerChecked.Outcome.OUTCOME_FAILED)
        val outcome = CompletableDeferred<OwnerChecked.Outcome>()
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                outcome.complete(OwnerChecked.Outcome.OUTCOME_SUCCEEDED)
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                outcome.complete(outcomeOf(errorCode))
            }
        }
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(ask.title.ifEmpty { ask.reason })
            .apply { if (ask.subtitle.isNotEmpty()) setSubtitle(ask.subtitle) }
            // NO NEGATIVE BUTTON: `DEVICE_CREDENTIAL` forbids one; the credential
            // itself is the way out of a biometric that fails.
            .setAllowedAuthenticators(authenticators())
            .build()
        val raised = runCatching {
            // The prompt is the main thread's: this effect is performed from composition's scope.
            BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback).authenticate(info)
        }
        if (raised.isFailure) outcome.complete(OwnerChecked.Outcome.OUTCOME_FAILED)
        return answer(outcome.await())
    }

    /** `BiometricPrompt`'s error codes, as Rust's outcome table names them. */
    fun outcomeOf(errorCode: Int): OwnerChecked.Outcome = when (errorCode) {
        BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON ->
            OwnerChecked.Outcome.OUTCOME_CANCELLED
        BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL, BiometricPrompt.ERROR_HW_NOT_PRESENT ->
            OwnerChecked.Outcome.OUTCOME_UNAVAILABLE
        BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_LOCKOUT_PERMANENT ->
            OwnerChecked.Outcome.OUTCOME_LOCKED_OUT
        else -> OwnerChecked.Outcome.OUTCOME_FAILED
    }
}
