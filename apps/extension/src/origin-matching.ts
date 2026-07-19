import { getDomain } from 'tldts';

export type OriginMatchPolicy = 'registrable-domain' | 'exact-host';

export interface OriginCandidate {
  readonly url: string;
  readonly url_match_policy?: OriginMatchPolicy;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.startsWith('127.')
  );
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

/** Whether Locker may run on this page at all (HTTPS, or a loopback development origin). */
export function isEligiblePageUrl(raw: string): boolean {
  return safeUrl(raw) !== undefined;
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
