/*
 * Authoring system-prompt composition — the builder chat's grounding, owned
 * here in `@centraid/skills` rather than at the call site (issue #147,
 * Concern 1).
 *
 * A builder turn's extra-system-prompt is: the route's data/schema preamble
 * (`baseExtra`) first, then the authoring contract for the app `kind`
 * (`composeSkills`), then — for apps with a front end — the live UI grounding
 * (`buildUiGroundingBlocks`), then the host tool list (`buildToolsGroundingBlock`).
 *
 * Host tools arrive as DATA (`input.tools`), not enumerated here: the gateway
 * resolves them from the gateway-owned catalog (populated by a boot probe /
 * explicit refresh), so a builder turn never spawns a CLI to list tools. An
 * empty list simply omits the grounding block.
 */

import { type HostTool } from '@centraid/agent-runtime';
import { composeSkills } from './compose.js';
import { buildUiGroundingBlocks } from './ui-grounding.js';
import { buildToolsGroundingBlock } from './dynamic.js';

export interface AuthoringExtraPromptInput {
  /** The route's data/schema preamble — kept first, carries the live schema. */
  baseExtra: string;
  /** App kind from the worktree `app.json`; an automation has no front end. */
  appKind: 'app' | 'automation';
  /** Host tools (builtins + MCP) for the active runner, read from the catalog. */
  tools: readonly HostTool[];
}

/**
 * Compose the unified builder system prompt: the data/schema preamble first,
 * then the authoring blocks for the app `kind`, then the host-tool grounding.
 * Returns the blocks joined by blank lines.
 */
export function buildAuthoringExtraPrompt(input: AuthoringExtraPromptInput): string {
  const blocks: string[] = input.baseExtra ? [input.baseExtra] : [];
  if (input.appKind === 'automation') {
    blocks.push(composeSkills(['automation-authoring']));
  } else {
    blocks.push(composeSkills(['authoring-centraid-apps']), ...buildUiGroundingBlocks());
  }
  const toolsBlock = buildToolsGroundingBlock(input.tools);
  if (toolsBlock) blocks.push(toolsBlock);
  return blocks.join('\n\n');
}
