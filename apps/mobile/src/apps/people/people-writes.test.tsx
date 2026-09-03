// An offline add is a SUCCESS, not a failure (#880). QUALITY.md recorded
// People closing its add form only on `executed`, so a durable queued row
// read as nothing having happened.
// @vitest-environment jsdom
import React, { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import type { NativeWriteResult } from "../../lib/replica/native-session";
import { mountBlock } from "../../test/react-native-stub";

const posted: string[] = [];
const written: Array<{ action: string; input: Record<string, unknown> }> = [];
let outcome: NativeWriteResult = {
  intentId: "intent-1",
  status: "executed",
};

vi.mock(import("../../kit/components/status-line"), () => ({
  postStatus: (text: string) => {
    posted.push(text);
  },
}));

vi.mock(
  import("../../kit/replica/ReplicaProvider"),
  () =>
    ({
      useReplica: () => ({
        session: {
          write: (
            _app: string,
            request: { action: string; input: Record<string, unknown> }
          ) => {
            written.push(request);
            return Promise.resolve(outcome);
          },
        },
      }),
    }) as unknown as typeof import("../../kit/replica/ReplicaProvider")
);

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
});

const { usePeopleWrites } = await import("./people-writes");

function Probe({
  onReady,
}: {
  onReady: (api: ReturnType<typeof usePeopleWrites>) => void;
}): null {
  const api = usePeopleWrites(() => undefined);
  useEffect(() => {
    onReady(api);
  }, [api, onReady]);
  return null;
}

function writes(): {
  api: ReturnType<typeof usePeopleWrites>;
  unmount: () => void;
} {
  const captured: ReturnType<typeof usePeopleWrites>[] = [];
  const mounted = mountBlock(<Probe onReady={(api) => captured.push(api)} />);
  return { api: captured[0]!, unmount: mounted.unmount };
}

const DRAFT = {
  party_id: null,
  name: "Ana",
  role: "",
  avatar_color: null,
  cadence_days: 0,
};

describe("adding a person while the gateway is out of reach", () => {
  it("treats a queued add as landed, so the form closes on a durable row", async () => {
    posted.length = 0;
    written.length = 0;
    outcome = { intentId: "intent-1", status: "queued" };
    const probe = writes();
    await expect(probe.api.savePerson(DRAFT, null)).resolves.toBe(true);
    probe.unmount();
    expect(written[0]?.action).toBe("add-person");
    expect(posted).toContain("This People change will sync automatically.");
  });

  it("still refuses to close on a rejected write", async () => {
    posted.length = 0;
    outcome = {
      intentId: "intent-1",
      status: "failed",
      reason: "The vault rejected this change.",
    };
    const probe = writes();
    await expect(probe.api.savePerson(DRAFT, null)).resolves.toBe(false);
    probe.unmount();
  });

  it("treats an executed add as landed too — one path, two outcomes", async () => {
    posted.length = 0;
    outcome = { intentId: "intent-1", status: "executed" };
    const probe = writes();
    await expect(probe.api.savePerson(DRAFT, null)).resolves.toBe(true);
    probe.unmount();
  });
});
