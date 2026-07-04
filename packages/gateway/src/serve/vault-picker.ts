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
  type InvokeOutcome,
  type RefCard,
} from '@centraid/vault';
import type { RuntimeLogger } from '@centraid/app-engine';

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
}

/**
 * Assert a link as the owner — the pick already carried the intent, so the
 * shell invokes core.link_entities with the owner-device credential and the
 * app never needs read scopes on the far domain. Relation defaults to
 * `references`.
 */
export function linkAsOwner(
  gateway: VaultGateway,
  cred: Credential,
  input: LinkInput,
): InvokeOutcome {
  return gateway.invoke(cred, {
    command: 'core.link_entities',
    input: {
      from_type: input.from_type,
      from_id: input.from_id,
      to_type: input.to_type,
      to_id: input.to_id,
      relation: input.relation ?? 'references',
    },
    purpose: 'dpv:ServiceProvision',
  });
}

/** End a link as the owner (temporal — the row survives with valid_to set). */
export function unlinkAsOwner(
  gateway: VaultGateway,
  cred: Credential,
  linkId: string,
): InvokeOutcome {
  return gateway.invoke(cred, {
    command: 'core.unlink_entities',
    input: { link_id: linkId },
    purpose: 'dpv:ServiceProvision',
  });
}
