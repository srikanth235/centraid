import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SHARE_GROUP_META,
  SHARE_GROUP_OFFLINE,
  SHARE_GROUP_VERB,
} from "./tally-seat-copy";
import TallyShareGroup from "./TallyShareGroup";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
});
vi.mock(import("@react-native-async-storage/async-storage"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.asyncStorageStub() as unknown as {
    default: typeof import("@react-native-async-storage/async-storage").default;
  };
});

const replica = vi.hoisted(() => ({
  online: true,
  session: {} as object | undefined,
  vaultId: "vault-owner" as string | undefined,
}));
vi.mock(
  import("../../kit/replica/ReplicaProvider"),
  () => ({ useReplica: () => replica }) as never
);

const groupRows = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock(
  import("../../kit/hooks/useReplicaQuery"),
  () => ({ useReplicaQuery: () => ({ rows: groupRows }) }) as never
);

const sheetProps = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock(
  import("../../kit/share/ShareSheet"),
  () =>
    ({
      default: (props: Record<string, unknown>) => {
        sheetProps.push(props);
        return null;
      },
    }) as never
);

const posted = vi.hoisted(() => [] as string[]);
vi.mock(
  import("../../kit/components/status-line"),
  () =>
    ({
      postStatus: (message: string) => posted.push(message),
      showUndoStatus: (message: string) => posted.push(message),
    }) as never
);

const GROUP = "group-sitwell";

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLElement | undefined;

function show(): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  act(() => {
    root = createRoot(container!);
    root.render(<TallyShareGroup groupId={GROUP} />);
  });
  return container;
}

function shareVerb(): HTMLButtonElement | undefined {
  return [...container!.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(SHARE_GROUP_VERB)
  );
}

describe("sharing a group from the phone", () => {
  beforeEach(() => {
    replica.online = true;
    replica.session = {};
    replica.vaultId = "vault-owner";
    groupRows.length = 0;
    groupRows.push({ group_id: GROUP, circle_id: "circle-sitwell" });
    sheetProps.length = 0;
    posted.length = 0;
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    container = undefined;
    document.body.replaceChildren();
  });

  it("offers the verb where the gateway is reachable", () => {
    const el = show();
    expect(el.textContent).toContain(SHARE_GROUP_VERB);
    expect(el.textContent).toContain(SHARE_GROUP_META);
    expect(shareVerb()?.tagName, "the verb is a control, not prose").toBe(
      "BUTTON"
    );
    expect(sheetProps).toHaveLength(0);
  });

  it("hands the engine the group as its own subject, roster and all", () => {
    show();
    act(() => shareVerb()?.click());
    const props = sheetProps.at(-1);
    expect(props).toMatchObject({
      itemType: "tally.group",
      preferredCircleId: "circle-sitwell",
      sourceVaultId: "vault-owner",
      visible: true,
    });
    expect(props?.["itemIds"]).toStrictEqual([GROUP]);
  });

  it("says the invitation was minted in the gateway's own words", () => {
    show();
    act(() => shareVerb()?.click());
    const onDone = sheetProps.at(-1)?.["onDone"] as (outcome: {
      message: string;
    }) => void;
    act(() => onDone({ message: "Shared with 2 people." }));
    expect(posted).toStrictEqual(["Shared with 2 people."]);
  });

  it("withholds the verb offline and says why, rather than refusing a press", () => {
    replica.online = false;
    const el = show();
    expect(el.textContent).toContain(SHARE_GROUP_OFFLINE);
    expect(el.textContent).not.toContain(SHARE_GROUP_META);
    expect(shareVerb()).toBeUndefined();
    expect(sheetProps).toHaveLength(0);
  });

  it("withholds it just as firmly when this phone has no vault to share from", () => {
    replica.vaultId = undefined;
    const el = show();
    expect(el.textContent).toContain(SHARE_GROUP_OFFLINE);
    expect(shareVerb()).toBeUndefined();
  });
});
// @vitest-environment jsdom
