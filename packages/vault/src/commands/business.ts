// governance: allow-repo-hygiene file-size-limit one command pack per domain is the vault contract (registered as a unit, read wholesale); business owns the whole self-employed loop (7 commands with their contracts), so it is large by design.
// Business domain commands (§09): the self-employed loop — client →
// project → tracked time → invoice → payment — with the risk gradient the
// consent plane expects. Enrolling clients, opening projects and logging
// time are routine upkeep (risk low); drafting an invoice mutates money
// state across rows (medium); sending one is the outward commitment to a
// client for a specific amount (high — parks for the owner like
// social.send_message).
//
// Two schema tensions resolved here rather than papered over:
//  - business_invoice.issued_on is NOT NULL with no default, which doesn't
//    cleanly fit draft-then-send. v1 stamps issued_on at draft creation;
//    revisit as a migration only if the loose semantics bite.
//  - business_invoice_line.qty_scaled carries no paired scale column (unlike
//    finance_fx_rate). Convention fixed here: qty_scaled is HOURS × 100
//    (hundredths of an hour), so amount_minor = qty_scaled × unit_price_minor / 100.
//
// mark_invoice_paid links an EXISTING core_transaction: no command anywhere
// synthesizes ledger rows (which account? no seeded one exists), and
// inventing one is a cross-domain modeling decision, not a command's. A
// user who doesn't track deposits can't close the loop yet — that limit is
// surfaced in the Studio app's copy, not hidden.

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

