export interface ConditionalBody {
  body: string;
  status: number;
  ok: boolean;
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
      if (cached) {
        this.#touch(key, cached);
        return { body: cached.body, status: 200, ok: true, reused: true };
      }
      const fresh = await send(href, init);
      return this.#store(key, fresh);
    }
    return this.#store(key, response);
  }

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

  get size(): number {
    return this.#entries.size;
  }
}
