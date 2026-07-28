// Expo module surface for the centraid tunnel (issue #263): pairing plus
// lifecycle for the localhost proxy that forwards WebView HTTP over iroh
// QUIC. The JS contract lives in ../index.ts; the wire protocol reference
// is packages/tunnel/src/protocol.ts.

package expo.modules.centraidtunnel

import android.util.Base64
import computer.iroh.IrohAndroid
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.security.SecureRandom

class PairArgs : Record {
  @Field val ticket: String = ""
  @Field val code: String = ""
  @Field val deviceName: String = ""
  @Field val platform: String = ""
  @Field val secretKeyB64: String = ""
}

/** Headless gateway ticket redemption (`centraid/gw-pair/1`). */
class GatewayPairArgs : Record {
  @Field val ticket: String = ""
  @Field val ticketId: String = ""
  @Field val secret: String = ""
  @Field val deviceName: String = ""
  @Field val platform: String = ""
  @Field val secretKeyB64: String = ""
}

class StartArgs : Record {
  @Field val ticket: String = ""
  @Field val secretKeyB64: String = ""
}

class CentraidTunnelModule : Module() {
  // Expo Module gained its own `runtime` member. Keep the tunnel lifecycle
  // explicitly named so dependency upgrades cannot turn this into a hidden
  // member/override collision at Kotlin compile time.
  private val tunnelRuntime = TunnelRuntime { payload -> sendEvent("onStatusChange", payload) }

  override fun definition() = ModuleDefinition {
    Name("CentraidTunnel")
    Events("onStatusChange")

    OnCreate {
      // iroh's Android DNS resolver reads LinkProperties via JNI, so the
      // process JavaVM + Application context must be installed before any
      // Endpoint is constructed. Idempotent — subsequent calls are no-ops.
      appContext.reactContext?.applicationContext?.let {
        IrohAndroid.installAndroidContext(it)
      }
    }

    AsyncFunction("generateSecretKey") {
      val bytes = ByteArray(32)
      SecureRandom().nextBytes(bytes)
      Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    AsyncFunction("pairWithDesktop") Coroutine { args: PairArgs ->
      tunnelRuntime.pair(args)
    }

    AsyncFunction("pairWithGateway") Coroutine { args: GatewayPairArgs ->
      tunnelRuntime.pairGateway(args)
    }

    AsyncFunction("startTunnel") Coroutine { args: StartArgs ->
      mapOf("port" to tunnelRuntime.start(args.ticket, args.secretKeyB64))
    }

    AsyncFunction("stopTunnel") Coroutine { ->
      tunnelRuntime.stop()
    }

    AsyncFunction("getTunnelStatus") Coroutine { ->
      tunnelRuntime.status()
    }

    OnDestroy {
      tunnelRuntime.shutdown()
    }
  }
}
