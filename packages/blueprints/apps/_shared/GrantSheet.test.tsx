// @vitest-environment jsdom
//
// The grant sheet, web seat (#825). Each test names the claim it holds; two
// the titles cannot carry: REFUSED IS NOT UNREACHABLE (#880) — a gateway that
// answered no and one nothing reached keep their own sentences — and CHANGING
// A STANDING ANSWER IS WITHDRAW-THEN-GRANT (#883, ruling V-table), never an
// answer edited in place.
import { act } from "react";
import { afterEach, describe, expect, test } from "vitest";

import { NOBODY_TO_SHARE_WITH } from "./grant-audiences.ts";
import { GrantUnreachableError } from "./grant-door.ts";
import type { GrantRequest } from "./grant-plane.ts";
import {
  GROUP_SUBJECT,
  OFFERS,
  buttons,
  mount,
  pressing,
  standingGrant,
  stubDoor,
  unmountSheet,
} from "./grant-sheet-harness.ts";

describe("the grant sheet, web seat", () => {
  afterEach(() => {
    unmountSheet();
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
        subjects: [GROUP_SUBJECT],
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
          subjectType: "tally.group",
          subjectId: "group-1",
          capability: "edit",
          subjectLabel: "Ski trip",
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

    test("changing a standing capability asks first, then withdraws and grants again", async () => {
      // #883 (ruling V-table): the plane refuses an answer edited in place, so
      // the sheet does not post one. It names the consequence — their copy is
      // asked for back — and only then runs the withdraw-then-grant pair.
      const standing = standingGrant({
        subjectType: "tally.group",
        subjectId: "group-1",
      });
      const changed: Array<[string, GrantRequest]> = [];
      const created: GrantRequest[] = [];
      const { container, status } = await mount({
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
      await act(async () => pressing(container, "Can edit").click());
      // The primary action is worded as the change, not as the mechanism.
      expect(
        buttons(container).some((button) => button.textContent === "Share")
      ).toBe(false);
      await act(async () => pressing(container, "Change access").click());
      expect(container.textContent).toContain(
        "asked to remove its copy and is sent a fresh one"
      );
      // Nothing has been written yet: the question is still open.
      expect(changed).toStrictEqual([]);
      await act(async () => pressing(container, "Change access").click());
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
      const { container, status } = await mount({
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
      await act(async () => pressing(container, "Can edit").click());
      await act(async () => pressing(container, "Change access").click());
      await act(async () => pressing(container, "Leave it as it is").click());
      expect(changed).toStrictEqual([]);
      expect(status).toStrictEqual([]);
      // The sheet is back, still offering the change.
      expect(
        buttons(container).some(
          (button) => button.textContent === "Change access"
        )
      ).toBe(true);
    });

    test("the standing row prints the vault's phrase and reason, never one of its own", async () => {
      // The wire says where a grant stands; the row prints exactly that.
      const { container } = await mount({
        door: stubDoor({
          forParty: () =>
            Promise.resolve({
              known: true,
              channel: { state: "live" as const },
              grants: [
                standingGrant({
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
      expect(container.textContent).toContain("On its way");
      expect(container.textContent).toContain(
        "there is no way to reach them yet; the ask is recorded"
      );
      // A locally derived word may not reach the surface at all.
      expect(container.textContent).not.toContain("Invitation pending");
    });

    test("a refusal is shown in the route's own words", async () => {
      const { container } = await mount({
        door: stubDoor({
          create: () =>
            Promise.resolve({
              ok: false as const,
              reach: "refused" as const,
              message:
                "media.asset can be shared for view, not for edit; editing it is not offered yet",
            }),
        }),
      });
      await act(async () => pressing(container, "Share").click());
      expect(container.textContent).toContain("editing it is not offered yet");
    });

    test("a read that never left the device says so, not that it was refused", async () => {
      // The gateway said NOTHING, so its refusal sentence would put words in a
      // mouth that never opened (#880).
      const { container } = await mount({
        door: stubDoor({
          forParty: () =>
            Promise.reject(
              new GrantUnreachableError("read what this person can reach")
            ),
        }),
      });
      expect(container.textContent).toContain(
        "Shares could not be read — the gateway is out of reach."
      );
      expect(container.textContent).not.toContain("Shares could not be read.");
    });

    test("a gateway that refused the read is not reported as an outage", async () => {
      const { container } = await mount({
        door: stubDoor({
          forParty: () => Promise.reject(new Error("the vault refused that")),
        }),
      });
      expect(container.textContent).toContain("Shares could not be read.");
      expect(container.textContent).not.toContain("out of reach");
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
        subjects: [GROUP_SUBJECT],
        door: stubDoor({
          subjects: () =>
            new Promise((resolve) => {
              answer = (): void => resolve({ readable: true, offers: OFFERS });
            }),
        }),
      });
      // Before the gateway answers, the sheet knows nothing about what a
      // group may be shared as — and refuses on nobody's behalf.
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
      expect(container.textContent).not.toContain("out of reach");
      expect(container.textContent).not.toContain(
        "cannot be shared as a standing grant"
      );
      expect(pressing(container, "Share").disabled).toBe(true);
    });

    test("a registry nobody could ask is unknown, not refused", async () => {
      const { container } = await mount({
        door: stubDoor({
          subjects: () =>
            Promise.resolve({
              readable: false,
              offers: [],
              reach: "unreachable" as const,
            }),
        }),
      });
      expect(container.textContent).toContain(
        "Shareable items are unknown — the gateway is out of reach."
      );
      expect(container.textContent).not.toContain(
        "Shareable items could not be read."
      );
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
          changeCapability: (_grantId, request) => {
            sent.push(request);
            return Promise.resolve({ ok: true, outcome: "created" });
          },
        }),
      });
      expect(
        buttons(container).some((button) => button.textContent === "Can edit")
      ).toBe(false);
      // Narrowing a standing `edit` the registry no longer offers is still a
      // CHANGE to the answer, so it goes through withdraw-then-grant and asks
      // first — what it may never do is post the undrawn `edit` back.
      await act(async () => pressing(container, "Change access").click());
      await act(async () => pressing(container, "Change access").click());
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
