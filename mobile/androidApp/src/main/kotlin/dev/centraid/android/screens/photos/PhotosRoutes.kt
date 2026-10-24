package dev.centraid.android.screens.photos

import androidx.compose.runtime.Composable
import dev.centraid.android.screens.AppRoutes
import dev.centraid.android.screens.RouteNav
import dev.centraid.shared.nav.PhotosEntry
import dev.centraid.shared.shell.PhotosDevice
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * THE PHOTOS MINIAPP'S ROUTES (#1029, photos port): the library and its
 * nine pushed screens, moved out of `MainActivity` unchanged (K5).
 *
 * **The nine are held as BRIDGES and not as bare [ScreenHost]s.** Compose
 * collects the grid's host directly, but a screen with more than one read has
 * nothing to hand `attachScreen`:
 *
 * * **Collections and Search have no `ScreenReads` at all.** Their reads are a
 *   FAN-OUT folded into one state; the trip lives in the bridge and
 *   `changes.route(host)` is what it calls instead.
 * * **The lightbox, Duplicates and Duplicate review carry LEGS whose
 *   constructors are `internal`** to `:shared`, so only the bridge can write
 *   `attachReads(host, PhotoLightboxLeg(leg))`.
 *
 * One instance per screen for the life of the activity, never re-created:
 * `ChangeStream.route` is registration with no removal, so a second host would
 * leave the routed one drawing into nothing.
 */
public class PhotosRoutes(private val cacheDir: java.io.File) : AppRoutes {
    /**
     * THE DEVICE'S HALF OF PHOTOS: the camera roll (walked once PER VAULT), free up
     * space and an original back from the gateway. Held so the Photos screen's
     * remedies have something to call (#1025 S6).
     */
    private val device = PhotosDevice()

    /** Photos' screens that Rust owns (#1135): the home, and whatever joins it. */
    private val rust = PhotosRustHost(device)

    override fun handles(destination: Destination): Boolean = rust.handles(destination)

    override fun opens(moveId: String): Destination? = if (moveId == "photos") PhotosEntry.home() else null

    /**
     * A VAULT WAS JUST MADE and the system's photo prompt was answered
     * (R-ONBOARD-8): read the grant and, when it allows, bring the camera roll
     * in. The prompt itself is the activity's launcher.
     */
    public fun photosAnswered(scope: CoroutineScope) {
        device.perform(PhotosDevice.ACTION_ASK_PERMISSION)
    }

    override fun attach(session: HomeSession, scope: CoroutineScope) {
        // THE CAMERA ROLL FIRST: the screen is told its grant as it opens. **Called
        // exactly once**, because attaching routes a host onto the change stream.
        device.attach(session)
        rust.attach(session, scope)
    }

    /**
     * THE BAND IS THE SPECIAL CASE, and it is doctrine 1 read backwards. Moving to
     * Collections is not a push, so there is no entry for back to pop — back returns
     * the screen to its library rather than popping Photos whole.
     */
    override fun back(stack: NavStack, scope: CoroutineScope): NavStack? = rust.back(stack, scope)

    @Composable
    override fun Global(nav: RouteNav) {
        rust.Global(nav)
    }

    @Composable
    override fun Routes(destination: Destination, nav: RouteNav) {
        when (destination) {
            is Destination.RustScreen -> rust.Routes(destination, nav)

            else -> Unit
        }
    }
}
