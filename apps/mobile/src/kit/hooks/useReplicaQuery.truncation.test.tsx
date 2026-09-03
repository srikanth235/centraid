// @vitest-environment jsdom
/**
 * THE PHONE'S READ BOUNDARY, AND THE LINE IT PRINTS (#922 0a).
 *
 * The phone is the seat the correctness hole hurt most: a roster silently
 * capped at 1,000 is a screen a member counts and believes. So this suite
 * exercises the hook end to end — an undeclared window is refused before the
 * read runs, an accepted default is answered and its truncation surfaced, and
 * a declared window is answered plainly — plus the one render that proves the
 * phrase reaches a screen rather than only a state object.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { truncatedListNotice } from "@centraid/blueprints/apps/_shared/shared-copy";

import { mountBlock } from "../../test/react-native-stub";
import type { ReplicaContextValue } from "../replica/replica-context";

// The DOM-stub tier's host mocks, called through one lazy import rather than
// restated as four copied factories — the preamble every stub-tier file used to
// repeat verbatim (#922 0a, Sonar duplication).
const hosts = () => import("../../test/react-native-stub");

vi.mock(
  import("react-native"),
  async () =>
    (
      await hosts()
    ).reactNativeStub() as unknown as typeof import("react-native")
);
vi.mock(
  import("@react-native-async-storage/async-storage"),
  async () =>
    (await hosts()).asyncStorageStub() as unknown as {
      default: typeof import("@react-native-async-storage/async-storage").default;
    }
);
vi.mock(
  import("react-native-svg"),
  async () =>
    (await hosts()).svgStub() as unknown as typeof import("react-native-svg")
);
vi.mock(import("react-native-safe-area-context"), () => ({
  useSafeAreaInsets: () => ({ bottom: 34, left: 0, right: 0, top: 47 }),
}));

const reads: Array<Record<string, unknown>> = [];
let answer: Record<string, unknown> = {};

// ONE stable context value. The hook keys its effect on the session identity;
// a fresh object per render would re-read forever and this file would be
// measuring that loop instead of the boundary.
const REPLICA = {
  ready: true,
  reachability: "current" as const,
  scopes: [],
  session: {
    read: (_appId: string, request: Record<string, unknown>) => {
      reads.push(request);
      return Promise.resolve({
        rows: [],
        cursor: { epoch: "e", seq: 1 },
        dependency: { shapeId: "s", entity: request["entity"] },
        ...answer,
      });
    },
    subscribe: () => () => {},
  },
};

vi.mock(import("../replica/ReplicaProvider"), () => ({
  useReplica: () => REPLICA as unknown as ReplicaContextValue,
}));

const { useReplicaQuery } = await import("./useReplicaQuery");
const { postStatus, readStatus } = await import("../components/status-line");
// `resetStatus` is a test-only verb, so the kit's re-export deliberately does
// not carry it; the channel is one module instance either way.
const { resetStatus } = await import("@centraid/client/status-channel");

function Probe(props: { request: Record<string, unknown> }): React.JSX.Element {
  const state = useReplicaQuery("people", props.request as never);
  return (
    <>
      <span data-testid="error">{state.error ?? ""}</span>
      <span data-testid="notice">{state.truncationNotice ?? ""}</span>
    </>
  );
}

const text = (container: HTMLElement, id: string): string =>
  container.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

async function settle(): Promise<void> {
  // Two macrotask turns: the read resolves, then React commits its state.
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

// STABLE IDENTITIES. `useReplicaQuery` keys its effect on the request object,
// exactly as every screen's `useMemo` does; a literal rebuilt per render would
// re-read forever and this file would be measuring that instead.
const UNBOUNDED = { entity: "core.party" };
const ACCEPTED = { entity: "core.party", acceptTruncation: true };
const WINDOWED = { entity: "core.party", limit: 5000 };

describe("useReplicaQuery read boundary", () => {
  afterEach(() => {
    reads.length = 0;
    answer = {};
    resetStatus();
  });

  it("refuses an unbounded read before it runs, naming the entity and the fix", async () => {
    const { container, unmount } = mountBlock(<Probe request={UNBOUNDED} />);
    await settle();
    const message = text(container, "error");
    expect(message).toContain("core.party");
    expect(message).toContain("acceptTruncation");
    expect(reads).toHaveLength(0);
    unmount();
  });

  it("answers an accepted default and surfaces the truncation", async () => {
    answer = { truncated: true, appliedLimit: 1000 };
    const { container, unmount } = mountBlock(<Probe request={ACCEPTED} />);
    await settle();
    expect(reads).toHaveLength(1);
    expect(text(container, "error")).toBe("");
    expect(text(container, "notice")).toBe(truncatedListNotice(1000));
    expect(readStatus()?.text).toBe(truncatedListNotice(1000));
    unmount();
  });

  it("answers a declared window plainly", async () => {
    const { container, unmount } = mountBlock(<Probe request={WINDOWED} />);
    await settle();
    expect(reads).toHaveLength(1);
    expect(text(container, "error")).toBe("");
    expect(text(container, "notice")).toBe("");
    expect(readStatus()).toBeNull();
    unmount();
  });
});

describe("the truncation line on screen", () => {
  afterEach(() => {
    resetStatus();
  });

  it("renders on the phone's one status line", async () => {
    const StatusLine = (await import("../components/StatusLine")).default;
    postStatus(truncatedListNotice(1000));
    const { container, unmount } = mountBlock(<StatusLine />);
    expect(container.textContent).toContain("Showing the newest 1,000");
    expect(container.textContent).toContain("more not loaded");
    unmount();
  });
});
