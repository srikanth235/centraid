// Tunnel lifecycle state machine (issue #263). Mutations are serialized by
// a mutex: JS calls arrive on Expo's module coroutine dispatcher while
// proxy sockets call in from Dispatchers.IO.

package expo.modules.centraidtunnel

import android.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class TunnelException(message: String) : Exception(message)

class TunnelRuntime(private val emitStatus: (Map<String, Any?>) -> Unit) {
  private enum class State(val wire: String) {
    STOPPED("stopped"), STARTING("starting"), RUNNING("running"), ERROR("error")
  }

  private val mutex = Mutex()
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private var state = State.STOPPED
  private var port: Int? = null
  private var lastError: String? = null
  private var transport: TunnelTransport? = null
  private var proxy: TunnelProxy? = null

  suspend fun status(): Map<String, Any?> = mutex.withLock { snapshot() }

  /**
   * Pairing rides its own short-lived endpoint, so it works whether or not
   * the tunnel is running. Transport failures fold into `{ok: false,
   * error}` — the TS contract keeps one error path for dial and
   * desktop-side rejections alike.
   */
  suspend fun pair(args: PairArgs): Map<String, Any?> =
    try {
      val key = decodeSecretKey(args.secretKeyB64)
      TunnelTransport.pair(key, args.ticket, args.code, args.deviceName, args.platform)
    } catch (err: Throwable) {
      mapOf("ok" to false, "error" to describe(err))
    }

  /** Idempotent while running: returns the already-bound proxy port. */
  suspend fun start(ticket: String, secretKeyB64: String): Int = mutex.withLock {
    if (state == State.RUNNING) {
      return port ?: throw TunnelException("tunnel is running without a bound port")
    }
    transition(State.STARTING)
    try {
      val key = decodeSecretKey(secretKeyB64)
      val boundTransport = TunnelTransport.bind(key, ticket)
      try {
        // The desktop is NOT dialed here — the first proxied request dials
        // lazily, and a dead connection is redialed the same way.
        val boundProxy = TunnelProxy { boundTransport.openTunnelStream() }
        val boundPort = boundProxy.start()
        transport = boundTransport
        proxy = boundProxy
        port = boundPort
        transition(State.RUNNING)
        boundPort
      } catch (err: Throwable) {
        boundTransport.close()
        throw err
      }
    } catch (err: Throwable) {
      transition(State.ERROR, describe(err))
      throw err
    }
  }

  suspend fun stop(): Unit = mutex.withLock {
    proxy?.stop()
    proxy = null
    transport?.close()
    transport = null
    port = null
    transition(State.STOPPED)
  }

  /** OnDestroy is synchronous; tear down in the runtime's own scope. */
  fun shutdown() {
    scope.launch { stop() }
  }

  /** Every transition emits a status event; `error` only survives in ERROR. */
  private fun transition(newState: State, error: String? = null) {
    state = newState
    lastError = error
    emitStatus(snapshot())
  }

  private fun snapshot(): Map<String, Any?> = buildMap {
    put("state", state.wire)
    port?.let { put("port", it) }
    lastError?.let { put("error", it) }
  }

  private fun decodeSecretKey(b64: String): ByteArray {
    val key = try {
      Base64.decode(b64, Base64.DEFAULT)
    } catch (err: IllegalArgumentException) {
      throw TunnelException("secretKeyB64 is not valid base64")
    }
    if (key.size != 32) throw TunnelException("secretKeyB64 must be base64 of exactly 32 bytes")
    return key
  }

  private fun describe(err: Throwable): String = err.message ?: err.toString()
}
