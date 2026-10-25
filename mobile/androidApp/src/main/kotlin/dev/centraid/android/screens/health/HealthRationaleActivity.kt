package dev.centraid.android.screens.health

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.centraid.android.MainActivity

/**
 * "WHAT HEALTH MAY READ", FOR HEALTH CONNECT (#1129, #1135). Health Connect lists an app's
 * permissions only when the app says where its rationale lives; the manifest points both the
 * Android 13 action and the Android 14 permission-usage alias here. Health's words are Rust's
 * (`health.connect`: the lede and the list of types), so this draws none of its own: it asks the
 * app to open that page ([HealthRationale.requested], taken by `RustRoot`) and comes forward.
 * Nothing is asked of the OS until the member taps Connect there.
 */
public class HealthRationaleActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        HealthRationale.requested = true
        startActivity(
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        )
        finish()
    }
}

/** A request for Health's Connect page from outside the app, until the host takes it. */
internal object HealthRationale {
    /** Read by composition; set by [HealthRationaleActivity]. */
    var requested: Boolean by mutableStateOf(false)
}
