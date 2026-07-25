import { CARD_PK, SEARCHABLE, type ScopeSpec, type VaultDb } from '@centraid/vault';

export const AUTOMATION_ANCHOR_ENTITY = 'core.link_anchor';
const ANCHOR_TOKEN_RE = /@\[core\.link_anchor\/([^\]]+)\]/g;

export interface AutomationAnchorSelector {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
}

/** Trusted anchor facts resolved from the addressed vault, never token text. */
export interface ResolvedAutomationAnchor {
  token: string;
  anchorId: string;
  linkId: string;
  sourceType: string;
  sourceId: string;
  sourceField: string;
  targetType: string;
  targetId: string;
  selector: AutomationAnchorSelector;
  scope: ScopeSpec;
}

export class AutomationAnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationAnchorError';
  }
}

/**
 * Collapse same-table anchors into one consent scope. Vault row filters are
 * AND clauses, so separate same-table scopes would make evaluation pick only
 * the first row; one `in` filter expresses the intended bounded union.
 */
export function scopesForAutomationAnchors(
  anchors: readonly ResolvedAutomationAnchor[],
): ScopeSpec[] {
  const groups = new Map<
    string,
    {
      schema: string;
      table: string;
      idColumn: string;
      ids: Set<string>;
      fields: Set<string>;
    }
  >();
  for (const anchor of anchors) {
    const { schema, table, rowFilter, fieldMask } = anchor.scope;
    const idColumn = rowFilter?.[0]?.column;
    if (!table || !idColumn || !fieldMask) {
      throw new AutomationAnchorError(`anchor ${anchor.anchorId} did not derive a narrow scope`);
    }
    const key = `${schema}.${table}`;
    const group = groups.get(key) ?? {
      schema,
      table,
      idColumn,
      ids: new Set<string>(),
      fields: new Set<string>(),
    };
    if (group.idColumn !== idColumn) {
      throw new AutomationAnchorError(`anchors for ${key} disagree on their row key`);
    }
    group.ids.add(anchor.sourceId);
    for (const field of fieldMask) group.fields.add(field);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const ids = [...group.ids];
    return {
      schema: group.schema,
      table: group.table,
      verbs: 'read',
      rowFilter: [
        ids.length === 1
          ? { column: group.idColumn, op: 'eq', value: ids[0] }
          : { column: group.idColumn, op: 'in', value: ids },
      ],
      fieldMask: [...group.fields],
    };
  });
}

function parseSelector(raw: string, anchorId: string): AutomationAnchorSelector {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AutomationAnchorError(`anchor ${anchorId} has an invalid selector`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AutomationAnchorError(`anchor ${anchorId} has an invalid selector`);
  }
  const selector = parsed as Record<string, unknown>;
  if (
    typeof selector.exact !== 'string' ||
    selector.exact === '' ||
    typeof selector.prefix !== 'string' ||
    typeof selector.suffix !== 'string' ||
    typeof selector.start !== 'number' ||
    !Number.isInteger(selector.start) ||
    selector.start < 0
  ) {
    throw new AutomationAnchorError(`anchor ${anchorId} has an invalid selector`);
  }
  return {
    exact: selector.exact,
    prefix: selector.prefix,
    suffix: selector.suffix,
    start: selector.start,
  };
}

function decodeTextDataUri(mediaType: unknown, uri: unknown): string | undefined {
  if (typeof mediaType !== 'string' || !mediaType.startsWith('text/')) return undefined;
  if (typeof uri !== 'string' || !uri.startsWith('data:')) return undefined;
  const comma = uri.indexOf(',');
  if (comma < 0) return undefined;
  const meta = uri.slice(0, comma);
  const payload = uri.slice(comma + 1);
  try {
    return meta.includes(';base64')
      ? Buffer.from(payload, 'base64').toString('utf8')
      : decodeURIComponent(payload);
  } catch {
    return undefined;
  }
}

function textForField(db: VaultDb, field: string, value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!field.endsWith('_content_id')) return value;
  const content = db.vault
    .prepare('SELECT media_type, content_uri FROM core_content_item WHERE content_id = ?')
    .get(value) as { media_type: string; content_uri: string } | undefined;
  return content ? decodeTextDataUri(content.media_type, content.content_uri) : undefined;
}

