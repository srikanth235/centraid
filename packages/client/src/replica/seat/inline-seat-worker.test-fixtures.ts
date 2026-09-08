// A SEAT WORKER WITHOUT A THREAD (#996, wave 2 and R24).
//
// The REAL `SeatWorkerCore` over `node:sqlite`, driven through the same
// message protocol the browser's worker uses. What is faked is the THREAD,
// not the program: a suite that stubbed the core would prove nothing about
// the boundary, and the boundary is the whole point — the browser's outbox
// and its applier are on the far side of a `postMessage` from the queue that
// drives them.

import { NodeSeatDriver } from "./node-seat-driver.js";
import type { SeatWorkerLike } from "./seat-worker-client.js";
import { SeatWorkerCore } from "./worker-core.js";
import type { SeatWorkerHost, SeatWorkerSink } from "./worker-core.js";
import { serializeSeatError } from "./worker-protocol.js";
import type {
  SeatWorkerRequest,
  SeatWorkerResponse,
} from "./worker-protocol.js";

export function inlineSeatWorker(
  host: SeatWorkerHost,
  sink: SeatWorkerSink = {}
): SeatWorkerLike {
  const listeners = new Set<
    (event: MessageEvent<SeatWorkerResponse>) => void
  >();
  const emit = (message: SeatWorkerResponse): void => {
    for (const listener of listeners)
      listener({ data: message } as MessageEvent<SeatWorkerResponse>);
  };
  const core = new SeatWorkerCore(host, {
    ...sink,
    onChange: (notice) => {
      sink.onChange?.(notice);
      emit({ event: "change", notice });
    },
  });
  return {
    postMessage: (request: SeatWorkerRequest) => {
      void core.dispatch(request).then(
        (result) => emit({ id: request.id, ok: true, result }),
        (error: unknown) =>
          emit({ id: request.id, ok: false, error: serializeSeatError(error) })
      );
    },
    addEventListener: ((type: string, listener: unknown) => {
      if (type === "message")
        listeners.add(
          listener as (event: MessageEvent<SeatWorkerResponse>) => void
        );
    }) as SeatWorkerLike["addEventListener"],
    removeEventListener: ((type: string, listener: unknown) => {
      if (type === "message")
        listeners.delete(
          listener as (event: MessageEvent<SeatWorkerResponse>) => void
        );
    }) as SeatWorkerLike["removeEventListener"],
    terminate: () => listeners.clear(),
  };
}

/** An in-memory seat file, opened, with nothing behind the snapshot door. */
export function inlineMemorySeatWorker(): {
  worker: SeatWorkerLike;
  close: () => void;
} {
  const drivers: NodeSeatDriver[] = [];
  const worker = inlineSeatWorker({
    openDatabase: () => {
      const driver = new NodeSeatDriver();
      drivers.push(driver);
      return driver;
    },
    staging: () => {
      throw new Error("this seat never bootstraps");
    },
    transport: () => {
      throw new Error("this seat never bootstraps");
    },
  });
  return {
    worker,
    close: () => {
      // `SeatWorkerCore.close` may already have released the handle; a suite
      // tearing down must not care which of the two got there first.
      for (const driver of drivers) {
        try {
          driver.close();
        } catch {
          /* already closed by the core */
        }
      }
    },
  };
}
