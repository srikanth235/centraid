// Bounded SSE writer (#659). Drop the stream when Node's outbound queue
// exceeds the bound — EventSource reconnects; unbounded buffering does not.

import type { ServerResponse } from "node:http";

const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;

interface SseStreamOptions {
  maxBufferedBytes?: number;
  onOverflow?: (bufferedBytes: number) => void;
}

export class SseStream {
  private readonly res: ServerResponse;
  private readonly maxBufferedBytes: number;
  private readonly onOverflow: ((bufferedBytes: number) => void) | undefined;
  private overflowed = false;

  constructor(res: ServerResponse, options: SseStreamOptions = {}) {
    this.res = res;
    this.maxBufferedBytes =
      options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.onOverflow = options.onOverflow;
  }

  get droppedForBackpressure(): boolean {
    return this.overflowed;
  }

  get bufferedBytes(): number {
    return this.res.writableLength;
  }

  get closed(): boolean {
    return this.overflowed || this.res.writableEnded || this.res.destroyed;
  }

  write(frame: string): boolean {
    if (this.closed) return false;
    if (this.res.writableLength > this.maxBufferedBytes) {
      this.dropForBackpressure();
      return false;
    }
    this.res.write(frame);
    return true;
  }

  event(type: string, serializedData: string): boolean {
    return this.write(`event: ${type}\ndata: ${serializedData}\n\n`);
  }

  comment(text: string): boolean {
    if (this.closed || this.res.writableNeedDrain) return false;
    return this.write(`: ${text}\n\n`);
  }

  end(): void {
    if (this.res.writableEnded || this.res.destroyed) return;
    this.res.end();
  }

  private dropForBackpressure(): void {
    if (this.overflowed) return;
    this.overflowed = true;
    const buffered = this.res.writableLength;
    this.onOverflow?.(buffered);
    // destroy(), not end(): end() would flush the backlog we are dropping.
    this.res.destroy();
  }
}
