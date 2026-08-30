// The grant sheet, native seat (#825). The parity claim: the SAME core answers
// here — one write door, `edit` only where the registry declares it, an
// unaccepted invitation reading as pending rather than error, and revoking
// asking first before reporting the route's own sentence verbatim.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { GrantUnreachableError } from "@centraid/blueprints/apps/_shared/grant-door";
import type { GrantDoor } from "@centraid/blueprints/apps/_shared/grant-door";
import type {
  GrantRecord,
  GrantRequest,
  GrantSubjectOffer,
} from "@centraid/blueprints/apps/_shared/grant-plane";

// @vitest-environment jsdom
import GrantSheet from "./GrantSheet";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
      accessibilityState?: { disabled?: boolean };
      children?: React.ReactNode;
      disabled?: boolean;
      onPress?: () => void;
    }) =>
      element("button", {
        "aria-disabled": Boolean(disabled || accessibilityState?.disabled),
        "aria-label": accessibilityLabel,
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
  import("../replica/ReplicaProvider"),
  () => ({ useReplica: () => ({ gatewayBase: "" }) }) as never
);

// The default door pulls the Expo module runtime into a plain jsdom project,
// so every test injects its own and stubs transport at the seam.
vi.mock(
  import("./grant-seat"),
  () => ({ nativeGrantDoor: () => undefined }) as never
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
          net: "#net",
          seam: "#seam",
          text: "#text",
          textInv: "#inv",
          textSoft: "#soft",
        },
      }),
    }) as never
);

// Registry truth (G-edit): only tally.group carries edit in v1.
const OFFERS: GrantSubjectOffer[] = [
  { subjectType: "tally.group", capabilities: ["view", "edit"] },
  { subjectType: "core.document", capabilities: ["view"] },
  { subjectType: "media.asset", capabilities: ["view"] },
];

const GROUP_SUBJECT = {
  subjectType: "tally.group",
  subjectId: "group-1",
  label: "Ski trip",
};

const AUDIENCES = [
  { kind: "party" as const, id: "party-priya", label: "Priya" },
  { kind: "party" as const, id: "party-ravi", label: "Ravi" },
];

function standingGrant(overrides: Partial<GrantRecord> = {}): GrantRecord {
  return {
    grantId: "grant-1",
    audience: { kind: "party", id: "party-priya" },
    subjectType: "core.document",
    subjectId: "doc-1",
    capability: "view",
    grantedAt: "2026-08-01T10:00:00.000Z",
    revokedAt: null,
    grantedBy: "party-owner",
    maxSizeBytes: null,
    fulfillment: [
      {
        peerVaultId: "vault-priya",
        state: "delivered",
        updatedAt: "",
        detail: null,
      },
    ],
    // The vault's own words for where it stands (ruling V-phrases).
    phrase: "shared",
    reason: "the vault it addresses is holding it",
    ...overrides,
  };
}

