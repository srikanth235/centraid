import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AutomationEditorBridgeProps,
  AutomationEditorData,
} from "../screen-contracts.js";
import AutomationEditorScreen from "./AutomationEditorScreen.js";
import { addTrigger, makeData, makeProps } from "./automationEditorTestKit.js";
import { button, setValue } from "./domTestKit.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
describe("screens/AutomationEditorScreen", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  async function mount(
    props: AutomationEditorBridgeProps
  ): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(<AutomationEditorScreen {...props} />);
    });
    return container;
  }

  describe("AutomationEditorScreen — create mode", () => {
    it("uses the full editor layout, keeps Create disabled until named, and saves cron", async () => {
      const props = makeProps();
      const el = await mount(props);

      expect(el.querySelector('[data-mode="create"]')).toBeTruthy();
      expect(el.textContent).toContain("New Automation");
      expect(el.textContent).toContain("Draft");
      expect(el.textContent).toContain("Triggers");
      expect(el.textContent).toContain(
        "without one, this runs only when you fire it by hand"
      );
      expect(
        [...el.querySelectorAll("button")].some((b) =>
          b.textContent?.includes("Connectors")
        )
      ).toBe(true);
      expect(el.textContent).not.toContain("Behavior");
      expect(el.textContent).not.toContain("Model · Auto");
      expect(el.textContent).toContain("Notifications");
      expect(el.textContent).not.toContain("Skills");
      expect(
        el.querySelector('[data-testid="compile-verdict"]')?.textContent
      ).toBe("Not compiled");
      expect(el.querySelector('[data-testid="compile-now"]')).toBeNull();
      expect(el.querySelector('[data-testid="compile-test-run"]')).toBeNull();

      const nameInput = el.querySelector(
        'input[placeholder="My Automation"]'
      ) as HTMLInputElement;
      const instructionsField = el.querySelector(
        "textarea"
      ) as HTMLTextAreaElement;
      expect(nameInput).toBeTruthy();
      expect(instructionsField).toBeTruthy();
      expect(instructionsField.placeholder).toMatch(/unread emails/iu);

      const createBtn = button(el, "Create automation");
      expect(createBtn.disabled).toBe(true);

      setValue(nameInput, "Weekly digest");
      expect(createBtn.disabled).toBe(false);
      expect(el.textContent).toContain("Weekly digest");

      setValue(instructionsField, "Summarize the week every Monday.");

      await addTrigger(el, "Schedule");
      const cronCard = el.querySelector('[data-trigger-kind="cron"]');
      expect(cronCard).toBeTruthy();
      const cronInput = el.querySelector(
        'input[placeholder="0 7 * * *"]'
      ) as HTMLInputElement;
      setValue(cronInput, "0 8 * * MON");

      const notifySelect = el.querySelector(
        'select[aria-label="Notification preference"]'
      ) as HTMLSelectElement;
      expect(notifySelect).toBeTruthy();
      expect([...notifySelect.options].map((o) => o.textContent)).toStrictEqual(
        ["In the app", "Off"]
      );

      await act(async () =>
        button(el, "Create automation").dispatchEvent(
          new MouseEvent("click", { bubbles: true })
        )
      );

      expect(props.onSave).toHaveBeenCalledWith({
        connections: [],
        instructions: "Summarize the week every Monday.",
        name: "Weekly digest",
        triggers: [{ expr: "0 8 * * MON", kind: "cron" }],
      });
      expect(props.onCompile).toHaveBeenCalledWith(true);
      expect(
        el.querySelector('[data-testid="automation-compile-pane"]')
      ).not.toBeNull();
    });

    it("only offers Schedule and Data change as addable triggers", async () => {
      const el = await mount(makeProps());
      await act(async () => {
        button(el, "+ Add Trigger").dispatchEvent(
          new MouseEvent("click", { bubbles: true })
        );
      });
      const items = [...el.querySelectorAll('[role="menuitem"]')].map(
        (b) => b.textContent
      );
      expect(items).toStrictEqual(["Schedule", "Data change"]);
    });

    it("searches vault entities after @ and inserts a stable token rendered as a chip", async () => {
      const onSearchEntities = vi
        .fn<AutomationEditorBridgeProps["onSearchEntities"]>()
        .mockResolvedValue([
          {
            id: "party-1",
            subtitle: "person",
            title: "Priya",
            type: "core.party",
          },
        ]);
      const el = await mount(makeProps({ onSearchEntities }));
      const instructions = el.querySelector("textarea") as HTMLTextAreaElement;
      setValue(instructions, "Send a reminder to @Pri");

      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 150);
        });
      });
      expect(onSearchEntities).toHaveBeenCalledWith("Pri");
      expect(el.querySelector(".mentionPopover")?.textContent).toContain(
        "Priya"
      );

      await act(async () => {
        (el.querySelector(".mentionOption") as HTMLButtonElement).click();
      });
      expect(instructions.value).toBe(
        "Send a reminder to @[core.party/party-1]"
      );
      expect(
        el.querySelector('[aria-label="Tagged data"]')?.textContent
      ).toContain("party-1");
    });
  });

  describe("AutomationEditorScreen — edit mode", () => {
    function editData(
      over: Partial<AutomationEditorData> = {}
    ): AutomationEditorData {
      return makeData({
        automationId: "automation-a/x",
        connectors: {
          connector: null,
          mcps: ["weather"],
          secrets: [],
          vaultPurpose: null,
          vaultScopes: [],
        },
        enabled: true,
        instructions: "Summarize yesterday’s new issues.",
        mode: "edit",
        name: "Daily issues",
        onFailure: null,
        rowId: "row-a",
        triggers: [{ expr: "0 8 * * *", kind: "cron" }],
        webhook: null,
        ...over,
      });
    }

    it("shows identity chrome, the compile rail, and saves name/instructions/triggers", async () => {
      const props = makeProps({
        loadData: vi
          .fn<AutomationEditorBridgeProps["loadData"]>()
          .mockResolvedValue(editData()),
      });
      const el = await mount(props);

      expect(el.textContent).toContain("Daily issues");
      expect(el.textContent).toContain("Active");
      expect(button(el, "Run now")).toBeUndefined();
      expect(el.querySelector('[data-testid="compile-test-run"]')).toBeTruthy();

      const nameInput = el.querySelector(
        'input[placeholder="My Automation"]'
      ) as HTMLInputElement;
      setValue(nameInput, "Daily issues v2");

      await act(async () =>
        button(el, "Save changes").dispatchEvent(
          new MouseEvent("click", { bubbles: true })
        )
      );
      expect(props.onSave).toHaveBeenCalledWith({
        connections: [],
        instructions: "Summarize yesterday’s new issues.",
        name: "Daily issues v2",
        triggers: [{ expr: "0 8 * * *", kind: "cron" }],
      });
    });

    it("edit: enable switch in head, Notifications onFailure, Connectors picker", async () => {
      const loadConnectorCatalog = vi
        .fn<NonNullable<AutomationEditorBridgeProps["loadConnectorCatalog"]>>()
        .mockResolvedValue([
          {
            allowedHosts: ["api.github.com"],
            authUrl: undefined,
            connection: null,
            connections: [],
            credKind: "api_key" as const,
            key: "github:pull.github",
            kind: "pull.github",
            name: "GitHub",
            providerId: "github",
            providerName: "GitHub",
            setup: ["Create a PAT"],
            templateId: "github-pull",
            tone: "github",
          },
        ]);
      const props = makeProps({
        loadConnectorCatalog,
        loadData: vi
          .fn<AutomationEditorBridgeProps["loadData"]>()
          .mockResolvedValue(
            editData({
              connectors: {
                connector: "pull.github",
                mcps: ["weather"],
                secrets: ["locker:@token:password"],
                vaultPurpose: "dpv:ServiceProvision",
                vaultScopes: ["sync read+act"],
              },
              onFailure: "automation-a/notify-owner",
            })
          ),
      });
      const el = await mount(props);

      expect(el.querySelector('[role="switch"]')).toBeTruthy();
      expect(el.textContent).not.toContain("Writes park for your review");

      expect(el.textContent).toContain("automation-a/notify-owner");
      expect(
        el.querySelector('select[aria-label="Notification preference"]')
      ).toBeTruthy();

      const connectorsBtn = [...el.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Connectors")
      ) as HTMLButtonElement;
      await act(async () =>
        connectorsBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      expect(loadConnectorCatalog).toHaveBeenCalledWith();
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        el.querySelector('[data-testid="automation-connectors-picker"]')
          ?.textContent
      ).toContain("GitHub");
      expect(el.textContent).toContain("API key");
    });

    it("load → durable connection bindings round-trip into onSave", async () => {
      const props = makeProps({
        loadData: vi
          .fn<AutomationEditorBridgeProps["loadData"]>()
          .mockResolvedValue(
            editData({
              connectors: {
                connector: null,
                connections: [
                  {
                    connectionId: "conn-load-1",
                    kind: "pull.github",
                    label: "GitHub · personal",
                  },
                ],
                mcps: [],
                secrets: [],
                vaultPurpose: null,
                vaultScopes: [],
              },
            })
          ),
      });
      const el = await mount(props);
      await act(async () =>
        button(el, "Save changes").dispatchEvent(
          new MouseEvent("click", { bubbles: true })
        )
      );
      expect(props.onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          connections: [
            {
              connectionId: "conn-load-1",
              kind: "pull.github",
              label: "GitHub · personal",
            },
          ],
        })
      );
    });

    it("selecting a catalog row with a live connection binds connectionId on save", async () => {
      const loadConnectorCatalog = vi
        .fn<NonNullable<AutomationEditorBridgeProps["loadConnectorCatalog"]>>()
        .mockResolvedValue([
          {
            allowedHosts: ["api.github.com"],
            connection: {
              connectionId: "conn-sel-9",
              health: "ok" as const,
              label: "GitHub · work",
              principal: "work@example.com",
            },
            connections: [
              {
                connectionId: "conn-sel-9",
                health: "ok" as const,
                label: "GitHub · work",
                principal: "work@example.com",
              },
            ],
            credKind: "api_key" as const,
            key: "github:pull.github",
            kind: "pull.github",
            name: "GitHub",
            providerId: "github",
            providerName: "GitHub",
            setup: [],
            templateId: "github-pull",
            tone: "github",
          },
        ]);
      const props = makeProps({ loadConnectorCatalog });
      const el = await mount(props);
      setValue(
        el.querySelector('input[aria-label="Name"]') as HTMLInputElement,
        "Bound auto"
      );

      const connectorsBtn = [...el.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Connectors")
      ) as HTMLButtonElement;
      await act(async () =>
        connectorsBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      await act(async () => {
        await Promise.resolve();
      });
      const main = el.querySelector(
        '[data-testid="automation-connectors-picker"] [data-kind="pull.github"] .connPickerMain'
      ) as HTMLButtonElement;
      await act(async () =>
        main.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      await act(async () =>
        button(el, "Create automation").dispatchEvent(
          new MouseEvent("click", { bubbles: true })
        )
      );
      expect(props.onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          connections: [
            {
              connectionId: "conn-sel-9",
              kind: "pull.github",
              label: "GitHub · work",
            },
          ],
          name: "Bound auto",
        })
      );
    });

    it("Connect form success binds configureConnection connectionId into onSave", async () => {
      const base = {
        allowedHosts: ["api.github.com"],
        credKind: "api_key" as const,
        connections: [],
        key: "github:pull.github",
        kind: "pull.github",
        name: "GitHub",
        providerId: "github",
        providerName: "GitHub",
        setup: [] as string[],
        templateId: "github-pull",
        tone: "github",
      };
      const configureConnection = vi
        .fn<NonNullable<AutomationEditorBridgeProps["configureConnection"]>>()
        .mockResolvedValue({ connectionId: "conn-new-42" });
      const loadConnectorCatalog = vi
        .fn<NonNullable<AutomationEditorBridgeProps["loadConnectorCatalog"]>>()
        .mockResolvedValueOnce([{ ...base, connection: null }])
        .mockResolvedValue([
          {
            ...base,
            connection: {
              connectionId: "conn-new-42",
              health: "ok" as const,
              label: "GitHub",
              principal: "octocat",
            },
            connections: [
              {
                connectionId: "conn-new-42",
                health: "ok" as const,
                label: "GitHub",
                principal: "octocat",
              },
            ],
          },
        ]);
      const props = makeProps({ configureConnection, loadConnectorCatalog });
      const el = await mount(props);
      setValue(
        el.querySelector('input[aria-label="Name"]') as HTMLInputElement,
        "After connect"
      );
      const open = [...el.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Connectors")
      ) as HTMLButtonElement;
      await act(async () =>
        open.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () =>
        [...el.querySelectorAll("button")]
          .find((b) => b.textContent === "Connect")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      const apiKey = [
        ...(el
          .querySelector('[data-testid="automation-connectors-picker"]')
          ?.querySelectorAll("input") ?? []),
      ].find((i) => (i as HTMLInputElement).type === "password") as
        | HTMLInputElement
        | undefined;
      expect(apiKey).toBeTruthy();
      setValue(apiKey!, "ghp_test_token");
      const formSubmit = [...el.querySelectorAll("button")].find(
        (b) =>
          b.textContent === "Save connection" ||
          b.textContent === "Authorize & save" ||
          b.textContent === "Save"
      );
      await act(async () =>
        formSubmit?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(configureConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: "ghp_test_token",
          connectorKind: "pull.github",
          credKind: "api_key",
        })
      );
      await act(async () =>
        button(el, "Create automation").dispatchEvent(
          new MouseEvent("click", { bubbles: true })
        )
      );
      expect(props.onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          connections: [
            expect.objectContaining({
              connectionId: "conn-new-42",
              kind: "pull.github",
            }),
          ],
          name: "After connect",
        })
      );
    });
  });
});
