/*
 * `### Available host tools` grounding block (issue #80 follow-up).
 *
 * Spliced into the builder system prompt at session start, below the
 * UI grounding blocks. It lists the tools the host runtime actually
 * exposes so the agent writes `ctx.tool(...)` calls and `requires.tools`
 * against reality — not against training-prior guesses.
 *
 * A tool is a tool: this block does not distinguish native CLI builtins
 * from MCP-backed tools beyond a parenthetical note, because the harness
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

  const specific = tools.filter((t) => t.granularity === 'tool');
  const servers = tools.filter((t) => t.granularity === 'server');

  const lines: string[] = [
    '### Available host tools (ground `ctx.tool` and `requires` against this list)',
    '',
    'These are the tools the host runtime exposes to automation handlers.',
    'This is the **complete** set — there are no others. A handler that',
    'calls `ctx.tool` with a name not derivable from this list fails at run',
    'time.',
    '',
  ];

  if (specific.length > 0) {
    lines.push('**Callable tools** — pass the name verbatim to `ctx.tool(name, args)`:', '');
    for (const t of specific) {
      const tag = t.source === 'mcp' ? ' _(mcp)_' : ' _(native)_';
      lines.push(`- \`${t.name}\`${tag}`);
    }
    lines.push('');
  }

  if (servers.length > 0) {
    lines.push(
      '**MCP servers** — the runtime reports the server but not its tool ids;',
      'call a specific tool as `ctx.tool("<server>.<tool>", args)`:',
      '',
    );
    for (const s of servers) lines.push(`- \`${s.name}\``);
    lines.push('');
  }

  lines.push(
    '**Rules when authoring an automation manifest + handler:**',
    '',
    '- `requires.tools` — list the fully-qualified tool names the handler',
    '  calls. The host scoping policy enforces this allowlist.',
    '- `requires.mcps` — list the MCP servers behind the tools you use.',
    "- If the user asks for an integration whose tool/server isn't listed",
    '  above, say so plainly and ask them to install/configure it first —',
    'do **not** author a handler that depends on a tool that does not exist.',
  );

  return lines.join('\n');
}