const ADD_CLIENT: CommandDefinition = {
  name: 'business.add_client',
  ownerSchema: 'business',
  inputSchema: {
    type: 'object',
    required: ['party_id', 'currency'],
    additionalProperties: false,
    properties: {
      party_id: { type: 'string', minLength: 1 },
      currency: { type: 'string', minLength: 3, maxLength: 3 },
      status: { type: 'string', enum: ['lead', 'active', 'past'] },
      default_rate_minor: { type: 'integer', minimum: 0 },
      payment_terms_days: { type: 'integer', minimum: 0 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['client_id'],
    properties: { client_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'party_exists',
      sql: 'SELECT count(*) AS n FROM core_party WHERE party_id = :party_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // One client per party — the identity anchor stays singular.
      name: 'party_not_already_a_client',
      sql: 'SELECT count(*) AS n FROM business_client WHERE party_id = :party_id',
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [
    {
      name: 'client_created',
      sql: 'SELECT count(*) AS n FROM business_client WHERE client_id = :client_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: addClient,
};

function addClient(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    party_id: string;
    currency: string;
    status?: string;
    default_rate_minor?: number;
    payment_terms_days?: number;
  };
  const clientId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO business_client (client_id, party_id, status, default_rate_minor, currency, payment_terms_days)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      clientId,
      input.party_id,
      input.status ?? 'active',
      input.default_rate_minor ?? null,
      input.currency,
      input.payment_terms_days ?? 30,
    );
  ctx.wrote('business.client', clientId);
  return { client_id: clientId };
}

const UPDATE_CLIENT: CommandDefinition = {
  name: 'business.update_client',
  ownerSchema: 'business',
  inputSchema: {
    type: 'object',
    required: ['client_id'],
    additionalProperties: false,
    properties: {
      client_id: { type: 'string', minLength: 1 },
      // The lead → active → past lifecycle IS the pipeline in v1: a prospect
      // (lead), won work (active), and closed/lost relationships (past).
      status: { type: 'string', enum: ['lead', 'active', 'past'] },
      default_rate_minor: { type: 'integer', minimum: 0 },
      payment_terms_days: { type: 'integer', minimum: 0 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['client_id'],
    properties: { client_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'client_exists',
      sql: 'SELECT count(*) AS n FROM business_client WHERE client_id = :client_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // Each field either wasn't asked for, or reads back exactly as sent.
      name: 'edits_applied',
      sql: `SELECT (
              (SELECT CASE WHEN :status IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM business_client WHERE client_id = :client_id AND status = :status) END)
              AND (SELECT CASE WHEN :default_rate_minor IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM business_client WHERE client_id = :client_id AND default_rate_minor = :default_rate_minor) END)
            ) AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: updateClient,
};

function updateClient(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    client_id: string;
    status?: string;
    default_rate_minor?: number;
    payment_terms_days?: number;
  };
  const sets: string[] = [];
  const values: (string | number)[] = [];
  if (input.status !== undefined) {
    sets.push('status = ?');
    values.push(input.status);
  }
  if (input.default_rate_minor !== undefined) {
    sets.push('default_rate_minor = ?');
    values.push(input.default_rate_minor);
  }
  if (input.payment_terms_days !== undefined) {
    sets.push('payment_terms_days = ?');
    values.push(input.payment_terms_days);
  }
  if (sets.length > 0) {
    ctx.db
      .prepare(`UPDATE business_client SET ${sets.join(', ')} WHERE client_id = ?`)
      .run(...values, input.client_id);
  }
  ctx.wrote('business.client', input.client_id);
  ctx.cite({
    claim: `client ${input.client_id} updated${input.status ? ` → ${input.status}` : ''}`,
    entityType: 'business.client',
    entityId: input.client_id,
  });
  return { client_id: input.client_id };
}

const ADD_PROJECT: CommandDefinition = {
  name: 'business.add_project',
  ownerSchema: 'business',
  inputSchema: {
    type: 'object',
    required: ['client_id', 'name'],
    additionalProperties: false,
    properties: {
      client_id: { type: 'string', minLength: 1 },
      name: { type: 'string', minLength: 1 },
      status: { type: 'string', enum: ['proposed', 'active'] },
      starts_on: { type: 'string', minLength: 1 },
      budget_minor: { type: 'integer', minimum: 0 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['project_id'],
    properties: { project_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'client_exists',
      sql: 'SELECT count(*) AS n FROM business_client WHERE client_id = :client_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // A receipted refusal beats a UNIQUE-constraint throw.
      name: 'project_name_unused_for_client',
      sql: `SELECT count(*) AS n FROM business_project
             WHERE client_id = :client_id AND name = :name`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [
    {
      name: 'project_created',
      sql: 'SELECT count(*) AS n FROM business_project WHERE project_id = :project_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: addProject,
};

function addProject(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    client_id: string;
    name: string;
    status?: string;
    starts_on?: string;
    budget_minor?: number;
  };
  const projectId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO business_project (project_id, client_id, name, status, starts_on, ends_on, budget_minor)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      projectId,
      input.client_id,
      input.name,
      input.status ?? 'active',
      input.starts_on ?? null,
      input.budget_minor ?? null,
    );
  ctx.wrote('business.project', projectId);
  return { project_id: projectId };
}

const LOG_TIME: CommandDefinition = {
  name: 'business.log_time',
  ownerSchema: 'business',
  inputSchema: {
    type: 'object',
    required: ['project_id', 'started_at', 'ended_at'],
    additionalProperties: false,
    properties: {
      project_id: { type: 'string', minLength: 1 },
      started_at: { type: 'string', minLength: 1 },
      ended_at: { type: 'string', minLength: 1 },
      billable: { type: 'integer', minimum: 0, maximum: 1 },
      rate_minor: { type: 'integer', minimum: 0 },
      note: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['entry_id', 'activity_id'],
    properties: { entry_id: { type: 'string' }, activity_id: { type: 'string' } },
  },
  preconditions: [
    {
      // Logging time against a proposed/done/cancelled project is a
      // business-rule violation, not just a missing row.
      name: 'project_exists_and_active',
      sql: `SELECT count(*) AS n FROM business_project
             WHERE project_id = :project_id AND status = 'active'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'interval_is_positive',
      sql: 'SELECT (:ended_at > :started_at) AS n',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // The entry and its canonical activity land together, unbilled.
      name: 'entry_backed_by_activity',
      sql: `SELECT count(*) AS n FROM business_time_entry e
             JOIN core_activity a ON a.activity_id = e.activity_id
            WHERE e.entry_id = :entry_id AND e.invoice_line_id IS NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: logTime,
};

function logTime(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    project_id: string;
    started_at: string;
    ended_at: string;
    billable?: number;
    rate_minor?: number;
    note?: string;
  };
  const workKind = ctx.db
    .prepare(`SELECT concept_id FROM core_concept WHERE notation = 'work'`)
    .get() as { concept_id: string } | undefined;
  if (!workKind) throw new Error("seed concept 'work' missing from vocabulary");
  const activityId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_activity (activity_id, actor_party_id, kind_concept_id, started_at, ended_at, location_place_id, source_app_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      activityId,
      actorPartyId(ctx),
      workKind.concept_id,
      input.started_at,
      input.ended_at,
      ctx.identity.kind === 'app' ? ctx.identity.callerId : null,
      input.note ?? null,
      ctx.now,
    );
  ctx.wrote('core.activity', activityId);
  // Rate defaults from the client so an entry is billable the moment it
  // lands, not after a back-fill pass.
  const entryId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO business_time_entry (entry_id, activity_id, project_id, billable, rate_minor, invoice_line_id)
       VALUES (?, ?, ?, ?,
               COALESCE(?, (SELECT c.default_rate_minor FROM business_client c
                             JOIN business_project p ON p.client_id = c.client_id
                            WHERE p.project_id = ?)),
               NULL)`,
    )
    .run(
      entryId,
      activityId,
      input.project_id,
      input.billable ?? 1,
      input.rate_minor ?? null,
      input.project_id,
    );
  ctx.wrote('business.time_entry', entryId);
  return { entry_id: entryId, activity_id: activityId };
}

const CREATE_DRAFT_INVOICE: CommandDefinition = {
  name: 'business.create_draft_invoice',
  ownerSchema: 'business',
  inputSchema: {
    type: 'object',
    required: ['client_id', 'entry_ids', 'due_on'],
    additionalProperties: false,
    properties: {
      client_id: { type: 'string', minLength: 1 },
      entry_ids: { type: 'array', items: { type: 'string', minLength: 1 } },
      due_on: { type: 'string', minLength: 1 },
      number: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['invoice_id', 'number', 'total_minor', 'line_count'],
    properties: {
      invoice_id: { type: 'string' },
      number: { type: 'string' },
      total_minor: { type: 'integer' },
      line_count: { type: 'integer' },
    },
  },
  preconditions: [
    {
      name: 'client_exists',
      sql: 'SELECT count(*) AS n FROM business_client WHERE client_id = :client_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'number_unused_if_given',
      sql: `SELECT CASE WHEN :number IS NULL THEN 0
                 ELSE (SELECT count(*) FROM business_invoice WHERE number = :number)
            END AS n`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [
    {
      // Draft exists and its total is exactly the sum of its lines.
      name: 'draft_totals_reconcile',
      sql: `SELECT count(*) AS n FROM business_invoice i
            WHERE i.invoice_id = :invoice_id AND i.status = 'draft'
              AND i.total_minor = (SELECT COALESCE(SUM(amount_minor), 0)
                                     FROM business_invoice_line WHERE invoice_id = i.invoice_id)`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  // Mutates money state across rows (marks entries billed) — above the
  // routine-upkeep bar, below the outward-commitment bar.
  risk: 'medium',
  handler: createDraftInvoice,
};

function createDraftInvoice(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    client_id: string;
    entry_ids: string[];
    due_on: string;
    number?: string;
  };
  if (input.entry_ids.length === 0) throw new Error('an invoice needs at least one time entry');
  const client = ctx.db
    .prepare('SELECT currency FROM business_client WHERE client_id = ?')
    .get(input.client_id) as { currency: string } | undefined;
  if (!client) throw new Error('client vanished between check and execute');

  // Array inputs can't ride templated precondition SQL; the same
  // validate-then-throw lands as a receipted failed deny via execution.
  const entryRows = input.entry_ids.map((entryId) => {
    const row = ctx.db
      .prepare(
        `SELECT e.entry_id, e.billable, e.invoice_line_id, e.rate_minor,
                a.started_at, a.ended_at, p.client_id, p.name AS project_name
           FROM business_time_entry e
           JOIN core_activity a ON a.activity_id = e.activity_id
           JOIN business_project p ON p.project_id = e.project_id
          WHERE e.entry_id = ?`,
      )
      .get(entryId) as
      | {
          entry_id: string;
          billable: number;
          invoice_line_id: string | null;
          rate_minor: number | null;
          started_at: string;
          ended_at: string | null;
          client_id: string;
          project_name: string;
        }
      | undefined;
    if (!row) throw new Error(`time entry ${entryId} does not exist`);
    if (row.client_id !== input.client_id)
      throw new Error(`time entry ${entryId} belongs to a different client`);
    if (row.billable !== 1) throw new Error(`time entry ${entryId} is not billable`);
    if (row.invoice_line_id !== null) throw new Error(`time entry ${entryId} is already invoiced`);
    if (row.rate_minor === null)
      throw new Error(`time entry ${entryId} has no rate and the client has no default`);
    if (!row.ended_at) throw new Error(`time entry ${entryId} is still open`);
    return row;
  });

  const issuedOn = ctx.now.slice(0, 10);
  const number = input.number ?? nextInvoiceNumber(ctx, issuedOn.slice(0, 4));
  const invoiceId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO business_invoice (invoice_id, client_id, number, issued_on, due_on, currency, status, total_minor, paid_txn_id, pdf_content_id)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', 0, NULL, NULL)`,
    )
    .run(invoiceId, input.client_id, number, issuedOn, input.due_on, client.currency);
  ctx.wrote('business.invoice', invoiceId);

  let total = 0;
  for (const row of entryRows) {
    const hours =
      (new Date(row.ended_at as string).getTime() - new Date(row.started_at).getTime()) / 3_600_000;
    // qty_scaled = hours × 100 (hundredths of an hour, see header comment).
    const qtyScaled = Math.max(1, Math.round(hours * 100));
    const amount = Math.round((qtyScaled * (row.rate_minor as number)) / 100);
    const lineId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO business_invoice_line (line_id, invoice_id, description, qty_scaled, unit_price_minor, amount_minor)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        lineId,
        invoiceId,
        `${row.project_name} — ${row.started_at.slice(0, 10)}`,
        qtyScaled,
        row.rate_minor,
        amount,
      );
    ctx.wrote('business.invoice_line', lineId);
    ctx.db
      .prepare('UPDATE business_time_entry SET invoice_line_id = ? WHERE entry_id = ?')
      .run(lineId, row.entry_id);
    ctx.wrote('business.time_entry', row.entry_id);
    total += amount;
  }
  ctx.db
    .prepare('UPDATE business_invoice SET total_minor = ? WHERE invoice_id = ?')
    .run(total, invoiceId);
  ctx.cite({
    claim: `invoice ${number} drafted over ${entryRows.length} unbilled entries; sending stays behind its own command`,
    entityType: 'business.invoice',
    entityId: invoiceId,
  });
  return { invoice_id: invoiceId, number, total_minor: total, line_count: entryRows.length };
}

/** Sequential per-year numbers: INV-2026-0001, INV-2026-0002, … */
function nextInvoiceNumber(ctx: HandlerCtx, year: string): string {
  const row = ctx.db
    .prepare(
      `SELECT COALESCE(MAX(CAST(substr(number, -4) AS INTEGER)), 0) AS seq
         FROM business_invoice WHERE number LIKE 'INV-' || ? || '-%'`,
    )
    .get(year) as { seq: number };
  return `INV-${year}-${String(row.seq + 1).padStart(4, '0')}`;
}

const SEND_INVOICE: CommandDefinition = {
  name: 'business.send_invoice',
  ownerSchema: 'business',
  inputSchema: {
    type: 'object',
    required: ['invoice_id'],
    additionalProperties: false,
    properties: { invoice_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['invoice_id', 'status'],
    properties: { invoice_id: { type: 'string' }, status: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'invoice_is_draft',
      sql: `SELECT count(*) AS n FROM business_invoice
             WHERE invoice_id = :invoice_id AND status = 'draft'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'invoice_sent',
      sql: `SELECT count(*) AS n FROM business_invoice
             WHERE invoice_id = :invoice_id AND status = 'sent'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  // The moment an internal draft becomes an outward commitment to a client
  // for a specific amount — parks for the owner, like social.send_message.
  risk: 'high',
  handler: sendInvoice,
};

function sendInvoice(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { invoice_id: string };
  ctx.db
    .prepare(`UPDATE business_invoice SET status = 'sent' WHERE invoice_id = ?`)
    .run(input.invoice_id);
  ctx.wrote('business.invoice', input.invoice_id);
  ctx.cite({
    claim: `invoice ${input.invoice_id} released to the client`,
    entityType: 'business.invoice',
    entityId: input.invoice_id,
  });
  return { invoice_id: input.invoice_id, status: 'sent' };
}

const MARK_INVOICE_PAID: CommandDefinition = {
  name: 'business.mark_invoice_paid',
  ownerSchema: 'business',
  inputSchema: {
    type: 'object',
    required: ['invoice_id', 'txn_id'],
    additionalProperties: false,
    properties: {
      invoice_id: { type: 'string', minLength: 1 },
      txn_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['invoice_id', 'status'],
    properties: { invoice_id: { type: 'string' }, status: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'invoice_awaits_payment',
      sql: `SELECT count(*) AS n FROM business_invoice
             WHERE invoice_id = :invoice_id AND status IN ('sent','overdue')`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // A plausible settlement: a posted credit, same currency, covering
      // the total (overpayment allowed; a partial payment is not "paid").
      name: 'transaction_plausibly_settles',
      sql: `SELECT count(*) AS n FROM core_transaction t
             JOIN business_invoice i ON i.invoice_id = :invoice_id
            WHERE t.txn_id = :txn_id
              AND t.direction = 'credit' AND t.status = 'posted'
              AND t.currency = i.currency
              AND t.amount_minor >= i.total_minor`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'invoice_paid_and_linked',
      sql: `SELECT count(*) AS n FROM business_invoice
             WHERE invoice_id = :invoice_id AND status = 'paid' AND paid_txn_id = :txn_id`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  // Restates money facts (links ledger to invoice) but faces no one outside.
  risk: 'medium',
  handler: markInvoicePaid,
};

function markInvoicePaid(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { invoice_id: string; txn_id: string };
  ctx.db
    .prepare(`UPDATE business_invoice SET status = 'paid', paid_txn_id = ? WHERE invoice_id = ?`)
    .run(input.txn_id, input.invoice_id);
  ctx.wrote('business.invoice', input.invoice_id);
  ctx.cite({
    claim: `invoice ${input.invoice_id} settled by transaction ${input.txn_id}`,
    entityType: 'business.invoice',
    entityId: input.invoice_id,
  });
  return { invoice_id: input.invoice_id, status: 'paid' };
}

/** Register the business domain's commands on a gateway. */
export function registerBusinessCommands(gateway: Gateway): void {
  gateway.registerCommand(ADD_CLIENT);
  gateway.registerCommand(UPDATE_CLIENT);
  gateway.registerCommand(ADD_PROJECT);
  gateway.registerCommand(LOG_TIME);
  gateway.registerCommand(CREATE_DRAFT_INVOICE);
  gateway.registerCommand(SEND_INVOICE);
  gateway.registerCommand(MARK_INVOICE_PAID);
}
