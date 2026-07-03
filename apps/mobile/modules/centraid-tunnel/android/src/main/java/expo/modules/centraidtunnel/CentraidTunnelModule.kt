// Expo module surface for the centraid tunnel (issue #263): pairing plus
// lifecycle for the localhost proxy that forwards WebView HTTP over iroh
// QUIC. The JS contract lives in ../index.ts; the wire protocol reference
// is packages/tunnel/src/protocol.ts.

package expo.modules.centraidtunnel

import android.util.Base64
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

class StartArgs : Record {
  @Field val ticket: String = ""
  @Field val secretKeyB64: String = ""
}

class CentraidTunnelModule : Module() {
  private val runtime = TunnelRuntime { payload -> sendEvent("onStatusChange", payload) }

  override fun definition() = ModuleDefinition {
    Name("CentraidTunnel")
    Events("onStatusChange")

    AsyncFunction("generateSecretKey") {
      val bytes = ByteArray(32)
      SecureRandom().nextBytes(bytes)
      Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    AsyncFunction("pairWithDesktop") Coroutine { args: PairArgs ->
      runtime.pair(args)
    }

    AsyncFunction("startTunnel") Coroutine { args: StartArgs ->
      mapOf("port" to runtime.start(args.ticket, args.secretKeyB64))
    }

    AsyncFunction("stopTunnel") Coroutine { ->
      runtime.stop()
    }

    AsyncFunction("getTunnelStatus") Coroutine { ->
      runtime.status()
    }

    OnDestroy {
      runtime.shutdown()
    }
  }
}
