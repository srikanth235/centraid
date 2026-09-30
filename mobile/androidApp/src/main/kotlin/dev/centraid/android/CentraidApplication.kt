package dev.centraid.android

import android.app.Application
import dev.centraid.shared.platform.AndroidPlatform

/**
 * ONE CORE PER DEVICE PROCESS, and the one place the context is handed over
 * (#1020, R-1020-24).
 *
 * The `Application` installs the context and nothing else. In particular it
 * does NOT open the core: `dev.centraid.core.CentraidCore.open` refuses a
 * second handle in the same process, and an `Application.onCreate` that opened
 * one would make every Share, Autofill and Widget process — which share this
 * class — an opener. Those processes never open the vault and never start iroh,
 * which is the v1 form of v0's lease sidecar.
 */
public class CentraidApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        AndroidPlatform.install(this)
    }
}
