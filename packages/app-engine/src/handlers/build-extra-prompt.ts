/*
 * Build the app-context system prompt fragment the app-engine injects
 * into chat turns before delegating to the host's `ConversationRunner`.
 *
 * Both adapters splice this verbatim into their own system-prompt mechanism:
 *   - OpenClaw runner → `extraSystemPrompt` on `runEmbeddedAgent`
 *   - codex/claude-code adapters → CLI system-prompt flag
 *
 * Lives in app-engine so all hosts see identical app context. The runner
 * never assembles app-specific content itself.
 *
 * Post-silo (issue #286 phase 2) there is no per-app database to describe:
 * the fragment carries the app's identity, its declared handler catalog
 * (the dispatcher's whole routing surface), and its vault declaration —
 * canonical scopes and/or ext-band tables. Data questions ride the vault
 * register's `vault_sql` / `vault_invoke` tools, which the host wires per
 * turn; they are not described here.
 */

import type {
  Manifest,
  ManifestActionEntry,
  ManifestExtTable,
  ManifestQueryEntry,
} from '../registry/manifest.js';

export interface BuildExtraPromptInput {
  appId: string;
  appName?: string;
  appDescription?: string;
  /**
   * The app's manifest. When omitted, the prompt still works — the
   * declared-handlers section just renders as "(none)". Hosts that have a
   * manifest in hand should pass it so the catalog is part of the prompt.
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
  lines.push('', renderCatalogBlock(input.manifest));
  const vaultBlock = renderVaultBlock(input.appId, input.manifest);
  if (vaultBlock) lines.push('', vaultBlock);
  return lines.join('\n');
}

/**
 * Personal-vault section — the app's whole data story. Documents the
 * `ctx.vault` primitive every handler receives, the declared scopes, and
 * (when the manifest declares an ext band) the app's own extension tables
 * with their typed write commands.
 */
function renderVaultBlock(appId: string, manifest: Manifest | undefined): string {
  const vault = manifest?.vault;
  const ext = manifest?.ext;
  if (!vault && !ext) return '';
  const lines: string[] = [`### Personal vault`, ``];
  if (vault) {
    const scopes = vault.scopes
      .map((s) => `\`${s.schema}${s.table ? `.${s.table}` : '.*'}\` (${s.verbs})`)
      .join(', ');
    lines.push(
      `This app declares access to the owner's personal vault — purpose \`${vault.purpose}\`, requested scopes: ${scopes}.${vault.why ? ` Rationale: ${vault.why}` : ''}`,
      ``,
    );
  }
  lines.push(
    `Handlers reach the vault through \`ctx.vault\` — the ONLY data door (there is no per-app database):`,
    ``,
    `- \`await ctx.vault.read({ entity, where?, limit?, purpose })\` — consent-checked read of an entity (canonical like \`core.event\`, or this app's own \`ext.${appId}.<table>\`). Returns \`{ rows, receiptId }\`.`,
    `- \`await ctx.vault.search({ entity, query, where?, limit?, purpose })\` — full-text search over a text-indexed entity. \`query\` is the owner's typed words (matched as AND-ed prefixes; FTS operators are treated as literals). Returns \`{ rows, receiptId }\` ranked best-first; each row adds \`_snippet\` — the matched fragment with \`⟦\`/\`⟧\` around hits (escape the text FIRST, then turn markers into markup). ALWAYS search this way instead of reading a whole entity and filtering text in JS — vault data has no upper bound.`,
    `- \`await ctx.vault.invoke({ command, input, purpose })\` — typed command (e.g. \`schedule.propose_event\`). Returns an outcome: \`{ status: 'executed' | 'denied' | 'parked' | 'failed', output?, … }\` — check \`status\` before assuming the write landed; \`parked\` means the owner must confirm.`,
    `- \`await ctx.vault.describe()\` — the commands this app can discover (name, schema, risk).`,
    ``,
    `Every call is consent-checked host-side and receipted. A denial throws with the receipt id in the message — do not retry in a loop; surface the denial. Until the owner approves the requested scopes, calls fail closed.`,
  );
  if (ext && ext.tables.length > 0) {
    lines.push(
      ``,
      `#### Extension tables (this app's own band)`,
      ``,
      `The manifest declares extension tables the gateway hosts INSIDE the vault as \`ext_${appId.replaceAll('-', '_')}_<table>\`. Read them via \`ctx.vault.read({ entity: 'ext.${appId}.<table>', … })\`; write them via the typed trio \`ext.${appId}.insert\` / \`ext.${appId}.update\` / \`ext.${appId}.delete\` through \`ctx.vault.invoke\` (insert takes \`{ table, values }\` and returns \`{ id }\`; update takes \`{ table, id, set }\`; delete takes \`{ table, id }\`). Schema changes are DECLARED (edit \`ext.tables\` in app.json — the gateway diffs and applies on publish); never attempt DDL.`,
      ``,
      `Declared tables:`,
      ...ext.tables.map(renderExtTable),
    );
  }
  return lines.join('\n');
}

function renderExtTable(table: ManifestExtTable): string {
  const cols = table.columns
    .map(
      (c) =>
        `${c.name} ${c.type}${c.primaryKey ? ' PK' : ''}${c.notNull ? ' NOT NULL' : ''}${c.references ? ` → ${c.references}` : ''}`,
    )
    .join(', ');
  return `- **${table.name}** (${cols})${table.searchable?.length ? ` — searchable: ${table.searchable.join(', ')}` : ''}`;
}

function renderCatalogBlock(manifest: Manifest | undefined): string {
  if (!manifest) {
    return [`### Declared handlers`, ``, `(manifest unavailable)`].join('\n');
  }
  const lines: string[] = [`### Declared handlers`, ``];
  if (manifest.actions.length === 0 && manifest.queries.length === 0) {
    lines.push(`(no declared actions or queries yet)`);
    return lines.join('\n');
  }
  lines.push(
    `These are the app's dispatchable surface — UI buttons and automations call them; each validates its input against the JSON Schema shown.`,
    ``,
  );
  if (manifest.actions.length > 0) {
    lines.push(`Actions:`);
    for (const a of manifest.actions) lines.push(renderHandlerLine(a));
    lines.push('');
  }
  if (manifest.queries.length > 0) {
    lines.push(`Queries:`);
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
