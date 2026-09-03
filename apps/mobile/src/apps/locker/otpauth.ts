const BASE32 = /^[A-Z2-7]+=*$/u;

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

export function seedFromEntry(raw: string): string | null {
  const text = raw.trim().replaceAll(/\s/gu, "").toUpperCase();
  if (text.length === 0) return null;
  if (text.startsWith("OTPAUTH://")) return otpauthSeed(raw);
  return BASE32.test(text) ? text : null;
}
