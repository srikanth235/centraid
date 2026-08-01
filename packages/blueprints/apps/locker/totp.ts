// Secret crypto: real RFC-6238 TOTP, password strength scoring and the
// in-browser password generator — the app's only crypto surface, ported
// byte-for-byte from the Lit original (app.js's "Secret helpers" section).
// base32 decode → HMAC-SHA1 over the big-endian 30s counter → dynamic
// truncation → 6 digits. Cached per (seed, 30s-step) so the once-a-second
// tick is cheap; the seed and code never get logged.
import { useEffect, useState } from "react";

export function base32Decode(
  input: string | null | undefined
): Uint8Array<ArrayBuffer> | null {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(input || "")
    .toUpperCase()
    .replace(/=+$/u, "")
    .replace(/\s/gu, "");
  if (!clean || /[^A-Z2-7]/u.test(clean)) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return out.length ? new Uint8Array(out) : null;
}

export async function computeTotp(
  seed: string,
  step: number
): Promise<string | null> {
  const key = base32Decode(seed);
  if (!key) return null;
  const counter = new ArrayBuffer(8);
  const view = new DataView(counter);
  // 8-byte big-endian counter; step fits in the low 32 bits for any real clock.
  view.setUint32(0, Math.floor(step / 0x100000000));
  view.setUint32(4, step >>> 0);
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign("HMAC", cryptoKey, counter)
    );
    const offset = sig[sig.length - 1]! & 0x0f;
    const bin =
      ((sig[offset]! & 0x7f) << 24) |
      ((sig[offset + 1]! & 0xff) << 16) |
      ((sig[offset + 2]! & 0xff) << 8) |
      (sig[offset + 3]! & 0xff);
    const code = String(bin % 1000000).padStart(6, "0");
    return code.slice(0, 3) + " " + code.slice(3);
  } catch {
    return null;
  }
}

export function totpOffset(): number {
  const rem = 30 - (Math.floor(Date.now() / 1000) % 30);
  return 94.2 * (1 - rem / 30);
}

const OTP_CACHE = new Map<string, string | null>(); // `${seed}|${step}` -> "123 456" | null

function cacheKey(seed: string, step: number): string {
  return `${seed}|${step}`;
}

/**
 * React hook: the live TOTP code + ring offset for a seed. Ticks once a
 * second via its own interval scoped to the calling component (never a
 * top-level app render) — the React analogue of app.js's original shortcut
 * of bumping only the mounted detail component's `tick` property so the
 * once-a-second countdown never disturbs the sidebar/list/overlays the
 * owner might be mid-interaction with (typing in search, editing a modal).
 */
export function useTotp(seed: string | null | undefined): {
  code: string | null;
  offset: number;
} {
  // The code is derived during render, never synced into state by an effect
  // (#573). `computed` carries the last value this hook resolved asynchronously,
  // so a fresh 30s step keeps showing the previous code until its replacement
  // lands — the same continuity the old `code` state gave. The tick value itself
  // is never read: bumping it is what re-renders the countdown ring each second.
  const [, setTick] = useState(0);
  const [step, setStep] = useState(() => Math.floor(Date.now() / 30000));
  const [computed, setComputed] = useState<string | null>(null);

  // One interval drives both: `tick` re-renders for the countdown ring, `step`
  // rolls the 30s window over within a second of the real one — the same
  // once-a-second re-check the old `[seed, tick]` effect performed, but as
  // state the render can read purely.
  useEffect(() => {
    if (!seed) return undefined;
    const id = setInterval(() => {
      setTick((t) => t + 1);
      setStep(Math.floor(Date.now() / 30000));
    }, 1000);
    return () => clearInterval(id);
  }, [seed]);

  const key = seed ? cacheKey(seed, step) : null;
  // A cached entry wins even when it is null (a failed compute is cached as
  // null, exactly as the old effect stored it); only a cache miss falls back to
  // the previous resolved code.
  const code = key
    ? OTP_CACHE.has(key)
      ? (OTP_CACHE.get(key) ?? null)
      : computed
    : null;

  useEffect(() => {
    if (!seed || !key || OTP_CACHE.has(key)) return undefined;
    let cancelled = false;
    void computeTotp(seed, step).then((value) => {
      OTP_CACHE.set(key, value);
      if (OTP_CACHE.size > 40) {
        const oldest = OTP_CACHE.keys().next().value;
        if (oldest !== undefined) OTP_CACHE.delete(oldest);
      }
      if (!cancelled) setComputed(value);
    });
    return () => {
      cancelled = true;
    };
  }, [seed, key, step]);

  return { code, offset: totpOffset() };
}

// ---------- Strength + generator (also real crypto: getRandomValues) ----------

export interface Strength {
  ratio: number;
  tone: string;
  label: string;
  color: string;
}

// Length + character-class score, 0..5 → { ratio, tone, label, color } for a
// kit-meter + label. Mirrors the server's strengthScore so the meter agrees
// with Watchtower's "weak".
export function strength(pw: string | null | undefined): Strength {
  if (!pw) return { ratio: 0, tone: "", label: "", color: "var(--text-faint)" };
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 14) s++;
  if (/[A-Z]/u.test(pw) && /[a-z]/u.test(pw)) s++;
  if (/[0-9]/u.test(pw)) s++;
  if (/[^A-Za-z0-9]/u.test(pw)) s++;
  const label =
    s <= 2 ? "Weak" : s === 3 ? "Fair" : s === 4 ? "Good" : "Strong";
  const tone = s <= 2 ? "danger" : s === 3 ? "warn" : "ok";
  const color =
    s <= 2 ? "var(--danger)" : s === 3 ? "var(--warn)" : "var(--ok)";
  return { ratio: s / 5, tone, label, color };
}

export function genPassword({
  len,
  num,
  sym,
}: {
  len: number;
  num: boolean;
  sym: boolean;
}): string {
  let chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
  if (num) chars += "23456789";
  if (sym) chars += "!@#$%^&*-_=+";
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < len; i++) out += chars[buf[i]! % chars.length]!;
  return out;
}
