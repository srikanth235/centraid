/**
 * Server-side origin matching for Companion fill (defense-in-depth).
 * Mirrors apps/extension/src/origin-matching.ts so reveal refuses wrong-site
 * fills even if a modified client forges page_origin. Keep vectors aligned
 * with apps/extension/spec/origin-matching-v1.json.
 */

import { getDomain } from 'tldts';

export type OriginMatchPolicy = 'registrable-domain' | 'exact-host';

export interface OriginCandidate {
  readonly url: string;
  readonly url_match_policy?: OriginMatchPolicy;
}

/** True only for real IPv4 loopback (`127.0.0.0/8`) and exact localhost / ::1. */
export function isLoopback(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true;
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  return octets[0] === 127;
}

function safeUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.protocol === 'http:' && !isLoopback(url.hostname)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function identity(url: URL, policy: OriginMatchPolicy): string {
  if (policy === 'exact-host' || isLoopback(url.hostname)) return url.hostname;
  return getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname;
}

export function matchesOrigin(candidate: OriginCandidate, pageUrl: string): boolean {
  const stored = safeUrl(candidate.url);
  const page = safeUrl(pageUrl);
  if (!stored || !page) return false;
  const policy = candidate.url_match_policy ?? 'registrable-domain';
  return (
    stored.protocol === page.protocol &&
    stored.port === page.port &&
    identity(stored, policy) === identity(page, policy)
  );
}

/** Normalize a page origin string for fill receipts (scheme://host[:port]). */
export function pageOrigin(raw: unknown): string | undefined {
  try {
    const url = new URL(String(raw ?? ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== raw) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}
