import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ROOT_STATUS_HOST,
  activeStatusHost,
  claimStatusHost,
  resetStatusHosts,
  subscribeStatusHost,
} from "./status-host";

describe("status host stack", () => {
  afterEach(() => resetStatusHosts());

  it("paints at the root until a presentation claims the line", () => {
    expect(activeStatusHost()).toBe(ROOT_STATUS_HOST);
    const release = claimStatusHost("editor");
    expect(activeStatusHost()).toBe("editor");
    release();
    expect(activeStatusHost()).toBe(ROOT_STATUS_HOST);
  });

  // THE BUG THIS ANSWERS (#1015, S3 — audit B5): every editor on this seat is
  // an iOS `Modal`, which renders above the app root, so a note posted from
  // inside one was painted underneath it and never seen.
  it("gives the line to the newest claim", () => {
    claimStatusHost("editor");
    const releaseSheet = claimStatusHost("sheet");
    expect(activeStatusHost()).toBe("sheet");
    releaseSheet();
    expect(activeStatusHost()).toBe("editor");
  });

  it("releases by identity, not by popping the top", () => {
    // A modal dismissed under a sheet unmounts out of order; popping blind
    // would leave a dead id holding a line nothing paints.
    const releaseEditor = claimStatusHost("editor");
    claimStatusHost("sheet");
    releaseEditor();
    expect(activeStatusHost()).toBe("sheet");
  });

  it("treats a second release as a no-op", () => {
    const release = claimStatusHost("editor");
    release();
    release();
    expect(activeStatusHost()).toBe(ROOT_STATUS_HOST);
  });

  it("notifies subscribers on claim and release", () => {
    const fn = vi.fn<() => void>();
    const stop = subscribeStatusHost(fn);
    const release = claimStatusHost("editor");
    expect(fn).toHaveBeenCalledOnce();
    release();
    expect(fn).toHaveBeenCalledTimes(2);
    stop();
    claimStatusHost("another");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
