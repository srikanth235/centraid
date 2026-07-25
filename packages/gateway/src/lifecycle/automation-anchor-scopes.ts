/*
 * Anchor resolution for automation instructions (issue #541).
 *
 * Every read here goes through the vault's consent gateway with the OWNER
 * credential, a declared purpose, and therefore a receipt — the same door
 * `vault-picker.ts` drives. Reading `core_link_anchor` / the physical source
 * table / `core_content_item` straight off the `VaultDb` handle would open a
 * second, unreceipted read path around consent policy (minimization included),
 * which is exactly what the gateway exists to prevent.
 */

import {
  CARD_PK,
  SEARCHABLE,
  type Credential,
  type FilterClause,
  type Gateway as VaultGateway,
  type ScopeSpec,
} from '@centraid/vault';

export const AUTOMATION_ANCHOR_ENTITY = 'core.link_anchor';
/** DPV purpose every anchor read is receipted under. */
export const AUTOMATION_ANCHOR_PURPOSE = 'dpv:ServiceProvision';

/** The consent-gateway door anchor resolution reads through. */
export interface AnchorVaultReads {
  gateway: VaultGateway;
  credential: Credential;
}

function readRows(
  vault: AnchorVaultReads,
  entity: string,
  where: FilterClause[],
  limit?: number,
): Record<string, unknown>[] {
  return vault.gateway.read(vault.credential, {
    entity,
    where,
    ...(limit !== undefined ? { limit } : {}),
    purpose: AUTOMATION_ANCHOR_PURPOSE,
  }).rows;
}

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
      fieldsById: Map<string, Set<string>>;
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
      fieldsById: new Map<string, Set<string>>(),
    };
    if (group.idColumn !== idColumn) {
      throw new AutomationAnchorError(`anchors for ${key} disagree on their row key`);
    }
    group.ids.add(anchor.sourceId);
    const rowFields = group.fieldsById.get(anchor.sourceId) ?? new Set<string>();
    for (const field of fieldMask) {
      group.fields.add(field);
      if (field !== idColumn) rowFields.add(field);
    }
    group.fieldsById.set(anchor.sourceId, rowFields);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const ids = [...group.ids];
    const valueFields = [...group.fields].filter((field) => field !== group.idColumn);
    // The current vault scope algebra applies one field mask to every row in
    // a filter. A non-rectangular set such as row A/title + row B/description
    // cannot be represented without exposing the two cross-pairs, so reject
    // it instead of silently broadening consent.
    for (const id of ids) {
      const rowFields = group.fieldsById.get(id) ?? new Set<string>();
      if (valueFields.some((field) => !rowFields.has(field))) {
        throw new AutomationAnchorError(
          `anchors for ${group.schema}.${group.table} cannot be combined without widening row/field access`,
        );
      }
    }
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

function textForField(vault: AnchorVaultReads, field: string, value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!field.endsWith('_content_id')) return value;
  const content = readRows(
    vault,
    'core.content_item',
    [{ column: 'content_id', op: 'eq', value }],
    1,
  )[0];
  return content ? decodeTextDataUri(content.media_type, content.content_uri) : undefined;
}

function selectorMatches(text: string, selector: AutomationAnchorSelector): boolean {
  const at = selector.start;
  if (text.slice(at, at + selector.exact.length) !== selector.exact) return false;
  const prefixStart = Math.max(0, at - selector.prefix.length);
  const prefix = text.slice(prefixStart, at);
  const suffix = text.slice(
    at + selector.exact.length,
    at + selector.exact.length + selector.suffix.length,
  );
  return (
    (selector.prefix === '' || prefix.endsWith(selector.prefix)) &&
    (selector.suffix === '' || suffix.startsWith(selector.suffix))
  );
}

