/*
 * Golden-frame conformance for the Kotlin tunnel wire implementation
 * (issue #263 / #419). Reads the SAME fixture the Node and Swift conformance
 * tests read — packages/tunnel/fixtures/wire-golden.json — and asserts
 * TunnelWire's framing is byte-for-byte identical.
 *
 * Byte-exact across languages: framing of the canonical `json` string
 * (u32-BE length prefix), the ALPN strings, and the caps. Object *encoding*
 * is round-tripped (encode -> decode -> compare) rather than byte-compared,
 * because org.json key order is not guaranteed to match the Node canonical
 * form. See the fixture's `_readme`.
 *
 * Plain JVM JUnit — no device or emulator, and it never constructs an iroh
 * Endpoint, so no native library is loaded. Run with `./gradlew test`
 * (testDebugUnitTest). See ../../README.md ("Wire conformance tests").
 */

package expo.modules.centraidtunnel

import java.io.File
import java.util.Base64
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class TunnelWireConformanceTest {
  private val fixture: JSONObject = loadFixture()

  /** Ascend from the working directory to the repo's shared fixture. */
  private fun loadFixture(): JSONObject {
    var dir: File? = File(System.getProperty("user.dir")).absoluteFile
    repeat(12) {
      val candidate = File(dir, "packages/tunnel/fixtures/wire-golden.json")
      if (candidate.isFile) return JSONObject(candidate.readText())
      dir = dir?.parentFile
    }
    error("wire-golden.json fixture not found above ${System.getProperty("user.dir")}")
  }

  private fun vectors(): List<JSONObject> {
    val array = fixture.getJSONArray("vectors")
    return (0 until array.length()).map { array.getJSONObject(it) }
  }

  @Test
  fun capsMatchFixture() {
    val caps = fixture.getJSONObject("caps")
    assertEquals(caps.getInt("maxHeaderFrameBytes"), TunnelWire.MAX_HEADER_FRAME_BYTES)
    assertEquals(caps.getInt("maxRequestBodyBytes"), TunnelWire.MAX_REQUEST_BODY_BYTES)
    assertEquals(caps.getInt("readChunkBytes"), TunnelWire.READ_CHUNK_BYTES)
    assertEquals(256 * 1024, TunnelWire.MAX_HEADER_FRAME_BYTES)
    assertEquals(32 * 1024 * 1024, TunnelWire.MAX_REQUEST_BODY_BYTES)
    assertEquals(64 * 1024, TunnelWire.READ_CHUNK_BYTES)
  }

  @Test
  fun alpnsMatchFixture() {
    // The phone module speaks pair + tunnel; gw-pair is the gateway/web side.
    val alpns = fixture.getJSONObject("alpns")
    assertEquals(alpns.getString("pair"), TunnelWire.PAIR_ALPN)
    assertEquals(alpns.getString("tunnel"), TunnelWire.TUNNEL_ALPN)
    assertEquals("centraid/pair/1", TunnelWire.PAIR_ALPN)
    assertEquals("centraid/tunnel/1", TunnelWire.TUNNEL_ALPN)
  }

  @Test
  fun hopByHopMatchesFixture() {
    val json = fixture.getJSONArray("hopByHopHeaders")
    val expected = (0 until json.length()).map { json.getString(it) }.toSet()
    assertEquals(expected, TunnelWire.HOP_BY_HOP)
  }

  /**
   * The core lockstep guarantee: framing the canonical json string yields
   * exactly the golden bytes, and the length prefix round-trips.
   */
  @Test
  fun framingIsByteExact() {
    for (vector in vectors()) {
      val name = vector.getString("name")
      val jsonBytes = vector.getString("json").toByteArray(Charsets.UTF_8)
      assertEquals("byte length: $name", vector.getInt("jsonByteLength"), jsonBytes.size)

      val framed = TunnelWire.frame(jsonBytes)
      val expected = Base64.getDecoder().decode(vector.getString("frameBase64"))
      assertTrue("framing: $name", framed.contentEquals(expected))

      val length = TunnelWire.decodeFrameLength(framed.copyOfRange(0, 4))
      assertEquals("decoded length: $name", vector.getInt("jsonByteLength"), length)
    }
  }

  /**
   * Object encode round-trips (order-tolerant): encode the parsed object,
   * decode the frame back, and assert structural equality via JSONObject.similar.
   */
  @Test
  fun encodeRoundTrip() {
    for (vector in vectors()) {
      val name = vector.getString("name")
      val original = JSONObject(vector.getString("json"))

      val framed = TunnelWire.encodeHeaderFrame(original)
      val length = TunnelWire.decodeFrameLength(framed.copyOfRange(0, 4))
      val payload = framed.copyOfRange(4, 4 + length)
      val decoded = JSONObject(String(payload, Charsets.UTF_8))

      assertTrue("round-trip: $name", original.similar(decoded))
    }
  }

  @Test
  fun decodeRejectsOutOfBoundsLength() {
    assertThrows(TunnelException::class.java) {
      TunnelWire.decodeFrameLength(byteArrayOf(0, 0, 0, 0))
    }
    val overCap = TunnelWire.MAX_HEADER_FRAME_BYTES + 1
    val prefix = byteArrayOf(
      (overCap ushr 24).toByte(),
      (overCap ushr 16).toByte(),
      (overCap ushr 8).toByte(),
      overCap.toByte(),
    )
    assertThrows(TunnelException::class.java) { TunnelWire.decodeFrameLength(prefix) }
  }
}
