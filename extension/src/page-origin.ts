/*
 * WHERE LOCKER MAY RUN, AND WHAT ORIGIN IT IS (#1020 wave 4 lane extension,
 * D-1020-X8).
 *
 * ## What moved out of this file, and why that is the security improvement
 *
 * v0's Companion carries the whole origin-matching policy —
 * `apps/extension/src/origin-matching.ts` plus `tldts` and the Public Suffix
 * List, bundled into the extension. That is a copy of a security policy, with
 * its own copy of a list that goes stale, living in the least trusted process in
 * the chain. After wave 4 it buys nothing: the fill's decision is the SEAT's
 * (`crates/seat::locker::fill_grant` matches the page origin against the row's
 * own stored `url_match_policy`, and re-normalises the caller's origin first),
 * and the candidate list is filtered by the native host over
 * `crates/apps/locker::origin` and the same promoted spec. A third copy here
 * could only ever disagree — and a disagreement shows up as a login the picker
 * offers and the seat then refuses.
 *
 * So the registrable-domain question is gone from the extension. What is left is
 * the part that is genuinely the page's own business and needs no list:
 *
 * 1. **eligibility** — HTTPS, or a real loopback development origin. v0's rule,
 *    character for character, including the three cases its comment exists for:
 *    `127.0.0.1.evil.test` and `127.foo.bar` are NOT loopback, and `localhost`,
 *    `::1` and `[::1]` are.
 * 2. **normalisation** — `scheme://host[:port]`, so the frame carries an origin
 *    rather than a URL. The host derives it again and the seat requires it
 *    exactly, so this is a convenience with two walls behind it.
 *
 * `contracts/origin-matching-v1.json` is still read by this module's tests, for
 * the half it still owns: every vector's `page` and `stored` must be judged
 * eligible or not the same way the spec's three implementations judge them.
 */

/**
 * True only for real IPv4 loopback (`127.0.0.0/8`) and the exact hostnames
 * `localhost` / `::1`.
 *
 * Carried verbatim from v0 (`origin-matching.ts:11`–`:29`) with its reason:
 * hostnames that merely start with `127.` — `127.0.0.1.evil.test` — must not
 * inherit the HTTP eligibility exception.
 */
export function isLoopback(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") {
    return true;
  }
  // URL.hostname strips brackets for IPv6 but leaves IPv4 dotted-quad as-is.
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) return false;
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return false;
  }
  return octets[0] === 127;
}

function safeUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.protocol === "http:" && !isLoopback(url.hostname)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/** Whether Locker may run on this page at all (HTTPS, or a loopback origin). */
export function isEligiblePageUrl(raw: string): boolean {
  return safeUrl(raw) !== undefined;
}

/**
 * The page's origin, `scheme://host[:port]`, or `undefined`.
 *
 * `undefined` for an ineligible page, so a caller cannot accidentally send a
 * `file:` or plain-HTTP origin into a fill frame: the gesture is refused here,
 * where there is a member to tell.
 */
export function pageOrigin(raw: string): string | undefined {
  return safeUrl(raw)?.origin;
}

/**
 * Whether a Locker gesture may be served for this sender.
 *
 * v0's `assertTopFramePage` (`companion-api.ts:38`–`:57`), carried whole,
 * because every clause is a real refusal:
 *
 * - a **subframe** may not ask, so a third-party iframe cannot fill the page it
 *   is embedded in;
 * - the claimed page URL must be the **active tab's own** origin, so a content
 *   script cannot ask about a page it is not on;
 * - the page must be eligible.
 */
export function lockerGestureRefusal(input: {
  readonly method: string;
  readonly frameId?: number;
  readonly pageUrl?: string;
  readonly tabUrl?: string;
}): string | undefined {
  if (!input.method.startsWith("locker:")) return undefined;
  if (input.frameId !== 0 || !input.pageUrl || !input.tabUrl) {
    return "Locker requests are accepted only from a top-level page.";
  }
  if (pageOrigin(input.pageUrl) !== pageOrigin(input.tabUrl)) {
    return "The requested Locker origin does not match the active page.";
  }
  if (!isEligiblePageUrl(input.pageUrl)) {
    return "Locker is available only on HTTPS pages and local development origins.";
  }
  return undefined;
}
