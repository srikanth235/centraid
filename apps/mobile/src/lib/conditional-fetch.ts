// Client half of HTTP conditional requests for the phone's gateway calls.
//
// Home re-fetches the same three endpoints on mount, on focus and on every SSE
// doorbell, and none of those responses usually changed. An unconditional GET
// makes the phone pay the full body every time — over a metered link, over a
// relay, for bytes it already had. `If-None-Match` turns the unchanged case into a 304
// with no body while leaving the freshness guarantee exactly where it was: the
// gateway still decides, and a changed resource still returns in full.
//
// This is a bandwidth cache, not a store. It holds bodies in memory only, is
// bounded, and a miss is always safe — the request simply goes out unconditional.

export interface ConditionalBody {
  body: string;
  /** The gateway's own status; a 304 is reported as the 200 it stands in for. */
  status: number;
  ok: boolean;
  /** True when the gateway answered 304 and this body came from memory. */
  reused: boolean;
}

export type ResponseFetcher = (
  href: string,
  init: RequestInit
) => Promise<Response>;

const DEFAULT_MAX_ENTRIES = 32;

export class ConditionalBodyCache {
  readonly #entries = new Map<string, { etag: string; body: string }>();
  readonly #maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * GET `href`, revalidating against the stored ETag when there is one.
   *
   * `key` separates responses that share a URL but not a scope — the active
   * vault header is part of what the answer depends on.
   */
  async fetch(
    href: string,
    init: RequestInit,
    send: ResponseFetcher,
    key: string = href
  ): Promise<ConditionalBody> {
    const cached = this.#entries.get(key);
    const response = await send(
      href,
      cached
        ? {
            ...init,
            headers: { ...init.headers, "if-none-match": cached.etag },
          }
        : init
    );
    if (response.status === 304) {
      // The entry can only be missing if it was evicted between the request
      // being built and this line, which cannot happen on one JS thread — but a
      // gateway that 304s an unconditional request would otherwise strand the
      // caller with no body, so re-ask without the validator.
      if (cached) {
        this.#touch(key, cached);
        return { body: cached.body, status: 200, ok: true, reused: true };
      }
      const fresh = await send(href, init);
      return this.#store(key, fresh);
    }
    return this.#store(key, response);
  }

  /** Forget everything; used when the identity behind the responses changes. */
  clear(): void {
    this.#entries.clear();
  }

  async #store(key: string, response: Response): Promise<ConditionalBody> {
    const body = await response.text();
    const etag = response.headers.get("etag");
    if (!response.ok) {
      this.#entries.delete(key);
      return { body, status: response.status, ok: false, reused: false };
    }
    if (etag) {
      this.#entries.delete(key);
      this.#entries.set(key, { etag, body });
      // Insertion order is least-recently-used order, so the oldest key is
      // first. A handful of endpoints never reaches this, but an unbounded map
      // keyed by URL is a leak waiting for a query string.
      while (this.#entries.size > this.#maxEntries) {
        const [oldest] = this.#entries.keys();
        if (oldest === undefined) break;
        this.#entries.delete(oldest);
      }
    } else this.#entries.delete(key);
    return { body, status: response.status, ok: true, reused: false };
  }

  #touch(key: string, entry: { etag: string; body: string }): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
  }

  /** Entries currently held. Exposed so the bound is assertable. */
  get size(): number {
    return this.#entries.size;
  }
}
