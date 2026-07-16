/*
 * One-time pairing tickets (issue #289 phase 2) — the SSH-bootstrap
 * ceremony for headless gateways.
 *
 * `centraid-gateway pair --vault <name>` mints a ticket: the gateway's
 * iroh EndpointTicket (identity pin + relay hint), a one-time secret, and
 * the vault it enrolls into, with a short TTL. The owner pastes the
 * one-line token into a client's "Add gateway" dialog (or sends it to a
 * family member); redeeming — over the gateway's pair ALPN — enrolls the
 * caller's device key into the named vault and burns the ticket. No TOFU:
 * the ticket pins the gateway identity before the first connection.
 *
 * Only the secret's SHA-256 lands on disk; the CLI (mint) and the daemon
 * (redeem) are separate processes, so the store re-reads its file on
 * mtime change, same as the enrollment store.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Default ticket lifetime: long enough to paste, short enough to leak safely. */
export const DEFAULT_TICKET_TTL_MS = 15 * 60 * 1000;

interface StoredTicket {
  ticketId: string;
  /** SHA-256 hex of the one-time secret — never the secret itself. */
  secretHash: string;
  vaultId: string;
  trust: 'full' | 'readonly';
  createdAt: string;
  expiresAt: number;
}

interface TicketFile {
  version: 1;
  tickets: StoredTicket[];
}

/** The pasteable one-line token (see `encodePairingTicket`). */
export interface PairingTicketPayload {
  v: 1;
  kind: 'centraid-gw-pair';
  /** The gateway's iroh EndpointTicket string — identity pin + relay hint. */
  gw: string;
  /** Ticket id (public half). */
  t: string;
  /** One-time secret (private half). */
  s: string;
  /** Owner-facing vault name, so the client can label the pair before dialing. */
  vaultName: string;
  /** Ticket expiry, epoch ms — clients refuse to redeem stale tickets early. */
  exp: number;
}

export function encodePairingTicket(payload: PairingTicketPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function parsePairingTicket(raw: string): PairingTicketPayload | undefined {
  try {
    const obj = JSON.parse(
      Buffer.from(raw.trim(), 'base64url').toString('utf8'),
    ) as Partial<PairingTicketPayload>;
    if (obj.v !== 1 || obj.kind !== 'centraid-gw-pair') return undefined;
    if (typeof obj.gw !== 'string' || typeof obj.t !== 'string' || typeof obj.s !== 'string') {
      return undefined;
    }
    if (typeof obj.vaultName !== 'string' || typeof obj.exp !== 'number') return undefined;
    return obj as PairingTicketPayload;
  } catch {
    return undefined;
  }
}

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

export class PairingTicketStore {
  private tickets: StoredTicket[] = [];
  private loadedMtimeMs = -1;

  private constructor(private readonly file: string) {}

  static open(file: string): PairingTicketStore {
    const store = new PairingTicketStore(file);
    store.reloadIfChanged();
    return store;
  }

  private reloadIfChanged(): void {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      this.tickets = [];
      this.loadedMtimeMs = -1;
      return;
    }
    if (mtimeMs === this.loadedMtimeMs) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<TicketFile>;
      this.tickets = Array.isArray(raw.tickets)
        ? raw.tickets.filter(
            (t): t is StoredTicket =>
              typeof t === 'object' &&
              t !== null &&
              typeof (t as StoredTicket).ticketId === 'string' &&
              typeof (t as StoredTicket).secretHash === 'string' &&
              typeof (t as StoredTicket).vaultId === 'string' &&
              ((t as StoredTicket).trust === 'full' || (t as StoredTicket).trust === 'readonly') &&
              typeof (t as StoredTicket).expiresAt === 'number',
          )
        : [];
      this.loadedMtimeMs = mtimeMs;
    } catch {
      this.tickets = [];
      this.loadedMtimeMs = mtimeMs;
    }
  }

  private persist(): void {
    // Expired tickets are dead weight — sweep on every write.
    const now = Date.now();
    this.tickets = this.tickets.filter((t) => t.expiresAt > now);
    const payload: TicketFile = { version: 1, tickets: this.tickets };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.loadedMtimeMs = fs.statSync(this.file).mtimeMs;
  }

  /** Mint a one-time ticket enrolling into `vaultId`. Returns the private secret. */
  mint(
    vaultId: string,
    ttlMs = DEFAULT_TICKET_TTL_MS,
    trust: 'full' | 'readonly' = 'full',
  ): {
    ticketId: string;
    secret: string;
    expiresAt: number;
  } {
    this.reloadIfChanged();
    const ticketId = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + ttlMs;
    this.tickets.push({
      ticketId,
      secretHash: hashSecret(secret),
      vaultId,
      trust,
      createdAt: new Date().toISOString(),
      expiresAt,
    });
    this.persist();
    return { ticketId, secret, expiresAt };
  }

  /**
   * Redeem one ticket: verify the secret (timing-safe over hashes), check
   * TTL, burn it, and hand back the vault it enrolls into. Every failure
   * is the same `undefined` — a caller learns nothing about WHY.
   */
  redeem(
    ticketId: string,
    secret: string,
  ): { vaultId: string; trust: 'full' | 'readonly' } | undefined {
    this.reloadIfChanged();
    const ticket = this.tickets.find((t) => t.ticketId === ticketId);
    if (!ticket) return undefined;
    const expected = Buffer.from(ticket.secretHash, 'hex');
    const actual = Buffer.from(hashSecret(secret), 'hex');
    const valid = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    const fresh = ticket.expiresAt > Date.now();
    // Burn on ANY redemption attempt with the right id — a guessed-secret
    // retry loop dies on the first try.
    this.tickets = this.tickets.filter((t) => t !== ticket);
    this.persist();
    if (!valid || !fresh) return undefined;
    return { vaultId: ticket.vaultId, trust: ticket.trust };
  }

  /** Unexpired tickets (admin listing). */
  listActive(): Array<{
    ticketId: string;
    vaultId: string;
    trust: 'full' | 'readonly';
    expiresAt: number;
  }> {
    this.reloadIfChanged();
    const now = Date.now();
    return this.tickets
      .filter((t) => t.expiresAt > now)
      .map(({ ticketId, vaultId, trust, expiresAt }) => ({ ticketId, vaultId, trust, expiresAt }));
  }
}