function selectorScore(text: string, selector: AutomationAnchorSelector): number | undefined {
  let at = text.indexOf(selector.exact);
  let best: number | undefined;
  while (at >= 0) {
    const prefixStart = Math.max(0, at - selector.prefix.length);
    const prefix = text.slice(prefixStart, at);
    const suffix = text.slice(
      at + selector.exact.length,
      at + selector.exact.length + selector.suffix.length,
    );
    const contextPenalty =
      (selector.prefix !== '' && !prefix.endsWith(selector.prefix) ? 1_000_000 : 0) +
      (selector.suffix !== '' && !suffix.startsWith(selector.suffix) ? 1_000_000 : 0);
    const score = contextPenalty + Math.abs(at - selector.start);
    best = best === undefined ? score : Math.min(best, score);
    at = text.indexOf(selector.exact, at + 1);
  }
  return best;
}

function sourceFieldFor(
  db: VaultDb,
  sourceType: string,
  sourceId: string,
  selector: AutomationAnchorSelector,
): { idColumn: string; field: string } {
  const searchable = SEARCHABLE[sourceType];
  const idColumn = searchable?.idColumn ?? CARD_PK[sourceType];
  if (!searchable || !idColumn) {
    throw new AutomationAnchorError(
      `anchor source ${sourceType}/${sourceId} has no anchor-grade text surface`,
    );
  }
  const physical = sourceType.replace('.', '_');
  const columns = [idColumn, ...searchable.maskColumns];
  if (
    !/^[a-z][a-z0-9_]*$/.test(physical) ||
    columns.some((column) => !/^[a-z][a-z0-9_]*$/.test(column))
  ) {
    throw new AutomationAnchorError(`anchor source ${sourceType}/${sourceId} is not addressable`);
  }
  const selected = columns.map((column) => `"${column}"`).join(', ');
  const row = db.vault
    .prepare(`SELECT ${selected} FROM "${physical}" WHERE "${idColumn}" = ?`)
    .get(sourceId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new AutomationAnchorError(`anchor source ${sourceType}/${sourceId} no longer exists`);
  }
  const matches = searchable.maskColumns.flatMap((field) => {
    const text = textForField(db, field, row[field]);
    if (text === undefined) return [];
    const score = selectorScore(text, selector);
    return score === undefined ? [] : [{ field, score }];
  });
  matches.sort((left, right) => left.score - right.score || left.field.localeCompare(right.field));
  const field = matches[0]?.field;
  if (!field) {
    throw new AutomationAnchorError(
      `anchor ${sourceType}/${sourceId} no longer matches its source text`,
    );
  }
  return { idColumn, field };
}

/** Resolve every anchored @ token against live core_link rows in the addressed vault. */
export function resolveAutomationAnchors(
  db: VaultDb,
  instructions: string,
): ResolvedAutomationAnchor[] {
  const ids = [
    ...new Set(Array.from(instructions.matchAll(ANCHOR_TOKEN_RE), (match) => match[1]!)),
  ];
  return ids.map((anchorId) => {
    const row = db.vault
      .prepare(
        `SELECT a.anchor_id, a.link_id, a.selector_json,
                l.from_type, l.from_id, l.to_type, l.to_id
           FROM core_link_anchor a
           JOIN core_link l ON l.link_id = a.link_id
          WHERE a.anchor_id = ? AND l.valid_to IS NULL`,
      )
      .get(anchorId) as
      | {
          anchor_id: string;
          link_id: string;
          selector_json: string;
          from_type: string;
          from_id: string;
          to_type: string;
          to_id: string;
        }
      | undefined;
    if (!row) throw new AutomationAnchorError(`anchor ${anchorId} is missing or no longer live`);
    const selector = parseSelector(row.selector_json, anchorId);
    const { idColumn, field } = sourceFieldFor(db, row.from_type, row.from_id, selector);
    const split = row.from_type.split('.');
    if (split.length !== 2 || !split[0] || !split[1]) {
      throw new AutomationAnchorError(`anchor ${anchorId} has an invalid source type`);
    }
    return {
      token: `@[${AUTOMATION_ANCHOR_ENTITY}/${anchorId}]`,
      anchorId,
      linkId: row.link_id,
      sourceType: row.from_type,
      sourceId: row.from_id,
      sourceField: field,
      targetType: row.to_type,
      targetId: row.to_id,
      selector,
      scope: {
        schema: split[0],
        table: split[1],
        verbs: 'read',
        rowFilter: [{ column: idColumn, op: 'eq', value: row.from_id }],
        fieldMask: [idColumn, field],
      },
    };
  });
}
