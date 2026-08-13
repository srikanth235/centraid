import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RouteVerbs } from "../shell/routeVitals.js";
import { makeProvider, makeRow } from "./SettingsConnectionsScreen.fixtures.js";
import SettingsConnectionsScreen from "./SettingsConnectionsScreen.js";
import type {
  AttachedSyncDTO,
  ConnectionRowDTO,
  SettingsConnectionsBridgeProps,
} from "./SettingsConnectionsScreen.js";

/** The verbs the screen claims on the app bar — captured, then fired the way
 *  the bar's buttons fire them. */
let verbs: RouteVerbs = {};
/** Everything the screen reported to the frame, newest last. */
let signals: Parameters<
  NonNullable<SettingsConnectionsBridgeProps["onSignals"]>
>[0][] = [];

function makeProps(
  over: Partial<SettingsConnectionsBridgeProps> = {}
): SettingsConnectionsBridgeProps {
  return {
    beginAuthorize: vi
      .fn<SettingsConnectionsBridgeProps["beginAuthorize"]>()
      .mockResolvedValue("https://accounts.google.com/authorize?state=s1"),
    configureConnection: vi
      .fn<SettingsConnectionsBridgeProps["configureConnection"]>()
      .mockResolvedValue({ connectionId: "c-new", status: "needs-auth" }),
    detachConnection: vi
      .fn<SettingsConnectionsBridgeProps["detachConnection"]>()
      .mockResolvedValue(undefined),
    loadConnections: vi
      .fn<SettingsConnectionsBridgeProps["loadConnections"]>()
      .mockResolvedValue([makeRow()]),
    loadOAuthCallbackUri: vi
      .fn<NonNullable<SettingsConnectionsBridgeProps["loadOAuthCallbackUri"]>>()
      .mockResolvedValue(
        "http://127.0.0.1:17832/centraid/_vault/oauth/callback"
      ),
    loadProviders: vi
      .fn<SettingsConnectionsBridgeProps["loadProviders"]>()
      .mockResolvedValue([makeProvider()]),
    onSignals: (input) => signals.push(input),
    onVerbs: (next) => {
      verbs = next;
    },
    setConnectionStatus: vi
      .fn<SettingsConnectionsBridgeProps["setConnectionStatus"]>()
      .mockResolvedValue(undefined),
    showToast: vi.fn<SettingsConnectionsBridgeProps["showToast"]>(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function buttons(el: ParentNode): HTMLButtonElement[] {
  return [...el.querySelectorAll("button")];
}

function byText(el: ParentNode, text: string): HTMLButtonElement | undefined {
  return buttons(el).find((b) => b.textContent === text);
}

function containing(
  el: ParentNode,
  text: string
): HTMLButtonElement | undefined {
  return buttons(el).find((b) => b.textContent?.includes(text));
}

async function click(target: Element | null | undefined): Promise<void> {
  await act(async () =>
    target?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The section head + rows the given block label introduces. */
function sectionRows(el: ParentNode, label: string): string[] {
  const heads = [...el.querySelectorAll("h2")];
  const head = heads.find((h) => h.textContent === label);
  const rows = head?.parentElement?.nextElementSibling;
  return [...(rows?.querySelectorAll(".title") ?? [])].map(
    (n) => n.textContent ?? ""
  );
}

describe("screens/SettingsConnectionsScreen", () => {
  beforeEach(() => {
    verbs = {};
    signals = [];
    vi.spyOn(window, "open").mockReturnValue(null);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  async function mount(
    props: SettingsConnectionsBridgeProps
  ): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(<SettingsConnectionsScreen {...props} />);
    });
    // Connections + providers load in effects
    await settle();
    return container;
  }

  /** Open the connection's own sheet the way the page does: the row's quiet
   *  Configure control (lapsed/paused rows) or its trailing action (healthy). */
  async function openConnectionSheet(el: ParentNode): Promise<void> {
    await click(byText(el, "Configure"));
  }

  describe(SettingsConnectionsScreen, () => {
    it("draws the connections section, its rows, and the note under the syncs", async () => {
      const el = await mount(
        makeProps({
          loadAttachedSyncs: vi
            .fn<
              NonNullable<SettingsConnectionsBridgeProps["loadAttachedSyncs"]>
            >()
            .mockResolvedValue([
              {
                cadence: "Every 15 minutes",
                connectionId: "c1",
                connectionLabel: "Google · Gmail",
                enabled: true,
                id: "mail/pull",
                name: "messages",
              } satisfies AttachedSyncDTO,
            ]),
        })
      );
      expect(sectionRows(el, "Connections")).toStrictEqual(["Google · Gmail"]);
      expect(el.textContent).toContain("Needs re-auth");
      expect(byText(el, "Re-authorize")).toBeTruthy();
      // The sync section names the connection it rides and the note explains
      // what a sync is allowed to do — both verbatim.
      expect(sectionRows(el, "Attached data syncs")).toStrictEqual([
        "Google · Gmail → messages",
      ]);
      expect(el.textContent).toContain(
        "A sync copies one narrow thing into the vault on a schedule. It reads only what the connection already allows."
      );
    });

    it("reports the count line, the state, and the health sentence to the frame", async () => {
      await mount(makeProps());
      const last = signals.at(-1);
      expect(last?.state).toBe("ready");
      expect(last?.count).toBe("1 connection · 1 needs re-authorization");
      expect(last?.health?.label).toBe("Google · Gmail needs re-authorization");
      expect(last?.health?.action?.label).toBe("Re-authorize");
      // Loading is reported first, so the bar can withdraw its verbs.
      expect(signals[0]?.state).toBe("loading");
    });

    it("says nothing is connected, and the empty action opens the catalog", async () => {
      const el = await mount(
        makeProps({
          loadConnections: vi
            .fn<SettingsConnectionsBridgeProps["loadConnections"]>()
            .mockResolvedValue([]),
        })
      );
      expect(el.textContent).toContain("Nothing is connected");
      expect(el.textContent).toContain(
        "A connector lets one outside service reach a named part of this vault, and nothing else."
      );
      expect(signals.at(-1)?.state).toBe("empty");
      expect(signals.at(-1)?.count).toBe("No connections");

      await click(byText(el, "Open the catalog"));
      expect(sectionRows(el, "Catalog")).toContain("Gmail");
    });

    it("holds the row geometry while it reads, and says why", async () => {
      const el = await mount(
        makeProps({
          loadConnections: vi
            .fn<SettingsConnectionsBridgeProps["loadConnections"]>()
            .mockReturnValue(
              // Never settles: the page must hold the row geometry, not blink.
              new Promise<ConnectionRowDTO[]>(() => {
                /* the gateway has not answered */
              })
            ),
        })
      );
      expect(
        el.querySelector('[aria-label="Reading connections"]')
      ).toBeTruthy();
      expect(el.textContent).toContain(
        "A row knows its shape before its content arrives, so nothing reflows when it does."
      );
      expect(signals.at(-1)?.state).toBe("loading");
    });

    it("states what failed, what is still safe, and one way forward", async () => {
      const loadConnections = vi
        .fn<SettingsConnectionsBridgeProps["loadConnections"]>()
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:1"))
        .mockResolvedValue([makeRow({ health: "ok" })]);
      const el = await mount(makeProps({ loadConnections }));
      expect(el.textContent).toContain("THIS PAGE COULD NOT LOAD");
      expect(el.textContent).toContain(
        "Existing connections keep working — this page reads their status from the gateway, and only the status is unavailable. Nothing has been paused."
      );
      expect(signals.at(-1)?.state).toBe("error");

      // The cause is available, but never in the reader's way by default.
      expect(el.textContent).not.toContain("ECONNREFUSED");
      await click(byText(el, "Show the technical detail"));
      expect(el.textContent).toContain("ECONNREFUSED");

      await click(byText(el, "Try again"));
      await settle();
      expect(sectionRows(el, "Connections")).toStrictEqual(["Google · Gmail"]);
    });

    it("offers filter chips and a showing-N-of-M count once the list is full", async () => {
      const many = Array.from({ length: 7 }, (_unused, i) =>
        makeRow({
          connectionId: `c${i}`,
          health: i === 0 ? "paused" : "ok",
          label: `Connection ${i}`,
        })
      );
      const el = await mount(
        makeProps({
          loadConnections: vi
            .fn<SettingsConnectionsBridgeProps["loadConnections"]>()
            .mockResolvedValue(many),
        })
      );
      expect(signals.at(-1)?.state).toBe("full");
      expect(signals.at(-1)?.count).toBe("7 connections · 1 paused");
      // Nothing is hidden yet, so the caption states the total and stops.
      const meta = el.querySelector(".meta");
      expect(meta?.textContent).toBe("7");

      await click(byText(el, "Paused"));
      expect(sectionRows(el, "Connections")).toStrictEqual(["Connection 0"]);
      expect(el.querySelector(".meta")?.textContent).toBe("showing 1 of 7");
    });

    it("re-authorizes from the row's one action", async () => {
      const props = makeProps();
      const el = await mount(props);
      await click(byText(el, "Re-authorize"));
      await settle();
      expect(props.beginAuthorize).toHaveBeenCalledWith("c1");
      expect(window.open).toHaveBeenCalledWith(
        "https://accounts.google.com/authorize?state=s1",
        "_blank",
        "noopener"
      );
    });

    it("resumes a paused connection from the row's one action", async () => {
      const props = makeProps({
        loadConnections: vi
          .fn<SettingsConnectionsBridgeProps["loadConnections"]>()
          .mockResolvedValue([makeRow({ health: "paused" })]),
      });
      const el = await mount(props);
      await click(byText(el, "Resume"));
      expect(props.setConnectionStatus).toHaveBeenCalledWith("c1", "active");
    });

    it("pauses an active connection from its own sheet", async () => {
      const props = makeProps({
        loadConnections: vi
          .fn<SettingsConnectionsBridgeProps["loadConnections"]>()
          .mockResolvedValue([makeRow({ health: "ok" })]),
      });
      const el = await mount(props);
      await openConnectionSheet(el);
      await settle();
      const sheet = el.querySelector('[data-testid="connector-sheet"]');
      expect(sheet).toBeTruthy();
      await click(byText(sheet as ParentNode, "Pause"));
      expect(props.setConnectionStatus).toHaveBeenCalledWith("c1", "paused");
    });

    it("removes a connection from its own sheet", async () => {
      const props = makeProps();
      const el = await mount(props);
      await openConnectionSheet(el);
      await settle();
      await click(byText(el, "Remove"));
      expect(props.detachConnection).toHaveBeenCalledWith(
        "c1",
        "pull.gmail",
        "Google · Gmail"
      );
    });

    it("shows Remove even for a connection with no credential (harness-ambient lane)", async () => {
      const el = await mount(
        makeProps({
          loadConnections: vi
            .fn<SettingsConnectionsBridgeProps["loadConnections"]>()
            .mockResolvedValue([makeRow({ credKind: null })]),
        })
      );
      await openConnectionSheet(el);
      await settle();
      expect(byText(el, "Remove")).toBeTruthy();
    });

    it("surfaces the server refusal as a toast when Remove is refused", async () => {
      const props = makeProps({
        detachConnection: vi
          .fn<SettingsConnectionsBridgeProps["detachConnection"]>()
          .mockRejectedValue(
            new Error("has 2 outbox item(s) still awaiting a decision")
          ),
      });
      const el = await mount(props);
      await openConnectionSheet(el);
      await settle();
      await click(byText(el, "Remove"));
      await settle();
      expect(props.showToast).toHaveBeenCalledWith(
        expect.stringContaining("awaiting a decision")
      );
    });

    it("claims both app-bar verbs: the sheet, and the catalog", async () => {
      const el = await mount(makeProps());
      expect(verbs.onCommit).toBeTypeOf("function");
      expect(verbs.onSecondary).toBeTypeOf("function");

      await act(async () => verbs.onCommit?.());
      const sheet = el.querySelector('[data-testid="connector-sheet"]');
      expect(sheet?.textContent).toContain("New Connector");
      expect(sheet?.textContent).toContain("Choose a data source");
      expect(sheet?.textContent).toContain("Gmail");

      await click(el.querySelector('[aria-label="Close"]'));
      await act(async () => verbs.onSecondary?.());
      expect(sectionRows(el, "Catalog")).toContain("Google Calendar");
      await act(async () => verbs.onSecondary?.());
      expect(sectionRows(el, "Catalog")).toStrictEqual([]);
    });

    it("connects from the catalog: detail sheet, OAuth 2.0 form, then authorize", async () => {
      const props = makeProps({
        loadConnections: vi
          .fn<SettingsConnectionsBridgeProps["loadConnections"]>()
          .mockResolvedValue([]),
      });
      const el = await mount(props);
      await click(byText(el, "Open the catalog"));
      await click(byText(el, "Connect"));

      const sheet = el.querySelector('[data-testid="connector-sheet"]');
      expect(sheet).toBeTruthy();
      expect(sheet?.textContent).toContain("About this Connector");
      expect(
        sheet?.querySelector('[data-testid="connector-auth-kind"]')?.textContent
      ).toContain("OAuth 2.0");

      await click(containing(sheet as ParentNode, "Connect with OAuth 2.0"));
      expect(el.querySelector('[data-testid="connector-wizard"]')).toBeTruthy();
      expect(
        el.querySelector('[data-testid="oauth-redirect-uri"]')
      ).toBeTruthy();
      expect(el.textContent).toContain("Client ID");
      expect(el.textContent).toContain("Client secret");

      const fieldInput = (labelText: string): HTMLInputElement | null => {
        const labels = [...el.querySelectorAll("label")].find((l) =>
          l.textContent?.includes(labelText)
        );
        return labels?.querySelector("input") ?? null;
      };
      const idInput = fieldInput("Client ID");
      const secretInput = fieldInput("Client secret");

      const setNativeValue = (input: HTMLInputElement, value: string): void => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      await act(async () => {
        if (idInput) setNativeValue(idInput, "my-client-id");
        if (secretInput) setNativeValue(secretInput, "my-client-secret");
      });

      const saveBtn = containing(el, "Save & authorize");
      expect(saveBtn?.hasAttribute("disabled")).toBe(false);
      await click(saveBtn);
      await settle();

      expect(props.configureConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: "my-client-id",
          clientSecret: "my-client-secret",
          connectorKind: "pull.gmail",
          credKind: "oauth2",
          providerId: "google",
        })
      );
      // OAuth2 must open the provider consent screen after save.
      expect(props.beginAuthorize).toHaveBeenCalledWith("c-new");
      expect(window.open).toHaveBeenCalledWith(
        "https://accounts.google.com/authorize?state=s1",
        "_blank",
        "noopener"
      );
    });

    it("makes Centraid Assist primary, scopes it to the selected connector, and keeps BYO advanced", async () => {
      const calendarScope = "https://www.googleapis.com/auth/calendar.events";
      const gmailScope = "https://www.googleapis.com/auth/gmail.readonly";
      const props = makeProps({
        loadConnections: vi
          .fn<SettingsConnectionsBridgeProps["loadConnections"]>()
          .mockResolvedValue([]),
        loadProviders: vi
          .fn<SettingsConnectionsBridgeProps["loadProviders"]>()
          .mockResolvedValue([
            makeProvider({
              assist: {
                callbackUrl: "https://oauth.centraid.dev/callback",
                enabled: true,
                provider: "google",
                restrictedScopesEnabled: false,
                scopeTiers: {
                  restricted: [gmailScope],
                  standard: [calendarScope],
                },
              },
              connectors: [
                {
                  kind: "pull.gmail",
                  scope: gmailScope,
                  templateId: "google-gmail-pull",
                },
                {
                  kind: "pull.gcal",
                  scope: calendarScope,
                  templateId: "google-calendar-pull",
                },
              ],
            }),
          ]),
      });
      const el = await mount(props);
      await click(byText(el, "Open the catalog"));
      // The second catalog row is Google Calendar; its Connect is the second.
      await click(buttons(el).filter((b) => b.textContent === "Connect")[1]);
      expect(el.textContent).toContain("Connect with Centraid");
      expect(el.textContent).toContain("Use my own OAuth app (Advanced)");

      await click(byText(el, "Connect with Centraid"));

      const wizard = el.querySelector(
        '[data-testid="connector-assist-wizard"]'
      );
      expect(wizard?.textContent).toContain(
        "Read and update Google Calendar events"
      );
      expect(wizard?.textContent).not.toContain("Read Gmail");
      expect(wizard?.textContent).toContain(
        "does not request Google identity scopes"
      );

      const continueButton = byText(wizard as ParentNode, "Continue to Google");
      expect(continueButton?.hasAttribute("disabled")).toBe(false);
      await click(continueButton);
      await settle();

      expect(props.configureConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          connectorKind: "pull.gcal",
          oauthMode: "assist",
          scopes: calendarScope,
        })
      );
      expect(props.beginAuthorize).toHaveBeenCalledWith("c-new");
    });

    it("fail-closes restricted Assist scopes until verification is enabled", async () => {
      const gmailScope = "https://www.googleapis.com/auth/gmail.readonly";
      const el = await mount(
        makeProps({
          loadConnections: vi
            .fn<SettingsConnectionsBridgeProps["loadConnections"]>()
            .mockResolvedValue([]),
          loadProviders: vi
            .fn<SettingsConnectionsBridgeProps["loadProviders"]>()
            .mockResolvedValue([
              makeProvider({
                assist: {
                  callbackUrl: "https://oauth.centraid.dev/callback",
                  enabled: true,
                  provider: "google",
                  restrictedScopesEnabled: false,
                  scopeTiers: { restricted: [gmailScope], standard: [] },
                },
                connectors: [
                  {
                    kind: "pull.gmail",
                    scope: gmailScope,
                    templateId: "google-gmail-pull",
                  },
                ],
              }),
            ]),
        })
      );
      await click(byText(el, "Open the catalog"));
      await click(byText(el, "Connect"));
      await click(byText(el, "Connect with Centraid"));

      const wizard = el.querySelector(
        '[data-testid="connector-assist-wizard"]'
      );
      const checkbox = wizard?.querySelector('input[type="checkbox"]');
      const continueButton = byText(wizard as ParentNode, "Continue to Google");
      expect(checkbox?.hasAttribute("disabled")).toBe(true);
      expect(continueButton?.hasAttribute("disabled")).toBe(true);
      expect(wizard?.textContent).toContain(
        "until Google restricted-scope verification is complete"
      );
    });

    it("differentiates the label and warns when adding a second account for a connected provider", async () => {
      // Default props already carry one Gmail connection (kind pull.gmail, label
      // "Google · Gmail"). Adding another must not silently reuse that identity.
      const el = await mount(makeProps());
      await act(async () => verbs.onSecondary?.());
      await click(byText(el, "Add another"));
      await click(containing(el, "Connect with OAuth 2.0"));

      const wizard = el.querySelector('[data-testid="connector-wizard"]');
      const labelInput = wizard?.querySelector<HTMLInputElement>(
        '[data-testid="connector-label-input"]'
      );
      // A distinct default so a save can't overwrite the existing account…
      expect(labelInput?.value).not.toBe("Google · Gmail");
      expect(labelInput?.value.startsWith("Google · Gmail")).toBe(true);
      // …and the owner is told why. The redundant in-form auth banner is gone.
      expect(wizard?.textContent).toMatch(/already have 1 account/iu);
      expect(wizard?.textContent).not.toContain(
        "Use your own client ID and secret (BYO)"
      );
    });

    it("keeps the plain single-account label default when nothing is connected yet", async () => {
      const el = await mount(
        makeProps({
          loadConnections: vi
            .fn<SettingsConnectionsBridgeProps["loadConnections"]>()
            .mockResolvedValue([]),
        })
      );
      await click(byText(el, "Open the catalog"));
      await click(byText(el, "Connect"));
      await click(containing(el, "Connect with OAuth 2.0"));
      const labelInput = el.querySelector<HTMLInputElement>(
        '[data-testid="connector-label-input"]'
      );
      expect(labelInput?.value).toBe("Google · Gmail");
    });
  });
});
