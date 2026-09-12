/**
 * WHICH ORIGINALS THE GATEWAY'S PREVIEW CODEC CANNOT DECODE (#1011).
 *
 * The gateway's preview codec is sharp, and the pinned
 * `@img/sharp-libvips-darwin-arm64` ships libheif WITHOUT an HEVC decoder, so
 * the HEIC an iPhone actually writes declines there and earns the durable
 * `preview-codec@1` "unsupported" stamp — after which every recognition recipe
 * skips it. iOS decodes it natively, so the phone contributes the JPEG display
 * rungs itself and the marker never stands.
 *
 * Keyed by EXTENSION because the import door is filename-routed: the phone
 * names the file before the gateway has sniffed a byte.
 *
 * Its own module, importing nothing (#1014): the camera-roll import asks this
 * question to declare an original's media type, and pulling the native imaging
 * stack in behind a string test would put `react-native` into every caller.
 */
const GATEWAY_UNDECODABLE_EXTENSIONS = new Set(["heic", "heif", "hif"]);

export function gatewayCanDecode(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  const extension = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  return !GATEWAY_UNDECODABLE_EXTENSIONS.has(extension);
}
