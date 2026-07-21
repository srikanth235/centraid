/*
 * Authoring system-prompt composition — the builder chat's grounding, owned
 * here in `@centraid/skills` rather than at the call site (issue #147,
 * Concern 1).
 *
 * A builder turn's extra-system-prompt is: the route's app-context preamble
 * (`baseExtra`) first, then the authoring contract for the app `kind`
 * (`composeSkills`), then — for apps with a front end — the live UI grounding
 * (`buildUiGroundingBlocks`).
 *
 * (The host-tool grounding block this used to append went away with the
 * `ctx.tool` rail — issue #484.)
 */

import { composeSkills } from './compose.js';
import { buildUiGroundingBlocks } from './ui-grounding.js';

export interface AuthoringExtraPromptInput {
  /** The route's app-context preamble — kept first; carries the app's identity, declared handler catalog, and vault/ext declaration. */
  baseExtra: string;
  /** App kind from the worktree `app.json`; an automation has no front end. */
  appKind: 'app' | 'automation';
}

/**
 * Compose the unified builder system prompt: the data/schema preamble first,
 * then the authoring blocks for the app `kind`. Returns the blocks joined by
 * blank lines.
 */
export function buildAuthoringExtraPrompt(input: AuthoringExtraPromptInput): string {
  const blocks: string[] = input.baseExtra ? [input.baseExtra] : [];
  if (input.appKind === 'automation') {
    blocks.push(composeSkills(['automation-authoring']));
  } else {
    blocks.push(composeSkills(['authoring-centraid-apps']), ...buildUiGroundingBlocks());
  }
  return blocks.join('\n\n');
}
