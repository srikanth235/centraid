package expo.modules.centraidtunnel

import java.net.Socket
import org.junit.Test

class TunnelProxyTest {
  @Test
  fun proxyAcceptsTheAdvertisedIpv4LoopbackAddress() {
    val proxy = TunnelProxy(openStream = { error("request forwarding is not part of this test") })
    val port = proxy.start()
    try {
      Socket("127.0.0.1", port).use { socket ->
        socket.shutdownOutput()
      }
    } finally {
      proxy.stop()
    }
  }
}
