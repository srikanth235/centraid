import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { VaultBridgeProps, VaultData } from "../screen-contracts.js";
import VaultScreen from "./VaultScreen.js";

const block: VaultBridgeProps["block"] = {
  why: "To summarize them.",
  scopes: [{ schema: "notes", table: "note", verbs: "read" }],
};

const baseData: VaultData = {
  vaultName: "home",
  parked: [],
};

function makeProps(over: Partial<VaultBridgeProps> = {}): VaultBridgeProps {
  return {
    block,
    confirm: vi.fn<VaultBridgeProps["confirm"]>().mockResolvedValue(undefined),
    demoLoad: vi
      .fn<VaultBridgeProps["demoLoad"]>()
      .mockResolvedValue(undefined),
    demoPurge: vi
      .fn<VaultBridgeProps["demoPurge"]>()
      .mockResolvedValue(undefined),
    loadData: vi.fn<VaultBridgeProps["loadData"]>().mockResolvedValue(baseData),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

describe("screens/VaultScreen", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  async function mount(props: VaultBridgeProps): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(<VaultScreen {...props} />);
    });
    return container;
  }

  describe(VaultScreen, () => {
    it("always shows the declared-access section (even before data loads)", () => {
      const html = renderToStaticMarkup(<VaultScreen {...makeProps()} />);
      expect(html).toContain("Declared access");
      expect(html).toContain("notes.note");
      expect(html).toContain("To summarize them.");
    });

    // AN APP DECLARES; IT IS NOT GRANTED (#928 A1). A button offering to give
    // or take away what the manifest already fixes would be a promise this
    // pane cannot keep, so there is none to find.
    it("offers no grant or revoke control at all", async () => {
      const el = await mount(makeProps());
      expect(el.querySelector(".grantBtn")).toBeNull();
      expect(el.querySelector(".revokeBtn")).toBeNull();
      expect(el.textContent).not.toContain("No access yet");
    });

    it("reports the parked count and renders parked cards", async () => {
      const onParkedCount =
        vi.fn<NonNullable<VaultBridgeProps["onParkedCount"]>>();
      const data: VaultData = {
        ...baseData,
        parked: [
          {
            invocationId: "iv1",
            command: "notes.write",
            parkedAt: new Date().toISOString(),
            callerKind: "app",
            caller: "notes",
            input: { title: "hi" },
          },
        ],
      };
      const loadData = vi
        .fn<VaultBridgeProps["loadData"]>()
        .mockResolvedValue(data);
      const el = await mount(makeProps({ loadData, onParkedCount }));
      expect(onParkedCount).toHaveBeenCalledWith(1);
      expect(el.textContent).toContain("Waiting for your say-so");
      expect(el.querySelector(".approveBtn")).toBeTruthy();
    });

    it("shows the no-vault note when loadData resolves null", async () => {
      const loadData = vi
        .fn<VaultBridgeProps["loadData"]>()
        .mockResolvedValue(null);
      const el = await mount(makeProps({ loadData }));
      expect(el.textContent).toContain("No vault is mounted");
    });
  });
});
