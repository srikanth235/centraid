// The link-ticket sentences (#929 S6). The expiry is read off the TICKET, so a
// gateway that changes its TTL changes what a member is told without a second
// edit here — the failure this pins is the alternative, a remembered "15
// minutes" that quietly becomes a lie.
import { describe, expect, test } from "vitest";

import { linkTicketExpiry } from "./grant-copy.ts";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");

describe("the link ticket's expiry sentence", () => {
  test("counts the minutes the ticket itself has left", () => {
    expect(linkTicketExpiry("2026-09-04T12:09:30.000Z", NOW)).toBe(
      "Good for 9 more minutes."
    );
  });

  test("says one minute in the singular", () => {
    expect(linkTicketExpiry("2026-09-04T12:01:10.000Z", NOW)).toBe(
      "Good for 1 more minute."
    );
  });

  // An expired ticket that still reads "good for" is the one outcome that
  // wastes a member's time twice: they send it, and it fails at the far end.
  test("an expired or unparseable expiry says to make another", () => {
    expect(linkTicketExpiry("2026-09-04T11:59:00.000Z", NOW)).toBe(
      "This ticket has expired — make another."
    );
    expect(linkTicketExpiry("not-a-date", NOW)).toBe(
      "This ticket has expired — make another."
    );
  });
});
