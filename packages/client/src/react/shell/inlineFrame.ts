import { useState, useSyncExternalStore } from "react";

import type {
  InlineAppBarContribution,
  InlineBandClaim,
  InlineFrame,
} from "@centraid/blueprints/apps/inline-types";

import { clearStatus, postStatus } from "./statusChannel.js";

// The inline app's contribution channel (Photos v4, §3).
//
// A blueprint app that mounts INSIDE the frame does not draw chrome: it says
// what the frame's bar should carry, what the one status line should say, and
// — on the compact surface — whether it is claiming the bottom band. The frame
// renders all three. That is the whole of this module.
//
// It is a store rather than a context because the two ends live on opposite
// sides of a Suspense boundary: the app's `Root` mounts UNDER the route host
// that renders the bar ABOVE it, so a child cannot hand the parent a value
// through React alone. A subscription lets the host re-render in place when a
// count changes, without the app knowing where the bar is.
//
// The status line is deliberately NOT part of the state here — it already has
// exactly one owner (`statusChannel.ts`), and routing an app's note through a
// second store would be the second feedback channel invariant 5 forbids. The
// channel just forwards.

export interface InlineFrameState {
  appBar: InlineAppBarContribution | null;
  band: InlineBandClaim | null;
}

const EMPTY: InlineFrameState = { appBar: null, band: null };

export interface InlineFrameChannel {
  /** Handed to the app's `Root`. Stable for the life of the mount. */
  frame: InlineFrame;
  subscribe: (fn: () => void) => () => void;
  read: () => InlineFrameState;
}

/**
 * A channel for one mounted inline app.
 *
 * Created per mount, never shared: two apps on screen at once would otherwise
 * fight over one bar. The state object identity only changes when a
 * contribution actually changes, so `useSyncExternalStore` does not tear.
 */
export function createInlineFrameChannel(): InlineFrameChannel {
  let state = EMPTY;
  const subscribers = new Set<() => void>();

  const emit = (): void => {
    // A snapshot, not the live set: a subscriber that unsubscribes as it
    // reacts would otherwise mutate the set mid-iteration.
    for (const fn of Array.from(subscribers)) fn();
  };

  const set = (next: InlineFrameState): void => {
    state = next;
    emit();
  };

  return {
    frame: {
      setAppBar: (bar) => set({ ...state, appBar: bar }),
      setStatus: (text, extra) => postStatus(text, extra),
      clearStatus: () => clearStatus(),
      claimBand: (claim) => set({ ...state, band: claim }),
    },
    read: () => state,
    subscribe: (fn) => {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
}

/** The host's live view of what the mounted app is contributing. */
export function useInlineFrameState(
  channel: InlineFrameChannel
): InlineFrameState {
  const { read, subscribe } = channel;
  return useSyncExternalStore(subscribe, read, read);
}

/** One channel per mount. Keyed by the caller's mount key so a re-mount (a new
 *  scope set, a retry) starts from a bar with nothing in it rather than
 *  inheriting the previous mount's title. */
export function useInlineFrameChannel(mountKey: string): InlineFrameChannel {
  // The key is carried IN the state (React's documented
  // adjust-state-on-prop-change pattern) rather than as a memo dependency: the
  // channel is identity that must SURVIVE every re-render and be replaced on
  // exactly one event, and a memo is a cache the runtime is free to drop.
  const [held, setHeld] = useState(() => ({
    channel: createInlineFrameChannel(),
    key: mountKey,
  }));
  if (held.key !== mountKey) {
    const fresh = { channel: createInlineFrameChannel(), key: mountKey };
    setHeld(fresh);
    return fresh.channel;
  }
  return held.channel;
}
