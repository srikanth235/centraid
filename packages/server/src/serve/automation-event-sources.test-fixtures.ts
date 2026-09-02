// Test-only fixtures (never shipped): a `pollJson` stub handing back a scripted
// queue of provider responses, failing loudly on an unexpected extra request.

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
