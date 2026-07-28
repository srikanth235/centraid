// Shared fixtures for the provider event-source cursor tests: the two
// connection descriptors the adapters are driven with, and a `pollJson` stub
// that hands back a scripted queue of provider responses (and fails loudly on
// an unexpected extra request). Test-only module — imported by
// automation-event-sources.test.ts / -github.test.ts, never shipped.

import { vi } from "vitest";

import type { PollJson, PollJsonResponse } from "./automation-event-sources.js";

export const gmail = {
  connectionId: "gmail-account-1",
  kind: "pull.gmail",
  label: "Personal Gmail",
};
export const github = {
  connectionId: "github-account-1",
  kind: "pull.github",
  label: "Work GitHub",
};

export function replies(...responses: PollJsonResponse[]): PollJson {
  return vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected provider request");
    return response;
  });
}
