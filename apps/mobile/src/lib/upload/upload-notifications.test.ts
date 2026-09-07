// The queue announcing itself is what replaced the timeline's 4 s/30 s poll
// (#996 wave 3), so the two properties that make a notice usable are held
// here: everyone hears it, and a subscriber's own failure is its own.
import { describe, expect, it, vi } from "vitest";

import {
  notifyUploadQueueChanged,
  onUploadQueueChanged,
} from "./upload-notifications";

describe("the upload queue's change notice", () => {
  it("reaches every listener", () => {
    const first = vi.fn<() => void>();
    const second = vi.fn<() => void>();
    const offFirst = onUploadQueueChanged(first);
    const offSecond = onUploadQueueChanged(second);
    try {
      notifyUploadQueueChanged();
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
    } finally {
      offFirst();
      offSecond();
    }
  });

  it("carries no payload: the reader re-reads the queue", () => {
    // A notice carrying rows would be a second, staler copy of the answer the
    // reader is about to compute for itself.
    const listener = vi.fn<(...args: unknown[]) => void>();
    const off = onUploadQueueChanged(listener);
    try {
      notifyUploadQueueChanged();
      expect(listener.mock.calls[0]).toStrictEqual([]);
    } finally {
      off();
    }
  });

  it("does not let one subscriber's throw silence the next", () => {
    const after = vi.fn<() => void>();
    const offThrower = onUploadQueueChanged(() => {
      throw new Error("a screen tore down mid-notice");
    });
    const offAfter = onUploadQueueChanged(after);
    try {
      expect(() => notifyUploadQueueChanged()).not.toThrow();
      expect(after).toHaveBeenCalledOnce();
    } finally {
      offThrower();
      offAfter();
    }
  });

  it("stops calling an unsubscribed listener", () => {
    const listener = vi.fn<() => void>();
    onUploadQueueChanged(listener)();
    notifyUploadQueueChanged();
    expect(listener).not.toHaveBeenCalled();
  });
});
