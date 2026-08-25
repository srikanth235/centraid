// The DOWN direction's web half of one reusable gate: bytes from gateway to
// device, generalized so Docs' "available offline" pin and Photos' "load the
// original" (viewer.ts's `originStatus`/`originParagraph`, wired through
// `ViewerStage.tsx`'s `onLoadOriginal`) can share one implementation instead
// of two apps each re-deriving "explicit act → fetch → object URL lifecycle."
//
// THE GRAMMAR, same as the mobile fetch gate (`apps/mobile/src/kit/fetch-gate/`):
//
//  * never a silent fetch — `start()` only runs from an explicit member act,
//    never from a render or an effect reacting to props;
//  * never a spinner — a caller renders its OWN static preview (a poster
//    frame, a thumbnail) through every phase; this module has no opinion on
//    what "loading" looks like, because "loading" should not look like
//    anything beyond the shape already on screen;
//  * determinate progress ONLY when the response earns it. A response with no
//    `Content-Length` reports `totalBytes: null`, and a caller must not
//    fabricate a bar for it — an indeterminate bar is a spinner wearing a
//    different shape, which is exactly what "no spinner" rules out.
//
// OBJECT URL LIFECYCLE. `URL.createObjectURL` leaks until revoked, and photos'
// own `upload.ts` already carries a `revokeObjectURL` pairing for the local
// preview it makes before a write lands (#296's blob write path — a
// DIFFERENT direction, device to gateway, but the same browser API). This
// module is that same discipline for the DOWN direction: a fresh `start()`
// revokes whatever object URL the previous fetch produced before requesting a
// new one, and `release()` revokes the current one for a caller that is about
// to unmount or move to a different asset. Nothing here revokes a URL a
// caller has itself gone on to use elsewhere — ownership stays with whichever
// `DownloadOnDemand` produced it.

/** The three request phases a caller renders through. No fourth "loading"
 *  spinner phase exists on purpose — `fetching` IS the loading phase, and a
 *  caller keeps showing its own static preview for it. */
export type DownloadPhase = "idle" | "fetching" | "ready" | "failed";

export interface DownloadProgress {
  receivedBytes: number;
  /** `null` when the response carried no usable `Content-Length`. A caller
   *  must render nothing extra in that case, not an indeterminate bar. */
  totalBytes: number | null;
}

export type DownloadState =
  | { phase: "idle" }
  | { phase: "fetching"; progress: DownloadProgress }
  | { phase: "ready"; objectUrl: string; bytes: number }
  | { phase: "failed"; reason: string };

export const IDLE_STATE: DownloadState = { phase: "idle" };

/**
 * Parses a `Content-Length` header into `DownloadProgress.totalBytes`. Pure,
 * so the "no fabricated determinism" rule is independently testable from any
 * network mock: a missing, non-numeric, or negative header is always `null`.
 */
export function totalBytesFromHeader(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * The explicit-act guard: whether a `start()` call should actually begin a
 * fetch, given the CURRENT phase. `fetching` and `ready` both refuse — a
 * second tap mid-flight must not start a duplicate request, and a tap after
 * success must not re-fetch bytes already on the device (a caller that wants
 * a hard refresh calls `release()` first, which returns to `idle`).
 */
export function shouldStartFetch(phase: DownloadPhase): boolean {
  return phase === "idle" || phase === "failed";
}

/** What `createDownloadOnDemand`'s browser calls are, so tests can supply
 *  fakes instead of touching the network or `URL.createObjectURL`. */
export interface DownloadOnDemandDeps {
  fetch: typeof globalThis.fetch;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
}

function browserDeps(): DownloadOnDemandDeps {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    fetch: (...args) => globalThis.fetch(...args),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  };
}

/**
 * One gated, explicit-act download and the object URL it resolves to.
 * Framework-free — `subscribe` is a plain listener list, so a React caller
 * wraps it in `useSyncExternalStore` (or an equivalent state hook) without
 * this module depending on React, matching `_shared`'s other JSX-free modules
 * (`media.ts`, `write-target.ts`).
 */
