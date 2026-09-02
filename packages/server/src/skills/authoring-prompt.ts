/** Authoring extra-system-prompt: the route's app-context preamble (`baseExtra`) first, then the kind's authoring contract. `app` gets none (#799): the bundled apps are inline React routes written in this repo, not generated at turn time. */

import { composeSkills } from "./compose.js";

export interface AuthoringExtraPromptInput {
  /** Route's app-context preamble; kept first — it carries the app's identity, declared handler catalog, and vault/ext declaration. */
  baseExtra: string;
  /** App kind from the worktree `app.json`; only automations carry a contract. */
  appKind: "app" | "automation";
}

export function buildAuthoringExtraPrompt(
  input: AuthoringExtraPromptInput
): string {
  const blocks: string[] = input.baseExtra ? [input.baseExtra] : [];
  if (input.appKind === "automation") {
    blocks.push(composeSkills(["automation-authoring"]));
  }
  return blocks.join("\n\n");
}
