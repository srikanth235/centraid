/*
 * `### Available host tools` grounding block (issue #80 follow-up).
 *
 * Spliced into the builder system prompt at session start, below the
 * UI grounding blocks. It lists the MCP servers the host CLI actually
 * has configured so the agent declares `requires.mcps` / `requires.tools`
 * and writes `ctx.tool('<server>.<tool>', …)` calls against reality —
 * not against training-prior guesses.
 *
 * Built dynamically (see agent-session.ts) from
 * `enumerateMcpServers()`. When enumeration comes back empty (no CLI,
 * old CLI, no servers configured) the block is omitted entirely.
 */

import type { McpServerInfo } from '@centraid/agent-runtime';

/**
 * Render the grounding block, or `undefined` when there are no servers
 * to ground against (caller omits the block in that case).
 */
export function buildToolsGroundingBlock(servers: readonly McpServerInfo[]): string | undefined {
  if (servers.length === 0) return undefined;

  const rows = servers.map((s) => {
    const status = s.status ? ` — ${s.status}` : '';
    return `- \`${s.name}\`${status}`;
  });

  return [
    '### Available host tools (ground `ctx.tool` and `requires` against this list)',
    '',
    'The host CLI driving automations has the MCP servers below configured.',
    'This is the **complete** set the automation runtime can reach — there are',
    'no others.',
    '',
    ...rows,
    '',
    '**Rules when authoring an automation manifest + handler:**',
    '',
    '- `ctx.tool(name, args)` — `name` is `"<server>.<tool>"`, where `<server>`',
    '  is one of the ids above. A handler that calls `ctx.tool` against a',
    '  server not on this list will fail at run time.',
    '- `requires.mcps` — declare **only** servers from this list. If the user',
    "  asks for an integration whose server isn't listed, say so plainly and",
    "  ask them to install/configure that MCP server first — don't author a",
    '  handler that depends on a server that does not exist.',
    '- `requires.tools` — list the fully-qualified `"<server>.<tool>"` names',
    '  the handler calls. The host scoping policy enforces this allowlist.',
    '- Tool *names within* a server are discovered by the CLI at run time;',
    "  this block grounds the *server* set. Use the user's prompt and the",
    "  server's documented surface for the specific tool id, and keep",
    '  `requires.tools` in sync with what the handler actually calls.',
  ].join('\n');
}