export class DownloadOnDemand {
  readonly #url: string;
  readonly #deps: DownloadOnDemandDeps;
  #state: DownloadState = IDLE_STATE;
  readonly #listeners = new Set<(state: DownloadState) => void>();
  #generation = 0;

  constructor(url: string, deps: DownloadOnDemandDeps = browserDeps()) {
    this.#url = url;
    this.#deps = deps;
  }

  state(): DownloadState {
    return this.#state;
  }

  subscribe(listener: (state: DownloadState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #setState(next: DownloadState): void {
    this.#state = next;
    for (const listener of this.#listeners) listener(next);
  }

  /**
   * The explicit member act. No-op (per `shouldStartFetch`) unless idle or
   * failed. Any object URL from a PRIOR fetch on this instance is revoked
   * before the new request starts, so a rapid retry never leaks the failed
   * attempt's bytes — though a failed fetch normally has no object URL to
   * revoke, this also covers a caller that calls `start()` again after
   * `release()`.
   */
  start(): void {
    if (!shouldStartFetch(this.#state.phase)) return;
    const generation = (this.#generation += 1);
    this.#setState({
      phase: "fetching",
      progress: { receivedBytes: 0, totalBytes: null },
    });
    this.#run(generation).catch((error: unknown) => {
      // Stray rejection from a generation this instance no longer cares
      // about (superseded by a newer `start()` or a `release()`) — swallow
      // rather than reporting a failure nobody is listening for.
      if (generation !== this.#generation) return;
      this.#setState({
        phase: "failed",
        reason: error instanceof Error ? error.message : "Fetch failed",
      });
    });
  }

  async #run(generation: number): Promise<void> {
    const response = await this.#deps.fetch(this.#url);
    if (generation !== this.#generation) return; // superseded mid-flight
    if (!response.ok) {
      this.#setState({
        phase: "failed",
        reason: `${response.status} ${response.statusText}`.trim(),
      });
      return;
    }
    const totalBytes = totalBytesFromHeader(
      response.headers.get("content-length")
    );
    const body = response.body;
    // A response with no readable stream (a test double, or a platform that
    // doesn't expose one) still resolves — via `response.blob()` — rather
    // than being treated as a failure; only NETWORK failures are `failed`.
    const blob = body
      ? await this.#readWithProgress(body, totalBytes, generation)
      : await response.blob();
    if (generation !== this.#generation) return;
    if (!blob) return; // superseded mid-read
    const objectUrl = this.#deps.createObjectURL(blob);
    this.#setState({ bytes: blob.size, objectUrl, phase: "ready" });
  }

  async #readWithProgress(
    body: ReadableStream<Uint8Array>,
    totalBytes: number | null,
    generation: number
  ): Promise<Blob | null> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    const readNext = async (): Promise<Blob | null> => {
      const { done, value } = await reader.read();
      if (generation !== this.#generation) {
        await reader.cancel().catch(() => {
          /* the stream is already abandoned; nothing to report */
        });
        return null;
      }
      if (done) return new Blob(chunks as BlobPart[]);
      if (value === undefined) return readNext();
      chunks.push(value);
      receivedBytes += value.byteLength;
      this.#setState({
        phase: "fetching",
        progress: { receivedBytes, totalBytes },
      });
      return readNext();
    };
    return readNext();
  }

  /**
   * Revoke the current object URL (if any) and return to `idle`. Callers
   * MUST call this on unmount / when moving to a different asset — the same
   * discipline `upload.ts`'s local preview already keeps, now on the DOWN
   * direction.
   */
  release(): void {
    this.#generation += 1; // abandon any in-flight fetch
    if (this.#state.phase === "ready") {
      this.#deps.revokeObjectURL(this.#state.objectUrl);
    }
    this.#setState(IDLE_STATE);
  }
}

export function createDownloadOnDemand(
  url: string,
  deps?: DownloadOnDemandDeps
): DownloadOnDemand {
  return new DownloadOnDemand(url, deps);
}
