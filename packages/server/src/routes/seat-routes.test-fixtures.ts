// THE SEAT DOORS' RESPONSE STUB, SHARED (#996, R4).
//
// Two suites drive these doors — the doors themselves and the snapshot cache
// — and both need a destination `stream.pipeline` will actually finish on.
// One spelling, so a change to the rig is a change to the rig.

import { Writable } from "node:stream";

/**
 * A REAL Writable, not a stub with a `write` method.
 *
 * The snapshot door hands the file to `stream.pipeline`, which waits for the
 * destination's `finish` — a hand-rolled object with a `write` function never
 * emits it and the test hangs rather than failing. Extending `Writable` also
 * means the door's backpressure path is the one under test.
 */
export class MockResponse extends Writable {
  statusCode = 200;
  readonly headers = new Map<string, string>();
  private readonly chunks: Buffer[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: string,
    done: (error?: Error | null) => void
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    done();
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(String(name).toLowerCase(), String(value));
    return this;
  }

  getHeader(name: string): string | undefined {
    return this.headers.get(name.toLowerCase());
  }

  get body(): Buffer {
    return Buffer.concat(this.chunks);
  }

  json<T>(): T {
    return JSON.parse(this.body.toString("utf8")) as T;
  }
}
