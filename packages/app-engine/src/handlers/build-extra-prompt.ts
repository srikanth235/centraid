/*
 * Build the app-context system prompt fragment the app-engine injects
 * into every chat turn before delegating to the host's `ConversationRunner`.
 *
 * Both adapters splice this verbatim into their own system-prompt mechanism:
 *   - OpenClaw runner → `extraSystemPrompt` on `runEmbeddedAgent`
 *   - codex/claude-code adapters → CLI system-prompt flag
 *
 * Lives in app-engine so all hosts see identical app context. The runner
 * never assembles app-specific content itself.
 *
 * One prompt, one shape. The agent's surface is the three structured
 * tools (`centraid_describe` / `centraid_read` / `centraid_write`); the
 * prompt lists the app's declared actions and queries up-front, and
 * names the `_sql` built-in as an escape hatch when no declared handler
 * fits the user's ask.
 */

import type { AppSchema } from '../data/schema.js';
import type { Manifest, ManifestActionEntry, ManifestQueryEntry } from '../registry/manifest.js';

export interface BuildExtraPromptInput {
  appId: string;
  appName?: string;
  appDescription?: string;
  schema: AppSchema;
  /**
   * The app's manifest. When omitted, the prompt still works — the
   * declared-handlers section just renders as "(none)" and the agent
   * is steered toward `_sql`. Hosts that have a manifest in hand
   * should pass it so the catalog is part of the system prompt.
   */
  manifest?: Manifest;
}

export function buildExtraPrompt(input: BuildExtraPromptInput): string {
  const name = input.appName ?? input.appId;
  const lines: string[] = [
    `## Centraid app context`,
    ``,
    `You are working inside the centraid app "${name}" (id: \`${input.appId}\`).`,
  ];
  if (input.appDescription) {
    lines.push('', input.appDescription);
  }
  lines.push(
    '',
    `### Tools`,
    ``,
    `You have three structured tools — they are pre-scoped to "${input.appId}", you cannot reach into another app:`,
    ``,
    `- \`centraid_describe({ app, action?, query? })\` — manifest + live schema for the app, or a single handler entry.`,
    `- \`centraid_read({ app, query, input })\` — invoke a declared query, or the \`_sql\` built-in for a SELECT.`,
    `- \`centraid_write({ app, action, input })\` — invoke a declared action, or the \`_sql\` built-in for a row-level write.`,
    ``,
    `### How to choose`,
    ``,
    `Prefer the app's declared actions and queries — they encode the UX the app author designed. Match the user's utterance to one of the catalog entries below and call it through \`centraid_read\` / \`centraid_write\` with input matching its JSON Schema.`,
    ``,
    `Reach for the \`_sql\` built-in only when no declared handler fits the user's ask. \`_sql\` accepts a single SQL statement under \`{ sql }\`:`,
    `- via \`centraid_read\` → SELECT or EXPLAIN only (rows capped at 200; use LIMIT for fewer).`,
    `- via \`centraid_write\` → one INSERT / UPDATE / DELETE / REPLACE.`,
    `- DDL (CREATE / ALTER / DROP), PRAGMA, ATTACH/DETACH, and VACUUM are refused. If the user needs a schema change, explain the limit and suggest the app author add a migration.`,
    ``,
    renderCatalogBlock(input.manifest),
    ``,
    renderSchemaBlock(input.schema),
  );
  const vaultBlock = renderVaultBlock(input.manifest);
  if (vaultBlock) lines.push('', vaultBlock);
  return lines.join('\n');
}

/**
 * Personal-vault section (duaility §12) — rendered only when the manifest
 * declares a `vault` block. Documents the `ctx.vault` primitive every
 * handler receives, so generated handler code reaches the canon through
 * typed, consent-checked calls instead of inventing its own storage.
 */
function renderVaultBlock(manifest: Manifest | undefined): string {
  const vault = manifest?.vault;
  if (!vault) return '';
  const scopes = vault.scopes
    .map((s) => `\`${s.schema}${s.table ? `.${s.table}` : '.*'}\` (${s.verbs})`)
    .join(', ');
  return [
    `### Personal vault`,
    ``,
    `This app declares access to the owner's personal vault — purpose \`${vault.purpose}\`, requested scopes: ${scopes}.${vault.why ? ` Rationale: ${vault.why}` : ''}`,
    ``,
    `Handlers reach the vault through \`ctx.vault\` (available in every action/query handler beside \`db\`):`,
    ``,
    `- \`await ctx.vault.read({ entity, where?, limit?, purpose })\` — consent-checked read of a canonical entity (e.g. \`core.event\`, \`social.contact_card\`). Returns \`{ rows, receiptId }\`.`,
    `- \`await ctx.vault.invoke({ command, input, purpose })\` — typed command (e.g. \`schedule.propose_event\`). Returns an outcome: \`{ status: 'executed' | 'denied' | 'parked' | 'failed', output?, … }\` — check \`status\` before assuming the write landed; \`parked\` means the owner must confirm.`,
    `- \`await ctx.vault.describe()\` — the commands this app can discover (name, schema, risk).`,
    ``,
    `Every call is consent-checked host-side and receipted. A denial throws with the receipt id in the message — do not retry in a loop; surface the denial. Until the owner approves the requested scopes, calls fail closed. Keep the app's own \`data.sqlite\` for private state; the vault is only for the owner's canonical data.`,
  ].join('\n');
}

function renderCatalogBlock(manifest: Manifest | undefined): string {
  if (!manifest) {
    return [
      `### Declared handlers`,
      ``,
      `(manifest unavailable — only \`_sql\` is reachable)`,
    ].join('\n');
  }
  const lines: string[] = [`### Declared handlers`, ``];
  if (manifest.actions.length === 0 && manifest.queries.length === 0) {
    lines.push(`(no declared actions or queries — only \`_sql\` is reachable for this app)`);
    return lines.join('\n');
  }
  if (manifest.actions.length > 0) {
    lines.push(`Actions (call via \`centraid_write\`):`);
    for (const a of manifest.actions) lines.push(renderHandlerLine(a));
    lines.push('');
  }
  if (manifest.queries.length > 0) {
    lines.push(`Queries (call via \`centraid_read\`):`);
    for (const q of manifest.queries) lines.push(renderHandlerLine(q));
  }
  return lines.join('\n');
}

function renderHandlerLine(entry: ManifestActionEntry | ManifestQueryEntry): string {
  const desc = entry.description ? ` — ${entry.description}` : '';
  const schema = compactSchema(entry.input);
  return `- \`${entry.name}\`${desc}${schema ? `\n  input: ${schema}` : ''}`;
}

function compactSchema(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return '';
  try {
    return JSON.stringify(schema);
  } catch {
    return '';
  }
}

function renderSchemaBlock(schema: AppSchema): string {
  if (schema.tables.length === 0 && schema.views.length === 0) {
    return [`### Live schema`, ``, `(no tables yet — the app has not run any migrations)`].join(
      '\n',
    );
  }
  const lines: string[] = [`### Live schema`, ``];
  for (const t of schema.tables) {
    const cols = t.columns
      .map((c) => `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.pk ? ' PK' : ''}`)
      .join(', ');
    lines.push(`- **${t.name}** (${cols})`);
  }
  if (schema.views.length > 0) {
    lines.push('');
    lines.push('Views:');
    for (const v of schema.views) lines.push(`- ${v.name}`);
  }
  return lines.join('\n');
}