function stubDoor(overrides: Partial<GrantDoor> = {}): GrantDoor {
  return {
    subjects: () => Promise.resolve({ readable: true, offers: OFFERS }),
    forParty: () => Promise.resolve({ known: true, channel: null, grants: [] }),
    forAudience: () => Promise.resolve({ known: true, grants: [] }),
    forSubject: () => Promise.resolve([]),
    create: () => Promise.resolve({ ok: true, outcome: "created" as const }),
    revoke: () => Promise.resolve({ ok: true, message: "no longer shared" }),
    changeCapability: () =>
      Promise.resolve({ ok: true, outcome: "created" as const }),
    ...overrides,
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

describe("the grant sheet, native seat", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
  });

  /** Record what the sheet SAYS, not which functions ran: status is the seam. */
  async function render(
    props: Partial<React.ComponentProps<typeof GrantSheet>> = {}
  ): Promise<string[]> {
    const status: string[] = [];
    await act(async () => {
      root = createRoot(container!);
      root.render(
        <GrantSheet
          audiences={AUDIENCES}
          door={stubDoor()}
          onClose={() => undefined}
          onStatus={(message) => status.push(message)}
          subjects={[
            {
              subjectType: "core.document",
              subjectId: "doc-1",
              label: "Trip plan",
            },
          ]}
          visible
          {...props}
        />
      );
    });
    return status;
  }

  function press(label: string): HTMLButtonElement {
    const found = [...container!.querySelectorAll("button")].find(
      (button) =>
        button.textContent?.trim() === label ||
        button.getAttribute("aria-label") === label
    );
    if (!found) throw new Error(`no control labelled ${label}`);
    return found;
  }

  function has(label: string): boolean {
    return [...container!.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === label
    );
  }

  describe("audience-first, native", () => {
    test("person, what and capability reach the write door as one request", async () => {
      const sent: GrantRequest[] = [];
      let closed = 0;
      const status = await render({
        door: stubDoor({
          create: (request) => {
            sent.push(request);
            return Promise.resolve({ ok: true, outcome: "created" });
          },
        }),
        onClose: () => {
          closed += 1;
        },
        subjects: [GROUP_SUBJECT],
      });

      await act(async () => press("Ravi").click());
      await act(async () => press("Can edit").click());
      await act(async () => press("Share").click());

      expect(sent).toStrictEqual([
        {
          audienceKind: "party",
          audienceId: "party-ravi",
          subjectType: "tally.group",
          subjectId: "group-1",
          capability: "edit",
          subjectLabel: "Ski trip",
        },
      ]);
      expect(status).toStrictEqual(["Ravi can edit it"]);
      expect(closed).toBe(1);
    });

    test("edit is absent for a subject the registry answers view-only", async () => {
      await render({
        subjects: [
          { subjectType: "media.asset", subjectId: "photo-1", label: "Beach" },
        ],
      });
      expect(has("Can view")).toBe(true);
      expect(has("Can edit")).toBe(false);
    });

    test("a person this vault has never reached says so", async () => {
      await render();
      expect(container?.textContent).toContain("Not reached yet");
    });

    test("saying it twice is a success, not a failure", async () => {
      const status = await render({
        door: stubDoor({
          create: () => Promise.resolve({ ok: true, outcome: "exists" }),
        }),
      });
      await act(async () => press("Share").click());
      expect(status).toStrictEqual(["Already shared with Priya"]);
    });

    test("changing a standing capability asks first, then withdraws and grants again", async () => {
      // The plane refuses an answer edited in place (V-table), so the sheet
      // names the consequence first, then runs withdraw-then-grant.
      const standing = standingGrant({
        subjectType: "tally.group",
        subjectId: "group-1",
      });
      const changed: Array<[string, GrantRequest]> = [];
      const created: GrantRequest[] = [];
      const status = await render({
        subjects: [GROUP_SUBJECT],
        door: stubDoor({
          forParty: () =>
            Promise.resolve({
              known: true,
              channel: { state: "live" as const },
              grants: [standing],
            }),
          create: (request) => {
            created.push(request);
            return Promise.resolve({ ok: true, outcome: "created" as const });
          },
          changeCapability: (grantId, request) => {
            changed.push([grantId, request]);
            return Promise.resolve({ ok: true, outcome: "created" as const });
          },
        }),
      });
      await act(async () => press("Can edit").click());
      // The primary action is worded as the change, not as the mechanism.
      expect(has("Share")).toBe(false);
      await act(async () => press("Change access").click());
      expect(container?.textContent).toContain(
        "asked to remove its copy and is sent a fresh one"
      );
      // Nothing has been written yet: the question is still open.
      expect(changed).toStrictEqual([]);
      await act(async () => press("Change access").click());
      expect(changed).toStrictEqual([
        [
          "grant-1",
          {
            audienceKind: "party",
            audienceId: "party-priya",
            subjectType: "tally.group",
            subjectId: "group-1",
            capability: "edit",
            subjectLabel: "Ski trip",
          },
        ],
      ]);
      // Never the plain create door: that post is the one the route refuses.
      expect(created).toStrictEqual([]);
      expect(status).toStrictEqual(["Priya can now edit it"]);
    });

    test("backing out of the change writes nothing at all", async () => {
      const standing = standingGrant({
        subjectType: "tally.group",
        subjectId: "group-1",
      });
      const changed: string[] = [];
      const status = await render({
        subjects: [GROUP_SUBJECT],
        door: stubDoor({
          forParty: () =>
            Promise.resolve({
              known: true,
              channel: { state: "live" as const },
              grants: [standing],
            }),
          changeCapability: (grantId) => {
            changed.push(grantId);
            return Promise.resolve({ ok: true, outcome: "created" as const });
          },
        }),
      });
      await act(async () => press("Can edit").click());
      await act(async () => press("Change access").click());
      await act(async () => press("Leave it as it is").click());
      expect(changed).toStrictEqual([]);
      expect(status).toStrictEqual([]);
      // The sheet is back, still offering the change.
      expect(has("Change access")).toBe(true);
    });

    test("a subject the registry does not name at all refuses the verb", async () => {
      await render({
        subjects: [
          {
            subjectType: "locker.item",
            subjectId: "secret-1",
            label: "Bank PIN",
          },
        ],
      });
      expect(container?.textContent).toContain(
        "cannot be shared as a standing grant"
      );
      expect(press("Share").getAttribute("aria-disabled")).toBe("true");
    });

    test("a registry still being read refuses nothing and offers no Share", async () => {
      let answer: () => void = () => undefined;
      await render({
        subjects: [GROUP_SUBJECT],
        door: stubDoor({
          subjects: () =>
            new Promise((resolve) => {
              answer = (): void => resolve({ readable: true, offers: OFFERS });
            }),
        }),
      });
      expect(container?.textContent).not.toContain(
        "cannot be shared as a standing grant"
      );
      expect(press("Share").getAttribute("aria-disabled")).toBe("true");
      await act(async () => answer());
      expect(press("Share").getAttribute("aria-disabled")).toBe("false");
      expect(has("Can edit")).toBe(true);
    });

    test("an unreadable registry says so rather than refusing the subject", async () => {
      await render({
        door: stubDoor({
          subjects: () => Promise.resolve({ readable: false, offers: [] }),
        }),
      });
      expect(container?.textContent).toContain(
        "Shareable items could not be read."
      );
      expect(container?.textContent).not.toContain("out of reach");
      expect(container?.textContent).not.toContain(
        "cannot be shared as a standing grant"
      );
      expect(press("Share").getAttribute("aria-disabled")).toBe("true");
    });

    test("a registry nobody could ask is unknown, not refused", async () => {
      await render({
        door: stubDoor({
          subjects: () =>
            Promise.resolve({
              readable: false,
              offers: [],
              reach: "unreachable" as const,
            }),
        }),
      });
      expect(container?.textContent).toContain(
        "Shareable items are unknown — the gateway is out of reach."
      );
      expect(container?.textContent).not.toContain(
        "Shareable items could not be read."
      );
    });

    test("a read that never left the device says so, not that it was refused", async () => {
      await render({
        door: stubDoor({
          forParty: () =>
            Promise.reject(
              new GrantUnreachableError("read what this person can reach")
            ),
        }),
      });
      expect(container?.textContent).toContain(
        "Shares could not be read — the gateway is out of reach."
      );
      expect(container?.textContent).not.toContain("Shares could not be read.");
    });

    test("a gateway that refused the read is not reported as an outage", async () => {
      await render({
        door: stubDoor({
          forParty: () => Promise.reject(new Error("the vault refused that")),
        }),
      });
      expect(container?.textContent).toContain("Shares could not be read.");
      expect(container?.textContent).not.toContain("out of reach");
    });

    test("a person this vault has no record of says that, and nothing else", async () => {
      await render({
        door: stubDoor({
          forParty: () =>
            Promise.resolve({ known: false, channel: undefined, grants: [] }),
        }),
      });
      expect(container?.textContent).toContain(
        "This vault has no record of Priya."
      );
      expect(container?.textContent).not.toContain(
        "Nothing shared with Priya yet."
      );
      expect(container?.textContent).not.toContain("Shares could not be read.");
      expect(container?.textContent).not.toContain("Not reached yet");
    });

    test("an unaccepted invitation reads as pending, not as an error", async () => {
      await render({
        door: stubDoor({
          forParty: () =>
            Promise.resolve({
              known: true,
              channel: { state: "invited" as const },
              grants: [
                standingGrant({
                  fulfillment: [
                    {
                      peerVaultId: "vault-priya",
                      state: "awaiting_channel",
                      updatedAt: "",
                      detail: null,
                    },
                  ],
                }),
              ],
            }),
        }),
      });
      expect(container?.textContent).toContain("Invitation pending");
    });
  });
});
