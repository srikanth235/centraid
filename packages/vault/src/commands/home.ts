// Home domain commands (§09): the command pack the Home Inventory
// projection was parked on. An asset item is a thing you own; warranties
// decorate it. Disposal is the schema's own lifecycle (disposed_on), not a
// row delete — what you owned and when you let it go is history worth
// keeping, and receipts/warranties keep pointing at something real.

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';

/** The acting party: the caller's own party, else the vault owner (apps). */
function actorPartyId(ctx: HandlerCtx): string {
  if (ctx.identity.partyId) return ctx.identity.partyId;
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
  return owner.owner_party_id;
}

const ADD_ITEM: CommandDefinition = {
  name: 'home.add_item',
  ownerSchema: 'home',
  inputSchema: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1 },
      acquired_on: { type: 'string' },
      serial_no: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['item_id'],
    properties: { item_id: { type: 'string' } },
  },
  preconditions: [],
  postconditions: [
    {
      name: 'item_created',
      sql: 'SELECT count(*) AS n FROM home_asset_item WHERE item_id = :item_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: addItem,
};

function addItem(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { name: string; acquired_on?: string; serial_no?: string };
  const itemId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO home_asset_item (item_id, owner_party_id, name, category_concept_id, place_id, acquired_txn_id, acquired_on, serial_no, photo_asset_id, disposed_on)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
    )
    .run(itemId, actorPartyId(ctx), input.name, input.acquired_on ?? null, input.serial_no ?? null);
  ctx.wrote('home.asset_item', itemId);
  return { item_id: itemId };
}

const UPDATE_ITEM: CommandDefinition = {
  name: 'home.update_item',
  ownerSchema: 'home',
  inputSchema: {
    type: 'object',
    required: ['item_id'],
    additionalProperties: false,
    properties: {
      item_id: { type: 'string', minLength: 1 },
      name: { type: 'string', minLength: 1 },
      acquired_on: { type: 'string' },
      serial_no: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['item_id'],
    properties: { item_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'item_exists',
      sql: 'SELECT count(*) AS n FROM home_asset_item WHERE item_id = :item_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'edits_applied',
      sql: `SELECT (
              (SELECT CASE WHEN :name IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM home_asset_item WHERE item_id = :item_id AND name = :name) END)
              AND (SELECT CASE WHEN :serial_no IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM home_asset_item WHERE item_id = :item_id AND serial_no = :serial_no) END)
            ) AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: updateItem,
};

function updateItem(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    item_id: string;
    name?: string;
    acquired_on?: string;
    serial_no?: string;
  };
  const sets: string[] = [];
  const values: string[] = [];
  if (input.name !== undefined) {
    sets.push('name = ?');
    values.push(input.name);
  }
  if (input.acquired_on !== undefined) {
    sets.push('acquired_on = ?');
    values.push(input.acquired_on);
  }
  if (input.serial_no !== undefined) {
    sets.push('serial_no = ?');
    values.push(input.serial_no);
  }
  if (sets.length > 0) {
    ctx.db
      .prepare(`UPDATE home_asset_item SET ${sets.join(', ')} WHERE item_id = ?`)
      .run(...values, input.item_id);
  }
  ctx.wrote('home.asset_item', input.item_id);
  return { item_id: input.item_id };
}

const DISPOSE_ITEM: CommandDefinition = {
  name: 'home.dispose_item',
  ownerSchema: 'home',
  inputSchema: {
    type: 'object',
    required: ['item_id'],
    additionalProperties: false,
    properties: {
      item_id: { type: 'string', minLength: 1 },
      disposed_on: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['item_id', 'disposed_on'],
    properties: { item_id: { type: 'string' }, disposed_on: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'item_exists_and_owned',
      sql: 'SELECT count(*) AS n FROM home_asset_item WHERE item_id = :item_id AND disposed_on IS NULL',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'item_disposed',
      sql: 'SELECT count(*) AS n FROM home_asset_item WHERE item_id = :item_id AND disposed_on IS NOT NULL',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: disposeItem,
};

function disposeItem(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { item_id: string; disposed_on?: string };
  const disposedOn = input.disposed_on ?? ctx.now.slice(0, 10);
  ctx.db
    .prepare('UPDATE home_asset_item SET disposed_on = ? WHERE item_id = ?')
    .run(disposedOn, input.item_id);
  ctx.wrote('home.asset_item', input.item_id);
  ctx.cite({
    claim: `item ${input.item_id} disposed on ${disposedOn}; its history stays`,
    entityType: 'home.asset_item',
    entityId: input.item_id,
  });
  return { item_id: input.item_id, disposed_on: disposedOn };
}

const ADD_WARRANTY: CommandDefinition = {
  name: 'home.add_warranty',
  ownerSchema: 'home',
  inputSchema: {
    type: 'object',
    required: ['item_id', 'starts_on', 'ends_on'],
    additionalProperties: false,
    properties: {
      item_id: { type: 'string', minLength: 1 },
      starts_on: { type: 'string', minLength: 1 },
      ends_on: { type: 'string', minLength: 1 },
      provider_party_id: { type: 'string', minLength: 1 },
      claim_uri: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['warranty_id'],
    properties: { warranty_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'item_exists',
      sql: 'SELECT count(*) AS n FROM home_asset_item WHERE item_id = :item_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'ends_not_before_starts',
      sql: 'SELECT (:ends_on >= :starts_on) AS n',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'provider_exists_if_given',
      sql: `SELECT CASE WHEN :provider_party_id IS NULL THEN 1
                 ELSE EXISTS(SELECT 1 FROM core_party WHERE party_id = :provider_party_id)
            END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'warranty_created',
      sql: 'SELECT count(*) AS n FROM home_warranty WHERE warranty_id = :warranty_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: addWarranty,
};

function addWarranty(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    item_id: string;
    starts_on: string;
    ends_on: string;
    provider_party_id?: string;
    claim_uri?: string;
  };
  const warrantyId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO home_warranty (warranty_id, item_id, provider_party_id, starts_on, ends_on, terms_content_id, claim_uri)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      warrantyId,
      input.item_id,
      input.provider_party_id ?? null,
      input.starts_on,
      input.ends_on,
      input.claim_uri ?? null,
    );
  ctx.wrote('home.warranty', warrantyId);
  return { warranty_id: warrantyId };
}

/** Register the home domain's commands on a gateway. */
export function registerHomeCommands(gateway: Gateway): void {
  gateway.registerCommand(ADD_ITEM);
  gateway.registerCommand(UPDATE_ITEM);
  gateway.registerCommand(DISPOSE_ITEM);
  gateway.registerCommand(ADD_WARRANTY);
}
