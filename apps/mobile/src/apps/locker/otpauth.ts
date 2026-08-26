// READING AN `otpauth://` SQUARE (README-Locker §9, "TOTP capture by camera";
// FLOWS.md: "The one-time code offers Scan only on the phone").
//
// Pure, and separate from the camera on purpose: the camera is an origin-seat
// capability, the URI grammar is not, and this is the half a test can hold.
//
// THE SEED NEVER LANDS ANYWHERE BUT THE FORM. This function returns it to the
// caller and keeps nothing; the form that receives it is `editSeed`, one of
// the enumerated secret-bearing fields a lock wipes (`session.ts`).

/** The base32 alphabet TOTP seeds are written in — `totp.base32Decode`'s. */
const BASE32 = /^[A-Z2-7]+=*$/u;

/**
 * The seed inside an `otpauth://totp/...?secret=...` URI, or `null`.
 *
 * `null` for anything else — a wifi square, a URL, a vCard — because a QR code
 * that is not an otpauth code is not a near-miss to be salvaged. The scanner
 * says so and keeps looking rather than writing a seed that would produce
 * codes no server accepts.
 */
export function otpauthSeed(raw: string): string | null {
  const text = raw.trim();
  if (!/^otpauth:\/\/totp\//iu.test(text)) return null;
  const query = text.slice(text.indexOf("?") + 1);
  if (!text.includes("?")) return null;
  for (const pair of query.split("&")) {
    const [key, value] = pair.split("=");
    if (key?.toLowerCase() !== "secret" || !value) continue;
    const seed = decodeURIComponent(value).replaceAll(/\s/gu, "").toUpperCase();
    return BASE32.test(seed) ? seed : null;
  }
  return null;
}

/**
 * What the member typed or pasted into the one-time-code field, as a seed.
 * An otpauth URI is unwrapped; a bare base32 string is taken as it is; nothing
 * else is a seed.
 */
export function seedFromEntry(raw: string): string | null {
  const text = raw.trim().replaceAll(/\s/gu, "").toUpperCase();
  if (text.length === 0) return null;
  if (text.startsWith("OTPAUTH://")) return otpauthSeed(raw);
  return BASE32.test(text) ? text : null;
}
