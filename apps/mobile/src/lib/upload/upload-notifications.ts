// THE UPLOAD QUEUE SAYS WHEN IT CHANGED (#996 wave 3), instead of being asked.
//
// The Photos timeline polled this queue's SQLite database on a timer — 4 s
// while anything was in flight, 30 s when settled — because the queue had no
// way to say it had moved. That is the shape wave 2 replaced everywhere else:
// the applier sends its change notices unsolicited, and nobody asks it whether
// it has applied anything lately.
//
// This is the same idea for the device's own outbox, and the writer is the
// only honest place for it: `enqueue` and `drain` are the two calls that move
// a row, so they are the two that announce it. A listener that has to guess
// the cadence is a listener that is either late or spinning.
//
// DELIBERATELY NOT A PAYLOAD. What changed is the reader's question — the
// timeline re-reads the queue and diffs its own signature — and a notification
// carrying rows would be a second, staler copy of the answer.

type UploadListener = () => void;

const listeners = new Set<UploadListener>();

/** Subscribe to "the upload queue moved". Returns the unsubscribe. */
export function onUploadQueueChanged(listener: UploadListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Announce that a row moved.
 *
 * Every listener is called even if one throws: a subscriber's own failure is
 * not a reason for the next one to miss the notice. The set is snapshotted
 * into an array first, so a listener that unsubscribes itself while being
 * called cannot make the iteration skip its neighbour.
 */
export function notifyUploadQueueChanged(): void {
  const current = Array.from(listeners);
  for (const listener of current) {
    try {
      listener();
    } catch {
      // A subscriber's failure is its own; the queue has still moved.
    }
  }
}
