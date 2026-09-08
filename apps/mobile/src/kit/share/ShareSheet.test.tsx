// The native share sheet (#776), and the claims its shape rests on:
//
//  1. THE AUDIENCE IS THE LINKED ROSTER, AND ONLY THAT. A share is delivered
//     into the receiver's own vault, so a person with no approved link has
//     nowhere to receive one and is not offered.
//  2. ONE CONTROL PER PERSON. The role menu carries "no access" as one of its
//     answers, so selecting somebody and choosing what they may do is a single
//     decision in a single place.
//  3. A REUSED CIRCLE OPENS ALREADY SUBMITTING ITS OWN ROSTER, and detaches
//     the moment the member edits one of its capabilities.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @vitest-environment jsdom
import ShareSheet from "./ShareSheet";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  circleMembers: [] as Record<string, unknown>[],
  circles: [] as Record<string, unknown>[],
  containers: [] as Record<string, unknown>[],
  parties: [] as Record<string, unknown>[],
  links: [] as Record<string, unknown>[],
  share: vi.fn<(input: unknown) => Promise<{ claims: unknown[] }>>(),
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
    StyleSheet: { create: <T,>(styles: T): T => styles },
    View: ({ children }: { children?: React.ReactNode }) =>
      element("div", { children }),
  } as never;
});

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

vi.mock(import("../components/Icon"), () => ({ default: () => null }) as never);
vi.mock(
  import("../components/PersonAvatar"),
  () => ({ default: () => null }) as never
);

// The menu is the kit's own, proved by `AnchoredMenu.test.tsx`. Here it is a
// window onto the rows the sheet HANDS it, so a role choice is pressable.
vi.mock(import("../components/AnchoredMenu"), async () => {
  const ReactModule = await import("react");
  return {
    default: ({
      groups,
      visible,
    }: {
      groups: readonly {
        rows: readonly {
          key: string;
          label: string;
          checked?: boolean;
          onSelect: () => void;
        }[];
      }[];
      visible: boolean;
    }) =>
      visible
        ? ReactModule.createElement(
            "div",
            {},
            groups.flatMap((group) =>
              group.rows.map((row) =>
                ReactModule.createElement(
                  "button",
                  {
                    "aria-checked": row.checked,
                    "aria-label": `Menu: ${row.label}`,
                    key: row.key,
                    onClick: row.onSelect,
                    type: "button",
                  },
                  row.label
                )
              )
            )
          )
        : null,
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
              ? [{ self_party_id: "owner" }]
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
        gatewayBase: "http://gateway.local",
        scopes: [],
        session: { share: mocks.share },
      }),
    }) as never
);

vi.mock(
  import("../../lib/replica/links-transport"),
  () => ({ listLinks: () => Promise.resolve(mocks.links) }) as never
);

vi.mock(
  import("../theme"),
  () =>
    ({
      borders: { hairline: 1 },
      radii: { md: 8, pill: 999 },
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
          textFaint: "#faint",
          textInv: "#inv",
          textSoft: "#soft",
        },
      }),
    }) as never
);

/** An approved link to a person's own vault — the only thing that puts them
 *  in this sheet. */
function link(partyId: string, vaultId: string) {
  return {
    vaultA: "owner-vault",
    vaultB: vaultId,
    partyIdA: "owner",
    partyIdB: partyId,
    approved: true,
    revoked: false,
  };
}

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

/** Open one person's role menu and answer it. */
async function setRole(person: string, role: string): Promise<void> {
  const opener = [
    ...container!.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) =>
    candidate.getAttribute("aria-label")?.startsWith(`${person}: `)
  );
  expect(opener, person).toBeInstanceOf(HTMLButtonElement);
  await press(opener!);
  await press(button(`Menu: ${role}`));
}

async function search(text: string): Promise<void> {
  const field = container!.querySelector<HTMLInputElement>(
    'input[aria-label="Search the people you are linked with"]'
  );
  expect(field).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(field, text);
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
  mocks.links = [];
  mocks.share.mockReset();
  mocks.share.mockResolvedValue({ claims: [] });
  onDone.mockReset();
}

