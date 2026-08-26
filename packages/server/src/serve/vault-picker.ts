/*
 * Shell entity picker (duaility §12, #272): OWNER-trust search/browse;
 * every read rides the receipted gateway — no new door.
 */

import type { RuntimeLogger } from "@centraid/server/engine";
import { CARD_PK, CARDED_ENTITIES, SEARCHABLE } from "@centraid/vault";
import type {
  Credential,
  Gateway as VaultGateway,
  RefCard,
} from "@centraid/vault";

import {
  AUTOMATION_ANCHOR_ENTITY,
  AUTOMATION_ANCHOR_PURPOSE,
  resolveAutomationAnchors,
} from "../lifecycle/automation-anchor-scopes.js";

export interface PickerRequest {
  term?: string;
  /** Default = every carded entity. */
  kinds?: string[];
  limit?: number;
}

export interface PickerHit extends RefCard {
  snippet?: string;
}

export interface AnchorPickerHit {
  type: typeof AUTOMATION_ANCHOR_ENTITY;
  id: string;
  status: "live";
  title: string;
  subtitle: string;
  thumbnail_content_id: null;
  sourceType: string;
  sourceId: string;
  sourceField: string;
}

const ANCHOR_SCAN_LIMIT = 500;

function anchorQuote(selectorJson: unknown): string {
  if (typeof selectorJson !== "string") return "";
  try {
    const parsed = JSON.parse(selectorJson) as { exact?: unknown };
    return typeof parsed.exact === "string" ? parsed.exact : "";
  } catch {
    // Malformed selectors cannot match a term.
    return "";
  }
}

export function pickAnchors(
  gateway: VaultGateway,
  cred: Credential,
  logger: RuntimeLogger,
  request: Pick<PickerRequest, "term" | "limit">
): { anchors: AnchorPickerHit[] } {
  const term = request.term?.trim().toLowerCase() ?? "";
  const limit = Math.min(Math.max(request.limit ?? 8, 1), 25);
  // Receipted owner read — a raw `db.vault` JOIN would be a second, unaudited read path (#541 review).
  const rows = gateway.read(cred, {
    entity: AUTOMATION_ANCHOR_ENTITY,
    orderBy: { column: "created_at", dir: "desc" },
    limit: ANCHOR_SCAN_LIMIT,
    purpose: AUTOMATION_ANCHOR_PURPOSE,
  }).rows;
  const anchors: AnchorPickerHit[] = [];
  for (const row of rows) {
    if (anchors.length >= limit) break;
    if (
      term !== "" &&
      !anchorQuote(row.selector_json).toLowerCase().includes(term)
    )
      continue;
    try {
      const resolved = resolveAutomationAnchors(
        { gateway, credential: cred },
        `@[${AUTOMATION_ANCHOR_ENTITY}/${String(row.anchor_id)}]`
      )[0];
      if (!resolved) continue;
      anchors.push({
        type: AUTOMATION_ANCHOR_ENTITY,
        id: resolved.anchorId,
        status: "live",
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
        }`
      );
    }
  }
  return { anchors };
}

/** Owner search/browse; one unreadable kind is logged and skipped, never sinking the picker. */
export function pickEntities(
  gateway: VaultGateway,
  cred: Credential,
  logger: RuntimeLogger,
  request: PickerRequest
): { cards: PickerHit[] } {
  const kinds = (
    request.kinds && request.kinds.length > 0
      ? request.kinds
      : [...CARDED_ENTITIES]
  ).filter((k) => CARDED_ENTITIES.includes(k));
  const perKind = Math.min(Math.max(request.limit ?? 8, 1), 25);
  const purpose = "dpv:ServiceProvision";
  const term = request.term?.trim() ?? "";
  const refs: { type: string; id: string; snippet?: string }[] = [];
  for (const kind of kinds) {
    try {
      if (term === "") {
        const pk = CARD_PK[kind];
        if (!pk) continue;
        const result = gateway.read(cred, {
          entity: kind,
          orderBy: { column: pk, dir: "desc" },
          limit: perKind,
          purpose,
        });
        for (const row of result.rows)
          refs.push({ type: kind, id: String(row[pk]) });
      } else {
        const searchable = SEARCHABLE[kind];
        if (!searchable) continue; // a term can only match text-indexed kinds
        const result = gateway.search(cred, {
          entity: kind,
          query: term,
          limit: perKind,
          purpose,
        });
        for (const row of result.rows) {
          refs.push({
            type: kind,
            id: String(row[searchable.idColumn]),
            ...(typeof row._snippet === "string"
              ? { snippet: row._snippet }
              : {}),
          });
        }
      }
    } catch (error) {
      logger.warn(
        `vault plane: picker skipped ${kind}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const bounded = refs.slice(0, 100); // resolveRefs' own cap
  if (bounded.length === 0) return { cards: [] };
  const resolved = gateway.resolveRefs(cred, {
    refs: bounded.map(({ type, id }) => ({ type, id })),
    purpose,
  });
  const snippets = new Map(
    bounded.map((r) => [`${r.type}/${r.id}`, r.snippet])
  );
  const cards = resolved.cards
    .filter((c) => c.status === "live")
    .map((c) => {
      const snippet = snippets.get(`${c.type}/${c.id}`);
      return snippet ? { ...c, snippet } : c;
    });
  return { cards };
}

/** Endpoints of a link the owner asserts through the picker's write half. */
export interface LinkInput {
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  relation?: string;
  /** Written atomically with the link (#282). */
  selector?: AnchorSelector;
}

/** Standoff-anchor selector (#282): W3C-style text quote plus position hint (UTF-16 code units). */
export interface AnchorSelector {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
}
