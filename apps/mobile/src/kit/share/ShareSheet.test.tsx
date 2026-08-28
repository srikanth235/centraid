// The native sheet's quick-add path (#776).
//
// Three claims live here, and they are the ones that make quick-add safe to
// ship on a device that may be offline:
//
//  1. A SETTLED PERSON IS SELECTED, AND ONLY THEIR REAL ID IS SUBMITTED. The
//     gateway takes a party id as an opaque string, so a share carrying an
//     unsettled id would durably record an identity nobody has.
//  2. A QUEUED PERSON IS NOT SELECTED. Their row still appears — the member
//     added them and the outbox overlay shows it — but it is an honest UI
//     overlay, not a domain record, so the sheet says so and refuses it.
//  3. A NEAR NAME MATCH COMMITS NOTHING on the first press. Ambiguous input
//     asks before it mints a second identity for the same person (#630).
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @vitest-environment jsdom
import ShareSheet from "./ShareSheet";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface WriteResult {
  intentId: string;
  status: string;
  output?: Record<string, unknown>;
  reason?: string;
}

const mocks = vi.hoisted(() => ({
  circleMembers: [] as Record<string, unknown>[],
  circles: [] as Record<string, unknown>[],
  containers: [] as Record<string, unknown>[],
  parties: [] as Record<string, unknown>[],
  share: vi.fn<(input: unknown) => Promise<{ claims: unknown[] }>>(),
  write: vi.fn<(appId: string, input: unknown) => Promise<unknown>>(),
}));

vi.mock(import("react-native"), async () => {
  const ReactModule = await import("react");
  const element = (
    tag: string,
    props: Record<string, unknown> & { children?: React.ReactNode } = {}
  ): React.JSX.Element => {
    const { children, ...rest } = props;
    return ReactModule.createElement(tag, rest, children);
  };
  return {
    Modal: ({
      children,
      visible,
    }: {
      children?: React.ReactNode;
      visible?: boolean;
    }) => (visible === false ? null : element("div", { children })),
    Pressable: ({
      accessibilityLabel,
      accessibilityState,
      children,
      disabled,
      onPress,
    }: {
      accessibilityLabel?: string;
      accessibilityState?: { disabled?: boolean; selected?: boolean };
      children?: React.ReactNode;
      disabled?: boolean;
      onPress?: () => void;
    }) =>
      element("button", {
        "aria-disabled": Boolean(disabled || accessibilityState?.disabled),
        "aria-label": accessibilityLabel,
        "aria-selected": accessibilityState?.selected,
        children,
        onClick: disabled ? undefined : onPress,
        type: "button",
      }),
    ScrollView: ({ children }: { children?: React.ReactNode }) =>
      element("div", { children }),
    Share: { share: vi.fn<() => void>() },
    StyleSheet: { create: <T,>(styles: T): T => styles },
    View: ({ children }: { children?: React.ReactNode }) =>
      element("div", { children }),
  } as never;
});

vi.mock(
  import("expo-clipboard"),
  () => ({ setStringAsync: vi.fn<() => Promise<void>>() }) as never
);

vi.mock(import("../components/NativeText"), async () => {
  const ReactModule = await import("react");
  return {
    Text: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("span", {}, children),
    TextInput: ({
      accessibilityLabel,
      onChangeText,
      value,
    }: {
      accessibilityLabel?: string;
      onChangeText?: (next: string) => void;
      value?: string;
    }) =>
      ReactModule.createElement("input", {
        "aria-label": accessibilityLabel,
        onChange: (event: { target: { value: string } }) =>
          onChangeText?.(event.target.value),
        value: value ?? "",
      }),
  } as never;
});

vi.mock(import("../components/TopSafeArea"), async () => {
  const ReactModule = await import("react");
  return {
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement("div", {}, children),
  } as never;
});

vi.mock(
  import("../hooks/useReplicaQuery"),
  () =>
    ({
      useReplicaQuery: (_appId: string, request: { entity: string }) => ({
        rows:
          request.entity === "core.party"
            ? mocks.parties
            : request.entity === "core.vault"
              ? [{ owner_party_id: "owner" }]
              : request.entity === "social.circle"
                ? mocks.circles
                : request.entity === "social.circle_member"
                  ? mocks.circleMembers
                  : mocks.containers,
      }),
    }) as never
);

vi.mock(
  import("../replica/ReplicaProvider"),
  () =>
    ({
      useReplica: () => ({
        gatewayBase: "",
        scopes: [],
        session: { share: mocks.share, write: mocks.write },
      }),
    }) as never
);

vi.mock(
  import("../../lib/replica/links-transport"),
  () => ({ listLinks: () => Promise.resolve([]) }) as never
);

vi.mock(
  import("../theme"),
  () =>
    ({
      borders: { hairline: 1 },
      radii: { md: 8 },
      spacing: Array.from({ length: 8 }, (_, index) => index * 4),
      t: () => ({}),
      useTheme: () => ({
        colors: {
          accent: "#accent",
          bg: "#bg",
          bgElev: "#elev",
          bgSunken: "#sunk",
          line: "#line",
          text: "#text",
          textInv: "#inv",
          textSoft: "#soft",
        },
      }),
    }) as never
);

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const onDone = vi.fn<(outcome: unknown) => void>();

async function render(preferredCircleId?: string): Promise<void> {
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <ShareSheet
        itemIds={["item-1"]}
        itemType="docs.folder"
        noun="Folder"
        onClose={vi.fn<() => void>()}
        onDone={onDone}
        sourceVaultId="owner-vault"
        visible
        {...(preferredCircleId ? { preferredCircleId } : {})}
      />
    );
  });
}

