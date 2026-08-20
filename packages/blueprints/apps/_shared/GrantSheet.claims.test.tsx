// @vitest-environment jsdom
//
// Grant sheet claims that are not the write-door walk (#825): reach honesty,
// revoke confirm, and the object-first entry.
import { act } from "react";
import { afterEach, describe, expect, test } from "vitest";

import {
  mount,
  pressing,
  standingGrant,
  stubDoor,
  unmountSheet,
} from "./grant-sheet-harness.ts";

describe("the grant sheet, web seat — claims", () => {
  afterEach(() => {
    unmountSheet();
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
});
