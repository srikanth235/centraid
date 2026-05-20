/*
 * `### Available host tools` grounding block (issue #80 follow-up).
 *
 * Spliced into the builder system prompt at session start, below the
 * UI grounding blocks. It lists the tools the host runtime actually
 * exposes so the agent writes `ctx.tool(...)` calls and `requires.tools`
 * against reality — not against training-prior guesses.
 *
 * A tool is a tool: this block does not distinguish native CLI builtins
 * from MCP-backed tools beyond a parenthetical tag, because the harness
 * doesn't care about the source. Built dynamically (see agent-session.ts)
 * from `enumerateHostTools()`; omitted entirely when enumeration is empty.
 */

import type { HostTool } from '@centraid/agent-runtime';

/**
 * Render the grounding block, or `undefined` when there are no tools to
 * ground against (caller omits the block in that case).
 */
export function buildToolsGroundingBlock(tools: readonly HostTool[]): string | undefined {
  if (tools.length === 0) return undefined;

  const lines: string[] = [
    '### Available host tools (ground `ctx.tool` and `requires` against this list)',
    '',
    'These are the tools the host runtime exposes to automation handlers —',
    'native builtins and MCP-backed tools alike. This is the **complete**',
    'set; a handler that calls `ctx.tool` with a name not on this list',
    'fails at run time.',
    '',
    'Call a tool by passing its name verbatim to `ctx.tool(name, args)`:',
    '',
  ];

  for (const t of tools) {
    const tag = t.source === 'mcp' ? ' _(mcp)_' : ' _(native)_';
    const desc = t.description ? ` — ${t.description}` : '';
    lines.push(`- \`${t.name}\`${tag}${desc}`);
  }

  lines.push(
    '',
    '**Rules when authoring an automation manifest + handler:**',
    '',
    '- `requires.tools` — list the fully-qualified tool names the handler',
    '  calls. The host scoping policy enforces this allowlist.',
    '- `requires.mcps` — list the MCP servers behind the `_(mcp)_` tools',
    '  you use (the segment before the `.` in the tool name).',
    "- If the user asks for an integration whose tool isn't listed above,",
    '  say so plainly and ask them to install/configure it first — do',
    '  **not** author a handler that depends on a tool that does not exist.',
  );

  return lines.join('\n');
}