function button(label: string): HTMLButtonElement {
  const found = container!.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`
  );
  expect(found, label).toBeTruthy();
  return found!;
}

function buttonWithText(text: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text
  );
  expect(found, text).toBeTruthy();
  return found as HTMLButtonElement;
}

async function press(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function type(text: string): Promise<void> {
  const field = container!.querySelector<HTMLInputElement>(
    'input[aria-label="Name of someone to add"]'
  );
  expect(field).toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(field, text);
    field!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function openSheetContainer(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  mocks.circleMembers = [];
  mocks.circles = [];
  mocks.containers = [];
  mocks.parties = [];
  mocks.share.mockReset();
  mocks.share.mockResolvedValue({ claims: [] });
  mocks.write.mockReset();
  onDone.mockReset();
}

function closeSheetContainer(): void {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
}

describe("ShareSheet quick-add", () => {
  beforeEach(openSheetContainer);
  afterEach(closeSheetContainer);

  it("selects a person the gateway settled, and submits their real party id", async () => {
    mocks.write.mockImplementation(async () => {
      mocks.parties = [
        ...mocks.parties,
        { party_id: "p9", display_name: "Nadia" },
      ];
      return {
        intentId: "i1",
        status: "executed",
        output: { party_id: "p9" },
      } satisfies WriteResult;
    });
    await render();
    await type("Nadia");
    await press(button("Add this person"));

    expect(mocks.write).toHaveBeenCalledWith("people", {
      action: "add-person",
      input: { display_name: "Nadia", cadence_days: 30 },
    });
    await press(buttonWithText("Share"));
    expect(mocks.share).toHaveBeenCalledOnce();
    const [submitted] = mocks.share.mock.calls[0] as [
      { members: { partyId?: string; capability: string }[] },
    ];
    const members = submitted.members;
    expect(members).toStrictEqual([{ partyId: "p9", capability: "read" }]);
    expect(
      members.every((member) => !member.partyId?.startsWith("pending:"))
    ).toBe(true);
  });

  it("selects nobody when the add is queued offline, and says when they become selectable", async () => {
    mocks.write.mockImplementation(async () => {
      // What the outbox overlay projects while the write waits: a row whose
      // party id no vault has settled.
      mocks.parties = [
        ...mocks.parties,
        { party_id: "pending:i2:party", display_name: "Nadia" },
      ];
      return { intentId: "i2", status: "queued" } satisfies WriteResult;
    });
    await render();
    await type("Nadia");
    await press(button("Add this person"));

    expect(container!.textContent).toContain(
      "Nadia is saved on this device — selectable once the gateway has them."
    );
    // The row is visible and honest about itself, and pressing it selects
    // nothing — so Share stays unavailable and no member array exists to send.
    const row = button("Nadia cannot be shared with yet");
    await press(row);
    expect(buttonWithText("Share").getAttribute("aria-disabled")).toBe("true");
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it("asks before minting a second identity for a name already on the list", async () => {
    mocks.parties = [{ party_id: "asha", display_name: "Asha" }];
    mocks.write.mockResolvedValue({
      intentId: "i3",
      status: "executed",
      output: { party_id: "p10" },
    } satisfies WriteResult);
    await render();
    await type("asha");
    expect(container!.textContent).toContain("Already on this list: Asha");
    await press(button("Add anyway"));
    expect(mocks.write).not.toHaveBeenCalled();
    expect(container!.textContent).toContain("Nobody was added yet");

    await press(button("Add anyway"));
    expect(mocks.write).toHaveBeenCalledOnce();
  });
});

// A container that reuses its OWN circle is bound server-side to that circle's
// exact stored roster and capabilities, so the sheet has to open already
// submitting them — "choose people individually" would default every pick to
// `read+write` and be refused for the drift.
describe("ShareSheet preferred circle", () => {
  beforeEach(() => {
    openSheetContainer();
    mocks.parties = [{ party_id: "ana", display_name: "Ana" }];
    mocks.circles = [
      { circle_id: "c1", owner_party_id: "owner", name: "Sitwell Road" },
    ];
    mocks.circleMembers = [
      { circle_id: "c1", party_id: "owner", capability: "read+write" },
      { circle_id: "c1", party_id: "ana", capability: "read" },
    ];
    mocks.containers = [{ group_id: "item-1", circle_id: "c1" }];
  });

  afterEach(closeSheetContainer);

  it("opens with that circle selected, sourcing capability from its roster", async () => {
    await render("c1");
    expect(
      buttonWithText("Named group · Sitwell Road").getAttribute("aria-selected")
    ).toBe("true");
    await press(buttonWithText("Share"));
    const [submitted] = mocks.share.mock.calls[0] as [Record<string, unknown>];
    expect(submitted["circleId"]).toBe("c1");
    expect(submitted["members"]).toStrictEqual([
      { partyId: "ana", capability: "read" },
    ]);
  });

  it("selects nothing when no circle answers to that id", async () => {
    await render("c-missing");
    expect(buttonWithText("Share").getAttribute("aria-disabled")).toBe("true");
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it("detaches the circle the moment the member edits a capability", async () => {
    await render("c1");
    await press(buttonWithText("Can edit"));
    await press(buttonWithText("Share"));
    const [submitted] = mocks.share.mock.calls[0] as [Record<string, unknown>];
    expect(submitted["circleId"]).toBeUndefined();
    expect(submitted["members"]).toStrictEqual([
      { partyId: "ana", capability: "read+write" },
    ]);
  });
});