function sourceFieldFor(
  vault: AnchorVaultReads,
  sourceType: string,
  sourceId: string,
  selector: AutomationAnchorSelector,
): { idColumn: string; field: string } {
  // Own-property lookups only: a `sourceType` of `constructor`/`toString`
  // would otherwise reach an inherited `Object` member, pass the guard below,
  // and blow up as a `TypeError` when spread instead of raising an
  // `AutomationAnchorError`.
  const searchable = Object.hasOwn(SEARCHABLE, sourceType) ? SEARCHABLE[sourceType] : undefined;
  const idColumn =
    searchable?.idColumn ?? (Object.hasOwn(CARD_PK, sourceType) ? CARD_PK[sourceType] : undefined);
  if (!searchable || !idColumn) {
    throw new AutomationAnchorError(
      `anchor source ${sourceType}/${sourceId} has no anchor-grade text surface`,
    );
  }
  const row = readRows(vault, sourceType, [{ column: idColumn, op: 'eq', value: sourceId }], 1)[0];
  if (!row) {
    throw new AutomationAnchorError(`anchor source ${sourceType}/${sourceId} no longer exists`);
  }
  const matches = searchable.maskColumns.filter((field) => {
    const text = textForField(vault, field, row[field]);
    return text !== undefined && selectorMatches(text, selector);
  });
  if (matches.length !== 1) {
    throw new AutomationAnchorError(
      matches.length === 0
        ? `anchor ${sourceType}/${sourceId} no longer matches its source text`
        : `anchor ${sourceType}/${sourceId} matches more than one source field`,
    );
  }
  const field = matches[0]!;
  return { idColumn, field };
}

/**
 * The anchor row plus its still-live link, read through the consent gateway
 * as two receipted reads (the gateway's `read` is single-entity, so the old
 * hand-written JOIN becomes an anchor read + a link read).
 */
function liveAnchorRows(
  vault: AnchorVaultReads,
  anchorIds: readonly string[],
): Map<string, { linkId: string; selectorJson: string; link: Record<string, unknown> }> {
  const out = new Map<
    string,
    { linkId: string; selectorJson: string; link: Record<string, unknown> }
  >();
  if (anchorIds.length === 0) return out;
  const anchors = readRows(vault, AUTOMATION_ANCHOR_ENTITY, [
    { column: 'anchor_id', op: 'in', value: [...anchorIds] },
  ]);
  const linkIds = [...new Set(anchors.map((row) => String(row.link_id)))];
  if (linkIds.length === 0) return out;
  const links = new Map(
    readRows(vault, 'core.link', [
      { column: 'link_id', op: 'in', value: linkIds },
      { column: 'valid_to', op: 'is-null' },
    ]).map((row) => [String(row.link_id), row]),
  );
  for (const row of anchors) {
    const link = links.get(String(row.link_id));
    if (!link || typeof row.selector_json !== 'string') continue;
    out.set(String(row.anchor_id), {
      linkId: String(row.link_id),
      selectorJson: row.selector_json,
      link,
    });
  }
  return out;
}

/** Resolve every anchored @ token against live core_link rows in the addressed vault. */
export function resolveAutomationAnchors(
  vault: AnchorVaultReads,
  instructions: string,
): ResolvedAutomationAnchor[] {
  const ids = [
    ...new Set(Array.from(instructions.matchAll(ANCHOR_TOKEN_RE), (match) => match[1]!)),
  ];
  const live = liveAnchorRows(vault, ids);
  return ids.map((anchorId) => {
    const found = live.get(anchorId);
    if (!found) throw new AutomationAnchorError(`anchor ${anchorId} is missing or no longer live`);
    const row = {
      link_id: found.linkId,
      from_type: String(found.link.from_type),
      from_id: String(found.link.from_id),
      to_type: String(found.link.to_type),
      to_id: String(found.link.to_id),
    };
    const selector = parseSelector(found.selectorJson, anchorId);
    const { idColumn, field } = sourceFieldFor(vault, row.from_type, row.from_id, selector);
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
