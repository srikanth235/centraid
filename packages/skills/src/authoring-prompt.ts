/*
 * Authoring system-prompt composition — the builder chat's grounding, owned
 * here in `@centraid/skills` rather than at the call site (issue #147,
 * Concern 1).
 *
 * A builder turn's extra-system-prompt is: the route's data/schema preamble
 * (`baseExtra`) first, then the authoring contract for the app `kind`
 * (`composeSkills`), then — for apps with a front end — the live UI grounding
 * (`buildUiGroundingBlocks`), then the host tool list (`buildToolsGroundingBlock`).
 * This used to live in the gateway's `unified-chat-runner`; it belongs with the
 * skills it composes.
 *
 * Enumerating host tools spawns the configured CLI, so the result is cached
 * per runner kind for the process (best-effort: a failure caches nothing and
 * the next turn retries). The enumerator is injectable to keep tests hermetic.
 */

import { enumerateHostTools, type HostTool, type RunnerPrefs } from '@centraid/agent-runtime';
import { composeSkills } from './compose.js';
import { buildUiGroundingBlocks } from './ui-grounding.js';
import { buildToolsGroundingBlock } from './dynamic.js';

// `enumerateHostTools` spawns the configured CLI to list its tools — too
// costly to repeat every turn, and stable for a given runner kind within a
// process. Cache the resolved tool list per kind.
const toolsByKind = new Map<RunnerPrefs['kind'], readonly HostTool[]>();

async function groundingToolsFor(
  enumerate: typeof enumerateHostTools,
  prefs: RunnerPrefs,
  cwd: string,
): Promise<readonly HostTool[]> {
  const cached = toolsByKind.get(prefs.kind);
  if (cached) return cached;
  try {
    const tools = await enumerate(prefs.kind, {
      cwd,
      ...(prefs.binPath ? { binPath: prefs.binPath } : {}),
    });
    toolsByKind.set(prefs.kind, tools);
    return tools;
  } catch {
    return [];
  }
}

export interface AuthoringExtraPromptInput {
  /** The route's data/schema preamble — kept first, carries the live schema. */
  baseExtra: string;
  /** App kind from the worktree `app.json`; an automation has no front end. */
  appKind: 'app' | 'automation';
  /** Active runner prefs (kind selects which CLI's tools to enumerate). */
  prefs: RunnerPrefs;
  /** Working dir the turn runs in — passed to the enumerator as spawn cwd. */
  cwd: string;
  /** Host-tool enumerator — defaults to `enumerateHostTools`; injected in
   *  tests to stay hermetic (no CLI on the box). */
  enumerate?: typeof enumerateHostTools;
}

/**
 * Compose the unified builder system prompt: the data/schema preamble first,
 * then the authoring blocks for the app `kind`, then the live host-tool
 * grounding. Returns the blocks joined by blank lines.
 */
export async function buildAuthoringExtraPrompt(input: AuthoringExtraPromptInput): Promise<string> {
  const enumerate = input.enumerate ?? enumerateHostTools;
  const blocks: string[] = input.baseExtra ? [input.baseExtra] : [];
  if (input.appKind === 'automation') {
    blocks.push(composeSkills(['automation-authoring']));
  } else {
    blocks.push(composeSkills(['authoring-centraid-apps']), ...buildUiGroundingBlocks());
  }
  const toolsBlock = buildToolsGroundingBlock(
    await groundingToolsFor(enumerate, input.prefs, input.cwd),
  );
  if (toolsBlock) blocks.push(toolsBlock);
  return blocks.join('\n\n');
}
