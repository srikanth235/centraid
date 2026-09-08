/**
 * A FILE-BACKED outbox for the composition-chaos lane (#842 W3.2, #996 W5).
 *
 * The outbox is a table in the SEAT'S OWN FILE now, so this is the shipped
 * `SeatIntentStore` over the shipped `NodeSeatDriver` — no bespoke driver of
 * its own, and no store this lane invented. The file is what makes the lane's
 * claim falsifiable: `close()` + reopen is a real restart of a real durable
 * store, and `recoverSending()` has something to recover. An in-memory driver
 * would turn "the phone's process died mid-flight" into "the phone forgot".
 */

import { IntentQueue } from "../../packages/client/src/replica/intents.js";
import { NodeSeatDriver } from "../../packages/client/src/replica/seat/node-seat-driver.js";
import { SeatIntentStore } from "../../packages/client/src/replica/seat/seat-intent-store.js";

export interface DurableOutbox {
  readonly queue: IntentQueue;
  /** Close the underlying file handle — the process-death half of a restart. */
  close: () => void;
}

/** Open (or reopen) the durable outbox stored at `file`. */
export function openDurableOutbox(file: string): DurableOutbox {
  const driver = new NodeSeatDriver(file);
  return {
    // No applier drives a cursor in this world; see `chaosIntentQueue`.
    queue: new IntentQueue(SeatIntentStore.create(driver), {
      settlesByCommitSeq: false,
    }),
    close: () => driver.close(),
  };
}
