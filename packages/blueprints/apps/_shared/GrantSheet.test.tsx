// @vitest-environment jsdom
//
// The grant sheet, web seat (#825). Five claims:
//
//  1. AUDIENCE-FIRST works end to end — person → what → capability → one write
//     door, carrying exactly the request the route takes.
//  2. `edit` is drawn ONLY where the declared registry answers it, a registry
//     still in flight refuses nothing, an unreadable one says which happened,
//     and the co-contribution sentence belongs to a group and nothing else.
//  3. An invitation nobody has accepted reads as pending, never as an error;
//     a person this vault has never reached says so in her own line; and a
//     reach nothing has read yet says NOTHING about her, on either entry.
//  4. Revoking asks first, in the honest best-effort words, and then reports
//     the ROUTE'S sentence verbatim rather than a local paraphrase.
//  5. NO SILENT SUCCESS. An audience this vault does not know, and a standing
//     grant the route left at another capability, each get their own sentence
//     instead of borrowing "nothing shared" or "already shared".
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";

import { NOBODY_TO_SHARE_WITH } from "./grant-audiences.ts";
import type { GrantDoor } from "./grant-door.ts";
import type {
  GrantRecord,
  GrantRequest,
  GrantSubjectOffer,
} from "./grant-plane.ts";
import { GrantSheet } from "./GrantSheet.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OFFERS: GrantSubjectOffer[] = [
  { subjectType: "core.document", capabilities: ["view", "edit"] },
  { subjectType: "media.asset", capabilities: ["view"] },
  { subjectType: "tally.group", capabilities: ["view", "edit"] },
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
        updatedAt: "2026-08-01T10:00:01.000Z",
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

/**
 * Mount the sheet and record what it SAYS rather than which functions ran:
 * the status line is the sheet's one feedback channel, so the list of
 * sentences that reached it is the observable outcome under test.
 */
async function mount(
  props: Partial<Parameters<typeof GrantSheet>[0]> = {}
): Promise<{ container: HTMLElement; status: string[] }> {
  const container = document.createElement("div");
  document.body.append(container);
  const status: string[] = [];
  const onStatus = (message: string): void => {
    status.push(message);
  };
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(GrantSheet, {
        open: true,
        onClose: () => undefined,
        audiences: AUDIENCES,
        subjects: [
          {
            subjectType: "core.document",
            subjectId: "doc-1",
            label: "Trip plan",
          },
        ],
        onStatus,
        door: stubDoor(),
        ...props,
      })
    );
  });
  return { container, status };
}

