/**
 * WHERE the one status line paints (#1015, S3).
 *
 * The channel stays single — `status-channel.ts` is still the only slot, and
 * `postStatus` is still the only way to fill it. What this module adds is the
 * other half of invariant 5 the phone was missing: a note has to be VISIBLE.
 * Every editor on this seat is presented as an iOS `Modal`, which renders in
 * its own root view above the app's; a `StatusLine` mounted at the app root
 * therefore paints UNDER the modal, so every note posted from inside an editor
 * was swallowed (audit B5). Apps answered that by growing second feedback
 * channels, which is exactly what invariant 5 forbids.
 *
 * The fix is a host stack, not a second channel. A presentation that covers
 * the app root — a `Modal` editor, a sheet — claims a host while it is up; the
 * topmost claim is the one host that renders. When nothing is claimed the root
 * host renders, which is the behaviour every existing call site already has.
 *
 * Imperative and module-scoped for the same reason the channel is: claims are
 * made and dropped by mount lifecycles, and a context would make every screen
 * between the root and the editor a participant in a question that is not
 * theirs.
 */

/** The host `App.tsx` mounts; the bottom of the stack, never popped. */
export const ROOT_STATUS_HOST = "root";

const stack: string[] = [];
const subscribers = new Set<() => void>();

function emit(): void {
  for (const fn of Array.from(subscribers)) fn();
}

export function subscribeStatusHost(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** The host that may paint: the newest live claim, else the root. */
export function activeStatusHost(): string {
  return stack[stack.length - 1] ?? ROOT_STATUS_HOST;
}

/**
 * Claim the line for a presentation. Returns the release; calling it twice is
 * a no-op, because a modal that unmounts during a transition can release from
 * both an effect cleanup and a dismiss handler.
 *
 * A claim is removed by identity rather than by popping the top: presentations
 * do not always unmount in the order they mounted (a modal dismissed under a
 * sheet), and popping blind would leave a dead id painting nothing.
 */
export function claimStatusHost(id: string): () => void {
  stack.push(id);
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const at = stack.lastIndexOf(id);
    if (at >= 0) stack.splice(at, 1);
    emit();
  };
}

/** Tests only: drop every claim and every subscriber. */
export function resetStatusHosts(): void {
  stack.length = 0;
  subscribers.clear();
}