function closeSheetContainer(): void {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
}

describe("ShareSheet audience", () => {
  beforeEach(openSheetContainer);
  afterEach(closeSheetContainer);

  it("offers the people this vault is linked to, and nobody else", async () => {
    mocks.parties = [
      { party_id: "asha", display_name: "Asha" },
      { party_id: "ben", display_name: "Ben" },
    ];
    mocks.links = [link("ben", "ben-vault")];
    await render();
    expect(container!.textContent).toContain("Ben");
    // Asha is in People, but no link means nowhere to deliver.
    expect(container!.textContent).not.toContain("Asha");
    expect(container!.textContent).toContain(
      "Everyone you add gets the full shared item in their own vault and backup."
    );
  });

  it("says where a link is made when this vault is linked to nobody", async () => {
    mocks.parties = [{ party_id: "asha", display_name: "Asha" }];
    await render();
    expect(container!.textContent).toContain(
      "Settings → People & circles is where a link is made."
    );
    expect(buttonWithText("Share").getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps a person findable while the roster is long", async () => {
    mocks.parties = [
      { party_id: "asha", display_name: "Asha" },
      { party_id: "ben", display_name: "Ben" },
    ];
    mocks.links = [link("asha", "asha-vault"), link("ben", "ben-vault")];
    await render();
    await search("ben");
    expect(container!.textContent).toContain("Ben");
    expect(container!.textContent).not.toContain("Asha");
  });
});

describe("ShareSheet role", () => {
  beforeEach(() => {
    openSheetContainer();
    mocks.parties = [{ party_id: "ben", display_name: "Ben" }];
    mocks.links = [link("ben", "ben-vault")];
  });
  afterEach(closeSheetContainer);

  it("submits the capability the role menu chose, addressed to their vault", async () => {
    await render();
    // Nobody is selected until a role is chosen: that IS the selection.
    expect(buttonWithText("Share").getAttribute("aria-disabled")).toBe("true");
    await setRole("Ben", "Editor");
    await press(buttonWithText("Share with 1"));
    const [submitted] = mocks.share.mock.calls[0] as [
      { members: Record<string, unknown>[] },
    ];
    expect(submitted.members).toStrictEqual([
      { partyId: "ben", vaultId: "ben-vault", capability: "read+write" },
    ]);
  });

  it("takes the person back out of the share when the answer is no access", async () => {
    await render();
    await setRole("Ben", "Viewer");
    expect(buttonWithText("Share with 1").getAttribute("aria-disabled")).toBe(
      "false"
    );
    await setRole("Ben", "No access");
    expect(buttonWithText("Share").getAttribute("aria-disabled")).toBe("true");
    expect(mocks.share).not.toHaveBeenCalled();
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
    mocks.links = [link("ana", "ana-vault")];
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
      button("Select the group Sitwell Road").getAttribute("aria-selected")
    ).toBe("true");
    await press(buttonWithText("Share with 1"));
    const [submitted] = mocks.share.mock.calls[0] as [Record<string, unknown>];
    expect(submitted["circleId"]).toBe("c1");
    expect(submitted["members"]).toStrictEqual([
      { partyId: "ana", vaultId: "ana-vault", capability: "read" },
    ]);
  });

  it("selects nothing when no circle answers to that id", async () => {
    await render("c-missing");
    expect(buttonWithText("Share").getAttribute("aria-disabled")).toBe("true");
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it("detaches the circle the moment the member edits a capability", async () => {
    await render("c1");
    await setRole("Ana", "Editor");
    await press(buttonWithText("Share with 1"));
    const [submitted] = mocks.share.mock.calls[0] as [Record<string, unknown>];
    expect(submitted["circleId"]).toBeUndefined();
    expect(submitted["members"]).toStrictEqual([
      { partyId: "ana", vaultId: "ana-vault", capability: "read+write" },
    ]);
  });
});