describe("the grant sheet, web seat", () => {
  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
  });

  describe("audience-first", () => {
    test("person, what and capability reach the write door as one request", async () => {
      const sent: GrantRequest[] = [];
      let closed = 0;
      const { container, status } = await mount({
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

      const person = container.querySelector("select") as HTMLSelectElement;
      expect(
        [...person.options].map((option) => option.textContent)
      ).toStrictEqual(["Priya", "Ravi"]);
      await act(async () => {
        person.value = "party-ravi";
        person.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => pressing(container, "Can edit").click());
      await act(async () => pressing(container, "Share").click());

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

    test("saying it twice is a success, not a failure", async () => {
      const { container, status } = await mount({
        door: stubDoor({
          create: () => Promise.resolve({ ok: true, outcome: "exists" }),
        }),
      });
      await act(async () => pressing(container, "Share").click());
      expect(status).toStrictEqual(["Already shared with Priya"]);
    });

    test("a capability the route did not change is not reported as a change", async () => {
      const standing = standingGrant();
      const { container, status } = await mount({
        door: stubDoor({
          forParty: () =>
            Promise.resolve({
              known: true,
              channel: { state: "live" as const },
              grants: [standing],
            }),
          // What the route answers for a standing `view` when `edit` is asked
          // for: `exists`, and the capability untouched.
          create: () =>
            Promise.resolve({
              ok: true,
              outcome: "exists_other_capability",
              standing: "view",
              grant: standing,
            }),
        }),
      });
      await act(async () => pressing(container, "Can edit").click());
      await act(async () => pressing(container, "Share").click());
      expect(status).toStrictEqual([
        "Already shared with Priya for viewing; changing access is not offered yet — revoke and share again to change it.",
      ]);
    });

    test("a refusal is shown in the route's own words", async () => {
      const { container } = await mount({
        door: stubDoor({
          create: () =>
            Promise.resolve({
              ok: false as const,
              message:
                "media.asset can be shared for view, not for edit; editing it is not offered yet",
            }),
        }),
      });
      await act(async () => pressing(container, "Share").click());
      expect(container.textContent).toContain("editing it is not offered yet");
    });
  });

  describe("the capability picker never guesses", () => {
    test("edit is absent for a subject the registry answers view-only", async () => {
      const { container } = await mount({
        subjects: [
          { subjectType: "media.asset", subjectId: "photo-1", label: "Beach" },
        ],
      });
      expect(pressing(container, "Can view")).toBeDefined();
      expect(
        buttons(container).some((button) => button.textContent === "Can edit")
      ).toBe(false);
    });

    test("a subject the registry does not name at all refuses the verb", async () => {
      const { container } = await mount({
        subjects: [
          {
            subjectType: "locker.item",
            subjectId: "secret-1",
            label: "Bank PIN",
          },
        ],
      });
      expect(container.textContent).toContain(
        "cannot be shared as a standing grant"
      );
      expect(pressing(container, "Share").disabled).toBe(true);
    });

    test("a registry still being read refuses nothing and offers no Share", async () => {
      let answer: () => void = () => undefined;
      const { container } = await mount({
        door: stubDoor({
          subjects: () =>
            new Promise((resolve) => {
              answer = (): void => resolve({ readable: true, offers: OFFERS });
            }),
        }),
      });
      // Before the gateway answers, the sheet knows nothing about what a
      // document may be shared as — and refuses on nobody's behalf.
      expect(container.textContent).not.toContain(
        "cannot be shared as a standing grant"
      );
      expect(pressing(container, "Share").disabled).toBe(true);
      await act(async () => answer());
      expect(pressing(container, "Share").disabled).toBe(false);
      expect(pressing(container, "Can edit")).toBeDefined();
    });

    test("an unreadable registry says so rather than refusing the subject", async () => {
      const { container } = await mount({
        door: stubDoor({
          subjects: () => Promise.resolve({ readable: false, offers: [] }),
        }),
      });
      expect(container.textContent).toContain(
        "Shareable items could not be read."
      );
      expect(container.textContent).not.toContain(
        "cannot be shared as a standing grant"
      );
      expect(pressing(container, "Share").disabled).toBe(true);
    });

    test("a stale standing edit does not post a verb the picker never drew", async () => {
      const sent: GrantRequest[] = [];
      const { container } = await mount({
        subjects: [
          { subjectType: "media.asset", subjectId: "photo-1", label: "Beach" },
        ],
        door: stubDoor({
          forParty: () =>
            Promise.resolve({
              known: true,
              channel: { state: "live" as const },
              grants: [
                standingGrant({
                  grantId: "grant-2",
                  subjectType: "media.asset",
                  subjectId: "photo-1",
                  capability: "edit",
                }),
              ],
            }),
          create: (request) => {
            sent.push(request);
            return Promise.resolve({ ok: true, outcome: "created" });
          },
        }),
      });
      expect(
        buttons(container).some((button) => button.textContent === "Can edit")
      ).toBe(false);
      await act(async () => pressing(container, "Share").click());
      expect(sent.map((request) => request.capability)).toStrictEqual(["view"]);
    });

    test("co-contribution is said for a group with edit, and nowhere else", async () => {
      const { container } = await mount({
        subjects: [
          {
            subjectType: "tally.group",
            subjectId: "group-1",
            label: "Ski trip",
          },
        ],
      });
      expect(container.textContent).not.toContain("same group tally");
      await act(async () => pressing(container, "Can edit").click());
      expect(container.textContent).toContain(
        "Everyone with edit adds to the same group tally."
      );
    });
  });

  describe("absent is never empty", () => {
    test("a person this vault has never reached says so", async () => {
      const { container } = await mount();
      expect(container.textContent).toContain("Not reached yet");
      expect(container.textContent).toContain(
        "Sharing sends an invitation first."
      );
    });

    test("an unaccepted invitation reads as pending, not as an error", async () => {
      const { container } = await mount({
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
      expect(container.textContent).toContain("Invitation pending");
      expect(
        container.querySelector('[data-delivery="awaiting_channel"]')
      ).not.toBeNull();
    });

    test("a severed link is rendered as its own state, not as an absence", async () => {
      const { container } = await mount({
        door: stubDoor({
          forParty: () =>
            Promise.resolve({
              known: true,
              channel: { state: "severed" as const, vaultId: "vault-priya" },
              grants: [],
            }),
        }),
      });
      expect(container.textContent).toContain("Link ended");
      expect(container.textContent).toContain(
        "The link to their vault ended; nothing new can be delivered."
      );
      expect(container.querySelector('[data-reach="severed"]')).not.toBeNull();
      expect(container.textContent).not.toContain("Not reached yet");
    });

    test("a reach still being read makes no claim about the person", async () => {
      let answer: () => void = () => undefined;
      const { container } = await mount({
        door: stubDoor({
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
      // The read has not answered. "Not reached yet" would be a definite
      // claim about Priya that nothing has established.
      expect(container.textContent).toContain("Checking…");
      expect(container.textContent).not.toContain("Not reached yet");
      expect(container.textContent).not.toContain(
        "Sharing sends an invitation first."
      );
      await act(async () => answer());
      expect(container.textContent).toContain("Reachable");
    });

    test("a person this vault has no record of says that, and nothing else", async () => {
      const { container } = await mount({
        door: stubDoor({
          forParty: () =>
            Promise.resolve({ known: false, channel: undefined, grants: [] }),
        }),
      });
      expect(container.textContent).toContain(
        "This vault has no record of Priya."
      );
      // Three sentences this one is NOT allowed to arrive wearing.
      expect(container.textContent).not.toContain(
        "Nothing shared with Priya yet."
      );
      expect(container.textContent).not.toContain("Shares could not be read.");
      expect(container.textContent).not.toContain("Not reached yet");
    });

    test("a circle this vault has no record of says that, not 'nothing shared'", async () => {
      const { container } = await mount({
        audiences: [
          { kind: "circle" as const, id: "circle-1", label: "Ski trip" },
        ],
        door: stubDoor({
          forAudience: () => Promise.resolve({ known: false, grants: [] }),
        }),
      });
      expect(container.textContent).toContain(
        "This vault has no record of Ski trip."
      );
      expect(container.textContent).not.toContain(
        "Nothing shared with Ski trip yet."
      );
    });

    test("a grant addressed to no vault yet is not a delivered one", async () => {
      const { container } = await mount({
        door: stubDoor({
          forParty: () =>
            Promise.resolve({
              known: true,
              channel: { state: "live" as const },
              grants: [standingGrant({ fulfillment: [] })],
            }),
        }),
      });
      expect(container.textContent).toContain("Not sent yet");
    });
  });

  describe("revoking", () => {
    test("asks first in best-effort words, then reports the route verbatim", async () => {
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
          forParty: () =>
            Promise.resolve({
              known: true,
              channel: { state: "live" as const },
              grants: [standingGrant()],
            }),
        }),
      });

      await act(async () => pressing(container, "Revoke").click());
      // The confirm is honest about what a removal actually is: a REQUEST to a
      // vault this device does not own.
      expect(container.textContent).toContain("Stop sharing with Priya?");
      expect(container.textContent).toContain(
        "Priya loses access to the document, and their vault is asked to remove its copy."
      );
      // Destructive is outlined in `--net`, never the view's filled primary.
      const confirm = pressing(container, "Revoke");
      expect(confirm.className).toContain("destructive");
      expect(confirm.className).not.toContain("primary");

      await act(async () => confirm.click());
      expect(revoked).toStrictEqual(["grant-1"]);
      expect(status).toStrictEqual([
        "no longer shared; a vault holding a copy has been asked to remove it and has not yet confirmed",
      ]);
    });

    test("keeping the share writes nothing", async () => {
      const revoked: string[] = [];
      const { container } = await mount({
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
      await act(async () => pressing(container, "Revoke").click());
      await act(async () => pressing(container, "Keep sharing").click());
      expect(revoked).toStrictEqual([]);
      expect(container.textContent).toContain("Already shared");
    });
  });

  describe("object-first", () => {
    test("the same core answers the object side, with the what step pinned", async () => {
      let subjectReads = 0;
      const { container } = await mount({
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
      // One select only: the person. "What" is a fixed line, not a picker.
      expect(container.querySelectorAll("select")).toHaveLength(1);
      expect(container.textContent).toContain("Trip plan");
      // The standing list is the object side, so its rows name PEOPLE.
      expect(container.textContent).toContain("Priya");
    });

    test("the person's reach is read here too, never invented from the object read", async () => {
      // `forSubject` cannot answer reach, so the object-first sheet asks the
      // person side for it. Without that read a live-channel person was told
      // sharing would send her an invitation first.
      const { container } = await mount({
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
      expect(container.textContent).toContain("Reachable");
      expect(container.textContent).not.toContain("Not reached yet");
      expect(container.textContent).not.toContain(
        "Sharing sends an invitation first."
      );
    });

    test("an object-first reach still being read paints no claim", async () => {
      let answer: () => void = () => undefined;
      const { container } = await mount({
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
      expect(container.textContent).not.toContain("Not reached yet");
      expect(container.textContent).not.toContain(
        "Sharing sends an invitation first."
      );
      await act(async () => answer());
      expect(container.textContent).toContain("Reachable");
    });
  });

  describe("a roster with nobody in it", () => {
    test("says so in words instead of drawing an empty picker", async () => {
      const { container } = await mount({ audiences: [] });
      expect(container.textContent).toContain(NOBODY_TO_SHARE_WITH);
      expect(
        container.querySelector('select[aria-label="Person or circle"]')
      ).toBeNull();
    });

    test("cannot post a grant addressed to nobody", async () => {
      const { container } = await mount({ audiences: [] });
      expect(pressing(container, "Share").disabled).toBe(true);
    });
  });
});
