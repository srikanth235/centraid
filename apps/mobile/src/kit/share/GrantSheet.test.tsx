// The grant sheet, native seat (#825).
//
// The parity claim: the SAME core answers on this seat. Person → what →
// capability reaches one write door with the request the route takes, `edit`
// is drawn only where the declared registry answers it, an unaccepted
// invitation reads as pending rather than as an error, and revoking asks
// first in the honest best-effort words before reporting the route's own
// sentence verbatim.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

// The default door reaches `lib/gateway`, which pulls the Expo module runtime
// into a plain jsdom project. Every test here injects its own door, so the
// transport is stubbed at the seam rather than booted.
vi.mock(
  import("./grants-transport"),
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

const OFFERS: GrantSubjectOffer[] = [
  { subjectType: "core.document", capabilities: ["view", "edit"] },
  { subjectType: "media.asset", capabilities: ["view"] },
];

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

  /**
   * Mount the sheet and record what it SAYS rather than which functions ran:
   * the status line is its one feedback channel, so the sentences that reached
   * it are the observable outcome under test.
   */
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
      });

      await act(async () => press("Ravi").click());
      await act(async () => press("Can edit").click());
      await act(async () => press("Share").click());

      expect(sent).toStrictEqual([
        {
          audienceKind: "party",
          audienceId: "party-ravi",
          subjectType: "core.document",
          subjectId: "doc-1",
          capability: "edit",
          subjectLabel: "Trip plan",
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

    test("a capability the route did not change is not reported as a change", async () => {
      const standing = standingGrant();
      const status = await render({
        door: stubDoor({
          forParty: () =>
            Promise.resolve({
              known: true,
              channel: { state: "live" as const },
              grants: [standing],
            }),
          create: () =>
            Promise.resolve({
              ok: true,
              outcome: "exists_other_capability",
              standing: "view",
              grant: standing,
            }),
        }),
      });
      await act(async () => press("Can edit").click());
      await act(async () => press("Share").click());
      expect(status).toStrictEqual([
        "Already shared with Priya for viewing; changing access is not offered yet — revoke and share again to change it.",
      ]);
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
      expect(container?.textContent).not.toContain(
        "cannot be shared as a standing grant"
      );
      expect(press("Share").getAttribute("aria-disabled")).toBe("true");
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

  describe("revoking, native", () => {
    test("asks first, then reports the route's sentence verbatim", async () => {
      const message =
        "no longer shared; a vault holding a copy has been asked to remove it and has not yet confirmed";
      const revoked: string[] = [];
      const status = await render({
        door: stubDoor({
          revoke: (grantId) => {
            revoked.push(grantId);
            return Promise.resolve({ ok: true, message });
          },
          forParty: () =>
            Promise.resolve({
              known: true,
              channel: { state: "live" as const },
              grants: [standingGrant()],
            }),
        }),
      });

      await act(async () => press("Revoke document").click());
      expect(container?.textContent).toContain("Stop sharing with Priya?");
      expect(container?.textContent).toContain(
        "their vault is asked to remove its copy"
      );

      await act(async () => press("Revoke").click());
      expect(revoked).toStrictEqual(["grant-1"]);
      expect(status).toStrictEqual([message]);
    });

    test("keeping the share writes nothing", async () => {
      const revoked: string[] = [];
      await render({
        door: stubDoor({
          revoke: (grantId) => {
            revoked.push(grantId);
            return Promise.resolve({ ok: true, message: "no longer shared" });
          },
          forParty: () =>
            Promise.resolve({
              known: true,
              channel: { state: "live" as const },
              grants: [standingGrant()],
            }),
        }),
      });
      await act(async () => press("Revoke document").click());
      await act(async () => press("Keep sharing").click());
      expect(revoked).toStrictEqual([]);
    });
  });

  describe("object-first, native", () => {
    test("the same core answers the object side, with the what step pinned", async () => {
      let subjectReads = 0;
      await render({
        subject: {
          subjectType: "core.document",
          subjectId: "doc-1",
          label: "Trip plan",
        },
        door: stubDoor({
          forSubject: () => {
            subjectReads += 1;
            return Promise.resolve([standingGrant()]);
          },
        }),
      });
      expect(subjectReads).toBe(1);
      expect(container?.textContent).toContain("Trip plan");
      // The standing list is the object side, so its rows name PEOPLE.
      expect(container?.textContent).toContain("Priya");
    });

    test("the person's reach is read here too, never invented from the object read", async () => {
      // `forSubject` cannot answer reach, so the object-first sheet asks the
      // person side for it. Without that read a live-channel person was told
      // sharing would send her an invitation first.
      await render({
        subject: {
          subjectType: "core.document",
          subjectId: "doc-1",
          label: "Trip plan",
        },
        door: stubDoor({
          forSubject: () => Promise.resolve([standingGrant()]),
          forParty: () =>
            Promise.resolve({
              known: true,
              channel: { state: "live" as const, vaultId: "vault-priya" },
              grants: [],
            }),
        }),
      });
      expect(container?.textContent).toContain("Reachable");
      expect(container?.textContent).not.toContain("Not reached yet");
      expect(container?.textContent).not.toContain(
        "Sharing sends an invitation first."
      );
    });

    test("an object-first reach still being read paints no claim", async () => {
      let answer: () => void = () => undefined;
      await render({
        subject: {
          subjectType: "core.document",
          subjectId: "doc-1",
          label: "Trip plan",
        },
        door: stubDoor({
          forSubject: () => Promise.resolve([standingGrant()]),
          forParty: () =>
            new Promise((resolve) => {
              answer = (): void =>
                resolve({
                  known: true,
                  channel: { state: "live" },
                  grants: [],
                });
            }),
        }),
      });
      expect(container?.textContent).not.toContain("Not reached yet");
      expect(container?.textContent).not.toContain(
        "Sharing sends an invitation first."
      );
      await act(async () => answer());
      expect(container?.textContent).toContain("Reachable");
    });
  });
});
