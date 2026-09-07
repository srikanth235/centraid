// THE WEB SEAT (#996, wave 2; re-expressed over the host-neutral loop in 4b).
//
// The browser's assembly of the seat, and nothing else: a Worker for the store
// — the applier walks hundreds of thousands of rows and must not do that on
// the thread that paints — and `SeatLoop` for everything that happens after
// the file is open. The loop used to live here; it is shared with the phone
// now, so the ONE thing this file still says is which channel the loop talks
// through.

import { SeatLoop } from "./seat-loop.js";
import type { SeatLoopOptions } from "./seat-loop.js";
import {
  defaultSeatWorkerFactory,
  SeatWorkerClient,
} from "./seat-worker-client.js";
import type {
  SeatWorkerFactory,
  SeatWorkerListeners,
} from "./seat-worker-client.js";
import type { SeatWatermark } from "./watermark.js";
import type { SeatWorkerQuery } from "./worker-protocol.js";

export interface WebSeatOptions extends SeatLoopOptions {
  readonly workerFactory?: SeatWorkerFactory;
  readonly listeners?: SeatWorkerListeners;
}

export class WebSeat {
  private constructor(private readonly loop: SeatLoop) {}

  static async open(options: WebSeatOptions): Promise<WebSeat> {
    const factory = options.workerFactory ?? defaultSeatWorkerFactory;
    const client = new SeatWorkerClient(factory(), options.listeners ?? {});
    const loop = new SeatLoop(client, options);
    await loop.open();
    return new WebSeat(loop);
  }

  /** What the shell shows, or `undefined` before the first file lands. */
  watermark(): SeatWatermark | undefined {
    return this.loop.watermark();
  }

  sync(): Promise<SeatWatermark | undefined> {
    return this.loop.sync();
  }

  query<T extends object>(request: SeatWorkerQuery): Promise<T[]> {
    return this.loop.query<T>(request);
  }

  close(): Promise<void> {
    return this.loop.close();
  }
}
