/*
 * The shell entity picker (duaility §12, issue #272) — the read half of the
 * cross-referencing flow, split out of vault-plane.ts to keep the plane a
 * thin surface.
 *
 * This is an OWNER-trust search/browse over the carded entities, so an app
 * can let the user reference a foreign entity without ever holding browse
 * scopes on that domain: the act of picking is the consent, and the app
 * receives only the picked card. Every underlying read is receipted by the
 * vault gateway like any owner read — the picker adds no new door, it just
 * drives the gateway's own search / read / resolve with the owner credential.
 */

import {
  CARD_PK,
  CARDED_ENTITIES,
  SEARCHABLE,
  type Credential,
  type Gateway as VaultGateway,
  type RefCard,
  type VaultDb,
} from '@centraid/vault';
import type { RuntimeLogger } from '@centraid/app-engine';
import {
  AUTOMATION_ANCHOR_ENTITY,
  resolveAutomationAnchors,
} from '../lifecycle/automation-anchor-scopes.js';

/** What the shell's entity picker asks for. */
export interface PickerRequest {
  /** Owner-typed search words; empty = a recent-first browse per kind. */
  term?: string;
  /** Restrict to these entity kinds; default = every carded entity. */
  kinds?: string[];
  /** Per-kind result cap. */
  limit?: number;
}

/** One pickable entity: its card plus the FTS snippet when a term matched. */
export interface PickerHit extends RefCard {
  snippet?: string;
}

/** A live, text-resolvable core_link_anchor exposed to the owner editor. */
export interface AnchorPickerHit {
  type: typeof AUTOMATION_ANCHOR_ENTITY;
  id: string;
  status: 'live';
  title: string;
  subtitle: string;
  thumbnail_content_id: null;
  sourceType: string;
  sourceId: string;
  sourceField: string;
}

/** Search live anchors by their exact text quote, newest first. */
export function pickAnchors(
  db: VaultDb,
  logger: RuntimeLogger,
  request: Pick<PickerRequest, 'term' | 'limit'>,
): { anchors: AnchorPickerHit[] } {
  const term = request.term?.trim() ?? '';
  const limit = Math.min(Math.max(request.limit ?? 8, 1), 25);
  const rows = db.vault
    .prepare(
      `SELECT a.anchor_id
         FROM core_link_anchor a
         JOIN core_link l ON l.link_id = a.link_id
        WHERE l.valid_to IS NULL
          AND (? = '' OR instr(lower(json_extract(a.selector_json, '$.exact')), lower(?)) > 0)
        ORDER BY a.created_at DESC
        LIMIT ?`,
    )
    .all(term, term, limit) as { anchor_id: string }[];
  const anchors: AnchorPickerHit[] = [];
  for (const row of rows) {
    try {
      const resolved = resolveAutomationAnchors(
        db,
        `@[${AUTOMATION_ANCHOR_ENTITY}/${row.anchor_id}]`,
      )[0];
      if (!resolved) continue;
      anchors.push({
        type: AUTOMATION_ANCHOR_ENTITY,
        id: resolved.anchorId,
        status: 'live',
        title: resolved.selector.exact,
        subtitle: `${resolved.sourceType} · ${resolved.sourceField} · anchored span`,
        thumbnail_content_id: null,
        sourceType: resolved.sourceType,
        sourceId: resolved.sourceId,
        sourceField: resolved.sourceField,
      });
    } catch (error) {
      logger.warn(
        `vault plane: anchor picker skipped ${row.anchor_id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return { anchors };
}

/**
 * Search or browse the carded entities as the owner and return live cards.
 * Term search rides the FTS index where one exists; without a term each kind
 * contributes a recent-first window (UUIDv7 pk order). One unreadable kind is
 * logged and skipped, never sinking the whole picker.
 */
export function pickEntities(
  gateway: VaultGateway,
  cred: Credential,
  logger: RuntimeLogger,
  request: PickerRequest,
): { cards: PickerHit[] } {
  const kinds = (
    request.kinds && request.kinds.length > 0 ? request.kinds : [...CARDED_ENTITIES]
  ).filter((k) => CARDED_ENTITIES.includes(k));
  const perKind = Math.min(Math.max(request.limit ?? 8, 1), 25);
  const purpose = 'dpv:ServiceProvision';
  const term = request.term?.trim() ?? '';
  const refs: { type: string; id: string; snippet?: string }[] = [];
  for (const kind of kinds) {
    try {
      if (term !== '') {
        const searchable = SEARCHABLE[kind];
        if (!searchable) continue; // a term can only match text-indexed kinds
        const result = gateway.search(cred, { entity: kind, query: term, limit: perKind, purpose });
        for (const row of result.rows) {
          refs.push({
            type: kind,
            id: String(row[searchable.idColumn]),
            ...(typeof row._snippet === 'string' ? { snippet: row._snippet } : {}),
          });
        }
      } else {
        const pk = CARD_PK[kind];
        if (!pk) continue;
        const result = gateway.read(cred, {
          entity: kind,
          orderBy: { column: pk, dir: 'desc' },
          limit: perKind,
          purpose,
        });
        for (const row of result.rows) refs.push({ type: kind, id: String(row[pk]) });
      }
    } catch (err) {
      logger.warn(
        `vault plane: picker skipped ${kind}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const bounded = refs.slice(0, 100); // resolveRefs' own cap
  if (bounded.length === 0) return { cards: [] };
  const resolved = gateway.resolveRefs(cred, {
    refs: bounded.map(({ type, id }) => ({ type, id })),
    purpose,
  });
  const snippets = new Map(bounded.map((r) => [`${r.type}/${r.id}`, r.snippet]));
  const cards = resolved.cards
    .filter((c) => c.status === 'live')
    .map((c) => {
      const snippet = snippets.get(`${c.type}/${c.id}`);
      return snippet ? { ...c, snippet } : c;
    });
  return { cards };
}

/** The endpoints of a link the owner asserts through the picker's write half. */
export interface LinkInput {
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  relation?: string;
  /** Optional inline anchor written atomically with the link (issue #282). */
  selector?: AnchorSelector;
}

/**
 * The standoff-anchor selector (issue #282): a W3C-style text quote plus a
 * position hint into the from-endpoint's decoded body (UTF-16 code units).
 */
export interface AnchorSelector {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
}
