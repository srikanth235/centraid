// @vitest-environment jsdom
//
// THE PERSON SCREEN AS THE GRANT DASHBOARD (#825). The claims are the test
// names below; two constraints they encode and a reader must not relax: the
// listing comes from the ONE read the ruling names (`?partyId=`), and every
// standing is the VAULT'S phrase (#883, ruling V-phrases), never one derived
// here.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";

import type { GrantDoor } from "../../_shared/grant-door.ts";
import type { GrantRecord, GrantRequest } from "../../_shared/grant-plane.ts";
import { PersonGrants } from "./PersonGrants.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function grant(overrides: Partial<GrantRecord> = {}): GrantRecord {
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
        updatedAt: "2026-08-01T10:00:01.000Z",
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
    subjects: () =>
      Promise.resolve({
        readable: true,
        offers: [{ subjectType: "core.document", capabilities: ["view"] }],
      }),
    forParty: () =>
      Promise.resolve({
        known: true,
        channel: { state: "live" as const },
        grants: [grant()],
      }),
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

function buttons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")];
}

function pressing(container: HTMLElement, label: string): HTMLButtonElement {
  const found = buttons(container).find(
    (button) => button.textContent?.trim() === label
  );
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

async function mount(
  props: Partial<Parameters<typeof PersonGrants>[0]> = {}
): Promise<{ container: HTMLElement; status: string[] }> {
  const container = document.createElement("div");
  document.body.append(container);
  const status: string[] = [];
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(PersonGrants, {
        partyId: "party-priya",
        personName: "Priya",
        roster: [
          { party_id: "party-priya", name: "Priya" },
          { party_id: "party-ravi", name: "Ravi" },
        ],
        open: true,
        onToggle: () => undefined,
        onStatus: (message: string) => status.push(message),
        door: stubDoor(),
        available: true,
        ...props,
      })
    );
  });
  return { container, status };
}

describe("the person screen's grant dashboard", () => {
  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
  });

  test("lists every live grant reaching the party, and no revoked one", async () => {
    let asked: string | null = null;
    const { container } = await mount({
      door: stubDoor({
        forParty: (partyId) => {
          asked = partyId;
          return Promise.resolve({
            known: true,
            channel: { state: "live" as const },
            grants: [
              grant(),
              grant({ grantId: "grant-2", subjectType: "media.asset" }),
              grant({
                grantId: "grant-3",
                subjectType: "docs.folder",
                revokedAt: "2026-08-02T10:00:00.000Z",
              }),
            ],
          });
        },
      }),
    });
    expect(asked).toBe("party-priya");
    const text = container.textContent ?? "";
    expect(text).toContain("document");
    expect(text).toContain("photo");
    expect(text).not.toContain("folder");
    expect(text).toContain("Shared");
  });

  test("an unreached person is an invitation opportunity, not an error", async () => {
    const { container } = await mount({
      door: stubDoor({
        forParty: () =>
          Promise.resolve({
            known: true,
            channel: null,
            grants: [
              grant({
                phrase: "on its way",
                reason:
                  "there is no way to reach them yet; the ask is recorded",
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
    const text = container.textContent ?? "";
    // The reach line names the opportunity; the grant row names the wait.
    expect(text).toContain("Not reached yet");
    expect(text).toContain("Sharing sends an invitation first.");
    // The row's standing is the WIRE's phrase, never one derived here.
    expect(text).toContain("On its way");
  });

  test("revoke asks in the kit's words, then reports the route's sentence", async () => {
    const revoked: string[] = [];
    const { container, status } = await mount({
      door: stubDoor({
        revoke: (grantId) => {
          revoked.push(grantId);
          return Promise.resolve({
            ok: true,
            message:
              "no longer shared; a vault holding a copy has been asked to remove it and has not yet confirmed",
          });
        },
      }),
    });
    await act(async () => {
      pressing(container, "Revoke").click();
    });
    const asking = container.textContent ?? "";
    expect(asking).toContain("Stop sharing with Priya?");
    expect(asking).toContain("their vault is asked to remove its copy");
    expect(asking).toContain("Keep sharing");

    // The confirm's own Revoke is the second one on screen — the row's control
    // is still there behind the panel.
    const confirmButton = buttons(container).filter(
      (button) => button.textContent?.trim() === "Revoke"
    );
    await act(async () => {
      confirmButton[confirmButton.length - 1]?.click();
    });
    expect(revoked).toStrictEqual(["grant-1"]);
    expect(status).toStrictEqual([
      "no longer shared; a vault holding a copy has been asked to remove it and has not yet confirmed",
    ]);
  });

  test("a refused read prints the refusal, never an empty list", async () => {
    const { container } = await mount({
      door: stubDoor({
        forParty: () =>
          Promise.reject(new Error("the vault refused that read")),
      }),
    });
    const text = container.textContent ?? "";
    expect(text).toContain("the vault refused that read");
    expect(text).not.toContain("Nothing shared with Priya yet.");
  });

  test("a party this vault has no record of keeps its own sentence", async () => {
    const { container } = await mount({
      door: stubDoor({
        forParty: () =>
          Promise.resolve({ known: false, channel: undefined, grants: [] }),
      }),
    });
    const text = container.textContent ?? "";
    expect(text).toContain("This vault has no record of Priya.");
    expect(text).not.toContain("Nothing shared with Priya yet.");
  });

  test("a host with no grant bridge says so rather than drawing zero", async () => {
    const { container } = await mount({ available: false });
    expect(container.textContent ?? "").toContain(
      "Sharing needs a newer gateway connection."
    );
  });

  test("nothing shared yet is only ever said by a read that answered", async () => {
    const { container } = await mount({
      door: stubDoor({
        forParty: () =>
          Promise.resolve({ known: true, channel: null, grants: [] }),
      }),
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Nothing shared with Priya yet.");
    // With nothing to name, there is no Share control to press, and the screen
    // says where a share begins instead.
    expect(text).toContain("A share starts in the app that holds the thing.");
    expect(
      buttons(container).some(
        (button) => button.textContent?.trim() === "Share"
      )
    ).toBe(false);
  });

  test("sharing to an unreached person is one gesture — no link step", async () => {
    const sent: GrantRequest[] = [];
    const { container, status } = await mount({
      door: stubDoor({
        forParty: () =>
          Promise.resolve({
            known: true,
            // Never reached: the grant will park at `awaiting_channel` and
            // mint the invitation itself.
            channel: null,
            grants: [grant()],
          }),
        create: (request) => {
          sent.push(request);
          return Promise.resolve({ ok: true, outcome: "created" as const });
        },
      }),
    });
    // ONE gesture opens the sheet, ONE press sends the grant. Nothing in
    // between asks the member to link a vault first.
    await act(async () => {
      pressing(container, "Share").click();
    });
    const sheetButtons = buttons(container).filter(
      (button) => button.textContent?.trim() === "Share"
    );
    await act(async () => {
      sheetButtons[sheetButtons.length - 1]?.click();
    });
    expect(sent).toStrictEqual([
      {
        audienceKind: "party",
        audienceId: "party-priya",
        subjectType: "core.document",
        subjectId: "doc-1",
        capability: "view",
      },
    ]);
    expect(status).toStrictEqual(["Priya can see it"]);
  });
});
