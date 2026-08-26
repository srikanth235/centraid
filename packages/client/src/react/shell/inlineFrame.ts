import { useState, useSyncExternalStore } from "react";

import type {
  InlineAppBarContribution,
  InlineBandClaim,
  InlineFrame,
} from "@centraid/blueprints/apps/inline-types";

import { clearStatus, postStatus } from "./statusChannel.js";

// Store, not context: Root is under the Suspense host that renders the bar. Status stays on statusChannel.

export interface InlineFrameState {
  appBar: InlineAppBarContribution | null;
  band: InlineBandClaim | null;
}

const EMPTY: InlineFrameState = { appBar: null, band: null };

export interface InlineFrameChannel {
  frame: InlineFrame;
  subscribe: (fn: () => void) => () => void;
  read: () => InlineFrameState;
}

export function createInlineFrameChannel(): InlineFrameChannel {
  let state = EMPTY;
  const subscribers = new Set<() => void>();

  const emit = (): void => {
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

export function useInlineFrameState(
  channel: InlineFrameChannel
): InlineFrameState {
  const { read, subscribe } = channel;
  return useSyncExternalStore(subscribe, read, read);
}

export function useInlineFrameChannel(mountKey: string): InlineFrameChannel {
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
