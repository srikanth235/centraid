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
import { act } from "react";
import { afterEach, describe, expect, test } from "vitest";

import { NOBODY_TO_SHARE_WITH } from "./grant-audiences.ts";
import type { GrantRequest } from "./grant-plane.ts";
import {
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
