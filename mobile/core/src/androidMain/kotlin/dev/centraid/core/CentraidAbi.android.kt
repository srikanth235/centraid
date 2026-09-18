package dev.centraid.core

import android.os.Looper

/**
 * Android's actuals (#1020, D-1020-E2). Compiled only when
 * `-Pcentraid.android=true` and an Android SDK are both present.
 */
internal actual fun openCentraidAbi(config: String, uiThreadName: String): AbiOpen =
    JnaCentraidAbi.open(config)

/**
 * ANDROID ASKS THE LOOPER, NOT THE THREAD NAME.
 *
 * The main thread is named `main` today and that is not a promise; the
 * `Looper` identity is. A name comparison would also miss the case this
 * assertion exists for — a `LaunchedEffect` body, which runs on the main
 * thread under whatever name the process was given.
 */
internal actual fun assertNotOnUiThread(operation: String, uiThreadName: String) {
    if (Looper.myLooper() != null && Looper.myLooper() == Looper.getMainLooper()) {
        throw UiThreadCallError(Thread.currentThread().name)
    }
}
