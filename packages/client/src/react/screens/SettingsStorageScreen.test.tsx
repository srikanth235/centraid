import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import SettingsStorageScreen, {
  type SettingsStorageBridgeProps,
  type StorageConnectionRowDTO,
} from "./SettingsStorageScreen.js";

function makeRow(
  over: Partial<StorageConnectionRowDTO> = {}
): StorageConnectionRowDTO {
  return {
    id: "c1",
    name: "My Home",
    baseUrl: "https://storage.example.com",
    ...over,
  };
}

function makeProps(
  over: Partial<SettingsStorageBridgeProps> = {}
): SettingsStorageBridgeProps {
  return {
    loadConnections: vi
      .fn<SettingsStorageBridgeProps["loadConnections"]>()
      .mockResolvedValue([makeRow()]),
    createConnection: vi
      .fn<SettingsStorageBridgeProps["createConnection"]>()
      .mockResolvedValue({ ok: true, value: makeRow() }),
    deleteConnection: vi
      .fn<SettingsStorageBridgeProps["deleteConnection"]>()
      .mockResolvedValue(undefined),
    testConnection: vi
      .fn<SettingsStorageBridgeProps["testConnection"]>()
      .mockResolvedValue({ ok: true, detail: "signed request accepted" }),
    loadVaultBlobStore: vi
      .fn<SettingsStorageBridgeProps["loadVaultBlobStore"]>()
      .mockResolvedValue({ kind: "fs" }),
    attachVaultConnection: vi
      .fn<SettingsStorageBridgeProps["attachVaultConnection"]>()
      .mockResolvedValue({
        ok: true,
        value: { kind: "s3", connectionId: "c1" },
      }),
    detachVaultConnection: vi
      .fn<SettingsStorageBridgeProps["detachVaultConnection"]>()
      .mockResolvedValue({ kind: "fs" }),
    showToast: vi.fn<SettingsStorageBridgeProps["showToast"]>(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
describe("screens/SettingsStorageScreen", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  async function mount(
    props: SettingsStorageBridgeProps
  ): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(<SettingsStorageScreen {...props} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    return container;
  }

  const setNativeValue = (input: HTMLInputElement, value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const fieldInputBy =
    (el: HTMLElement) =>
    (labelText: string): HTMLInputElement | null => {
      const field = [...el.querySelectorAll(".field")].find((f) =>
        f.querySelector(".fieldLabel")?.textContent?.includes(labelText)
      );
      return field?.querySelector("input") ?? null;
    };

  describe("SettingsStorageScreen — hosted provider", () => {
    it("renders the connected provider row with its Hosted badge and base URL", async () => {
      const el = await mount(makeProps());
      expect(
        el.querySelectorAll('[data-testid="storage-connection-row"]')
      ).toHaveLength(1);
      expect(el.textContent).toContain("My Home");
      expect(el.textContent).toContain("Hosted");
      expect(el.textContent).toContain("storage.example.com");
    });

    it("shows the connect empty state when no provider is connected", async () => {
      const el = await mount(
        makeProps({
          loadConnections: vi
            .fn<SettingsStorageBridgeProps["loadConnections"]>()
            .mockResolvedValue([]),
        })
      );
      expect(el.textContent).toContain("No storage provider connected yet.");
      expect(
        [...el.querySelectorAll("button")].some((b) =>
          b.textContent?.includes("Connect your storage provider")
        )
      ).toBe(true);
    });

    it('has no connection-kind toggle, no "use for" checkboxes, and no BYO-S3 fields', async () => {
      const el = await mount(
        makeProps({
          loadConnections: vi
            .fn<SettingsStorageBridgeProps["loadConnections"]>()
            .mockResolvedValue([]),
        })
      );
      const connectBtn = [...el.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Connect your storage provider")
      );
      await act(async () =>
        connectBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      expect(el.textContent).not.toContain("Bring your own S3");
      expect(el.textContent).not.toContain("Use for");
      expect(el.textContent).not.toContain("CAS");
      expect(el.textContent).not.toContain("Access key ID");
      // Only the guided provider fields.
      expect(el.textContent).toContain("Provider URL");
      expect(el.textContent).toContain("Access key");
    });

    it("Test connection shows the ok result inline", async () => {
      const el = await mount(makeProps());
      const testBtn = [...el.querySelectorAll("button")].find(
        (b) => b.textContent === "Test connection"
      );
      await act(async () =>
        testBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      await act(async () => {
        await Promise.resolve();
      });
      const result = el.querySelector<HTMLElement>(
        '[data-testid="storage-test-result"]'
      );
      expect(result?.dataset.ok).toBe("true");
      expect(result?.textContent).toContain("signed request accepted");
    });

    it("Disconnect calls deleteConnection with id + name and refreshes", async () => {
      const props = makeProps();
      const el = await mount(props);
      const deleteBtn = [...el.querySelectorAll("button")].find(
        (b) => b.textContent === "Disconnect"
      );
      await act(async () =>
        deleteBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(props.deleteConnection).toHaveBeenCalledWith("c1", "My Home");
      expect(props.loadConnections).toHaveBeenCalledTimes(2); // initial + post-delete refresh
    });

    it("connects a provider from the guided form (name optional)", async () => {
      const props = makeProps({
        loadConnections: vi
          .fn<SettingsStorageBridgeProps["loadConnections"]>()
          .mockResolvedValue([]),
      });
      const el = await mount(props);
      const connectBtn = [...el.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Connect your storage provider")
      );
      await act(async () =>
        connectBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );

      const field = fieldInputBy(el);
      await act(async () => {
        setNativeValue(field("Provider URL")!, "https://storage.example.com");
        setNativeValue(field("Access key")!, "sekret-key");
      });

      const saveBtn = [...el.querySelectorAll(".wizard button")].find((b) =>
        b.textContent?.includes("Connect")
      );
      expect(saveBtn?.hasAttribute("disabled")).toBe(false);
      await act(async () =>
        saveBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      await act(async () => {
        await Promise.resolve();
      });

      expect(props.createConnection).toHaveBeenCalledWith({
        name: "Hosted storage",
        baseUrl: "https://storage.example.com",
        apiKey: "sekret-key",
      });
      expect(el.querySelector(".wizard")).toBeNull(); // closed on success
    });

    it("surfaces a provider_not_home_profile error in plain language", async () => {
      const props = makeProps({
        loadConnections: vi
          .fn<SettingsStorageBridgeProps["loadConnections"]>()
          .mockResolvedValue([]),
        createConnection: vi
          .fn<SettingsStorageBridgeProps["createConnection"]>()
          .mockResolvedValue({
            ok: false,
            code: "error",
            message:
              "This provider can’t be a home for your data. It’s missing: inventory, audit.",
          }),
      });
      const el = await mount(props);
      const connectBtn = [...el.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Connect your storage provider")
      );
      await act(async () =>
        connectBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      const field = fieldInputBy(el);
      await act(async () => {
        setNativeValue(field("Provider URL")!, "https://weak.example.com");
        setNativeValue(field("Access key")!, "k");
      });
      const saveBtn = [...el.querySelectorAll(".wizard button")].find((b) =>
        b.textContent?.includes("Connect")
      );
      await act(async () =>
        saveBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      await act(async () => {
        await Promise.resolve();
      });
      const err = el.querySelector('[data-testid="connect-error"]');
      expect(err?.textContent).toContain("can’t be a home for your data");
      expect(err?.textContent).toContain("inventory, audit");
    });
  });

  describe("SettingsStorageScreen — recovery-kit gate", () => {
    async function openFormAndSubmit(
      props: SettingsStorageBridgeProps
    ): Promise<HTMLDivElement> {
      const el = await mount(props);
      const connectBtn = [...el.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Connect your storage provider")
      );
      await act(async () =>
        connectBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      const field = fieldInputBy(el);
      await act(async () => {
        setNativeValue(field("Provider URL")!, "https://storage.example.com");
        setNativeValue(field("Access key")!, "k");
      });
      const saveBtn = [...el.querySelectorAll(".wizard button")].find((b) =>
        b.textContent?.includes("Connect")
      );
      await act(async () =>
        saveBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      await act(async () => {
        await Promise.resolve();
      });
      return el;
    }

    it("shows a hard gate that directs the owner to the real Storage ceremony", async () => {
      const createConnection = vi
        .fn<SettingsStorageBridgeProps["createConnection"]>()
        .mockResolvedValue({
          ok: false,
          code: "recovery_kit_not_confirmed",
          message: "confirm you have exported the recovery kit",
        });
      const props = makeProps({
        createConnection,
        loadConnections: vi
          .fn<SettingsStorageBridgeProps["loadConnections"]>()
          .mockResolvedValue([]),
      });
      const el = await openFormAndSubmit(props);

      const dialog = el.querySelector("dialog");
      expect(dialog).toBeTruthy();
      expect(dialog?.textContent).toContain(
        "confirm you have exported the recovery kit"
      );
      expect(dialog?.textContent).toContain("Open the Storage page");
      expect(dialog?.textContent).not.toContain("Proceed anyway");
      expect(dialog?.textContent).not.toContain("I've saved my recovery kit");
      expect(createConnection).toHaveBeenCalledOnce();
    });
  });

  describe("SettingsStorageScreen — per-vault hosted/local choice", () => {
    // The toggle is a native radio group: the visible text lives on the styled
    // <label>, the state (checked/disabled) on the <input> it wraps.
    const option = (el: HTMLElement, text: string): HTMLInputElement | null => {
      const label = [...el.querySelectorAll("label")].find(
        (l) => l.textContent === text
      );
      return (
        label?.querySelector<HTMLInputElement>('input[type="radio"]') ?? null
      );
    };

    it('shows "On this device" active and the local hint when nothing is hosted', async () => {
      const el = await mount(makeProps());
      expect(option(el, "On this device")?.checked).toBe(true);
      expect(el.textContent).toContain("Everything stays on this machine");
    });

    it("shows Hosted active when the vault is attached", async () => {
      const props = makeProps({
        loadVaultBlobStore: vi
          .fn<SettingsStorageBridgeProps["loadVaultBlobStore"]>()
          .mockResolvedValue({ kind: "s3", connectionId: "c1" }),
      });
      const el = await mount(props);
      expect(option(el, "Hosted")?.checked).toBe(true);
      expect(el.textContent).toContain("one sealed bundle with your provider");
    });

    it("clicking Hosted attaches to the home connection", async () => {
      const props = makeProps();
      const el = await mount(props);
      const hosted = option(el, "Hosted");
      await act(async () => hosted?.click());
      await act(async () => {
        await Promise.resolve();
      });
      expect(props.attachVaultConnection).toHaveBeenCalledWith("c1");
    });

    it('clicking "On this device" while hosted detaches', async () => {
      const props = makeProps({
        loadVaultBlobStore: vi
          .fn<SettingsStorageBridgeProps["loadVaultBlobStore"]>()
          .mockResolvedValue({ kind: "s3", connectionId: "c1" }),
      });
      const el = await mount(props);
      const device = option(el, "On this device");
      await act(async () => device?.click());
      await act(async () => {
        await Promise.resolve();
      });
      expect(props.detachVaultConnection).toHaveBeenCalledOnce();
    });

    it("disables Hosted with a hint when no provider is connected", async () => {
      const props = makeProps({
        loadConnections: vi
          .fn<SettingsStorageBridgeProps["loadConnections"]>()
          .mockResolvedValue([]),
      });
      const el = await mount(props);
      expect(option(el, "Hosted")?.hasAttribute("disabled")).toBe(true);
      expect(el.textContent).toContain("Connect a storage provider above");
    });
  });
});
