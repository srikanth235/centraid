// The web half of the DOWN gate. THE GRAMMAR: never a silent fetch (`start()`
// runs only from an explicit member act), never a spinner, and determinate
// progress only when the response earns it. Object URLs leak until revoked.

export type DownloadPhase = "idle" | "fetching" | "ready" | "failed";

export interface DownloadProgress {
  receivedBytes: number;
  /** `null` with no usable `Content-Length`: render nothing, never a bar. */
  totalBytes: number | null;
}

export type DownloadState =
  | { phase: "idle" }
  | { phase: "fetching"; progress: DownloadProgress }
  | { phase: "ready"; objectUrl: string; bytes: number }
  | { phase: "failed"; reason: string };

export const IDLE_STATE: DownloadState = { phase: "idle" };

export function totalBytesFromHeader(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** `fetching` and `ready` refuse; a hard refresh calls `release()` first. */
export function shouldStartFetch(phase: DownloadPhase): boolean {
  return phase === "idle" || phase === "failed";
}

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

  start(): void {
    if (!shouldStartFetch(this.#state.phase)) return;
    const generation = (this.#generation += 1);
    this.#setState({
      phase: "fetching",
      progress: { receivedBytes: 0, totalBytes: null },
    });
    this.#run(generation).catch((error: unknown) => {
      // A superseded generation's rejection is nobody's.
      if (generation !== this.#generation) return;
      this.#setState({
        phase: "failed",
        reason: error instanceof Error ? error.message : "Fetch failed",
      });
    });
  }

  async #run(generation: number): Promise<void> {
    const response = await this.#deps.fetch(this.#url);
    if (generation !== this.#generation) return; // superseded
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
    // No readable stream still resolves via `blob()`.
    const blob = body
      ? await this.#readWithProgress(body, totalBytes, generation)
      : await response.blob();
    if (generation !== this.#generation) return;
    if (!blob) return;
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

  /** Callers MUST call this on unmount or asset change. */
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
