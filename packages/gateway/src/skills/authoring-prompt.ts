/*
 * Authoring system-prompt composition — the automation-authoring harness's
 * grounding, owned here in the gateway's `src/skills/` rather than at the call
 * site (issue #147, Concern 1).
 *
 * An authoring turn's extra-system-prompt is: the route's app-context preamble
 * (`baseExtra`) first, then the authoring contract for the app `kind`
 * (`composeSkills`).
 *
 * The UI-grounding blocks that used to follow for `kind: "app"` retired with
 * the served-app plane they described (issue #799): nothing authors an app's
 * front end any more — the eight bundled apps are inline React routes in the
 * shell, written in this repo, not generated against a design-token contract
 * at turn time. Automation authoring, which has no front end, is untouched.
 */

import { composeSkills } from "./compose.js";

export interface AuthoringExtraPromptInput {
  /** The route's app-context preamble — kept first; carries the app's identity, declared handler catalog, and vault/ext declaration. */
  baseExtra: string;
  /** App kind from the worktree `app.json`; only automations carry a contract. */
  appKind: "app" | "automation";
}

/**
 * Compose the authoring system prompt: the data/schema preamble first, then
 * the authoring contract for the app `kind`. Returns the blocks joined by
 * blank lines.
 */
export function buildAuthoringExtraPrompt(
  input: AuthoringExtraPromptInput
): string {
  const blocks: string[] = input.baseExtra ? [input.baseExtra] : [];
  if (input.appKind === "automation") {
    blocks.push(composeSkills(["automation-authoring"]));
  }
  return blocks.join("\n\n");
}
