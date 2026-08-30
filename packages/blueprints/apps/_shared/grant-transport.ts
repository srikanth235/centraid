// A seat owns only how a request is addressed and credentialed (`GrantHttp`);
// no seat decides what a path means (#883, ruling V-replica). NO RELATIVE
// IMPORTS: `@centraid/client`'s program has no `allowImportingTsExtensions`.

import { ROUTES, vaultGrantRevokePath } from "@centraid/core/protocol";

export type GrantCapability = "view" | "edit";
export type GrantAudienceKind = "party" | "circle";

export const GRANT_LOCI = ["local", "boundary", "remote"] as const;
export type GrantLocus = (typeof GRANT_LOCI)[number];

export interface GrantRequest {
  audienceKind: GrantAudienceKind;
  audienceId: string;
  subjectType: string;
  subjectId: string;
  capability: GrantCapability;
  subjectLabel?: string;
}

/** Marked: only the transport knows if anything left the device. */
export class GrantUnreachableError extends Error {
  readonly grantTransport = "unreachable" as const;
  constructor(op: string, cause?: unknown) {
    super(`${op}: the gateway could not be reached`, { cause });
    this.name = "GrantUnreachableError";
  }
}

/** Duck-typed: a separate module graph fails `instanceof`. */
export function isGrantUnreachable(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { grantTransport?: unknown }).grantTransport === "unreachable"
  );
}

export interface GrantWireCalls {
  subjects: () => Promise<unknown>;
  forParty: (partyId: string) => Promise<unknown | undefined>;
  forAudience: (
    kind: GrantAudienceKind,
    id: string
  ) => Promise<unknown | undefined>;
  forSubject: (subjectType: string, subjectId: string) => Promise<unknown>;
  create: (request: GrantRequest) => Promise<unknown>;
  revoke: (grantId: string) => Promise<unknown>;
}

export interface GrantHttp {
  get: (pathname: string) => Promise<Response>;
  post: (pathname: string, payload?: unknown) => Promise<Response>;
}

/** Body first, status second: the route's `message` is the only member copy. */
async function grantJson(response: Response, op: string): Promise<unknown> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${op} failed (${response.status})`);
  }
  if (response.ok) return parsed;
  const row = parsed as { message?: unknown; error?: unknown };
  if (typeof row.message === "string" && row.message.length)
    throw new Error(row.message);
  throw new Error(
    typeof row.error === "string" && row.error.length
      ? `${op}: ${row.error}`
      : `${op} failed (${response.status})`
  );
}

/** `fetch` REJECTS when the request never left the device. */
async function reach(
  send: () => Promise<Response>,
  op: string
): Promise<Response> {
  try {
    return await send();
  } catch (error) {
    throw new GrantUnreachableError(op, error);
  }
}

function query(params: Record<string, string>): string {
  return `${ROUTES.vaultGrants}?${new URLSearchParams(params).toString()}`;
}

/* THE OFFLINE GRANT QUEUE (#883). Held here, not on the replica's intent
 * outbox: `share.grant` is `confirm: true`, so an app-credential dispatch parks
 * every queued grant, while the grant routes invoke with the frame's OWN door.
 * ORDER IS THE CONTRACT (V-table): once anything is queued everything behind it
 * queues. A refusal is an ANSWER, never a retry. */

export interface QueuedGrantIntent {
  intentId: string;
  queuedAt: string;
  op: "create" | "revoke";
  request?: GrantRequest;
  grantId?: string;
}

export interface GrantIntentQueue {
  list: () => Promise<QueuedGrantIntent[]>;
  append: (intent: QueuedGrantIntent) => Promise<void>;
  remove: (intentId: string) => Promise<void>;
}

export interface QueuedGrantAnswer {
  grantQueued: true;
  intent: QueuedGrantIntent;
}

export function isQueuedGrantAnswer(
  value: unknown
): value is QueuedGrantAnswer {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { grantQueued?: unknown }).grantQueued === true
  );
}

export interface GrantQueueDrain {
  sent: number;
  refused: { intent: QueuedGrantIntent; message: string }[];
  queued: number;
}

export interface QueuedGrantWireCalls extends GrantWireCalls {
  pending: () => Promise<QueuedGrantIntent[]>;
  drain: () => Promise<GrantQueueDrain>;
}

export interface GrantQueueOptions {
  newIntentId?: () => string;
  now?: () => string;
}

function defaultIntentId(): string {
  return `gq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** READS ARE NOT QUEUED: holding one turns "could not ask" into a stale claim. */
export function queuedGrantWireCalls(
  calls: GrantWireCalls,
  queue: GrantIntentQueue,
  options: GrantQueueOptions = {}
): QueuedGrantWireCalls {
  const newIntentId = options.newIntentId ?? defaultIntentId;
  const now = options.now ?? (() => new Date().toISOString());

  /** A store that cannot hold is not a queue: degrade to the plain wire. */
  const heldNow = async (): Promise<QueuedGrantIntent[] | undefined> => {
    try {
      return await queue.list();
    } catch {
      return undefined;
    }
  };

  const hold = async (
    intent: Omit<QueuedGrantIntent, "intentId" | "queuedAt">,
    unreachable: unknown
  ): Promise<QueuedGrantAnswer> => {
    const queued: QueuedGrantIntent = {
      intentId: newIntentId(),
      queuedAt: now(),
      ...intent,
    };
    try {
      await queue.append(queued);
    } catch {
      // Nothing was held, so nothing may be claimed.
      throw unreachable instanceof Error
        ? unreachable
        : new GrantUnreachableError(intent.op);
    }
    return { grantQueued: true, intent: queued };
  };

  const send = async (
    intent: Pick<QueuedGrantIntent, "op" | "request" | "grantId">
  ): Promise<unknown> =>
    intent.op === "revoke"
      ? calls.revoke(intent.grantId ?? "")
      : calls.create(intent.request!);

  /** The backlog drains before the new intent is judged — no scheduler. */
  const attempt = async (
    intent: Omit<QueuedGrantIntent, "intentId" | "queuedAt">
  ): Promise<unknown> => {
    let waiting = await heldNow();
    if (waiting === undefined) return send(intent);
    if (waiting.length > 0) {
      await queued.drain();
      waiting = (await heldNow()) ?? [];
    }
    if (waiting.length > 0) return hold(intent, undefined);
    try {
      return await send(intent);
    } catch (error) {
      if (!isGrantUnreachable(error)) throw error;
      return hold(intent, error);
    }
  };

  const queued: QueuedGrantWireCalls = {
    ...calls,
    pending: () => queue.list(),
    create: (request) => attempt({ op: "create", request }),
    revoke: (grantId) => attempt({ op: "revoke", grantId }),
    async drain() {
      const pending = (await heldNow()) ?? [];
      const drain: GrantQueueDrain = { sent: 0, refused: [], queued: 0 };
      // Sequential BY CONSTRUCTION: one chained promise, so nothing is sent
      // before the intent in front of it has been answered.
      let stoppedAt: number | undefined;
      await pending.reduce(async (prior, intent, index) => {
        await prior;
        if (stoppedAt !== undefined) return;
        try {
          await send(intent);
          await queue.remove(intent.intentId);
          drain.sent += 1;
        } catch (error) {
          if (isGrantUnreachable(error)) {
            stoppedAt = index;
            return;
          }
          await queue.remove(intent.intentId);
          drain.refused.push({
            intent,
            message:
              error instanceof Error && error.message.trim().length
                ? error.message
                : "the vault refused it",
          });
        }
      }, Promise.resolve());
      if (stoppedAt !== undefined) drain.queued = pending.length - stoppedAt;
      return drain;
    },
  };
  return queued;
}

export function grantWireCalls(http: GrantHttp): GrantWireCalls {
  const get = (pathname: string, op: string): Promise<Response> =>
    reach(() => http.get(pathname), op);
  const post = (
    pathname: string,
    op: string,
    payload?: unknown
  ): Promise<Response> => reach(() => http.post(pathname, payload), op);
  return {
    async subjects() {
      const op = "read shareable subjects";
      return grantJson(await get(ROUTES.vaultGrantSubjects, op), op);
    },
    async forParty(partyId) {
      const op = "read what this person can reach";
      const response = await get(query({ partyId }), op);
      // 404 is an answer, not a failure.
      if (response.status === 404) return undefined;
      return grantJson(response, op);
    },
    async forAudience(kind, id) {
      const op = "read this audience's shares";
      const response = await get(
        query({ audienceKind: kind, audienceId: id }),
        op
      );
      if (response.status === 404) return undefined;
      return grantJson(response, op);
    },
    async forSubject(subjectType, subjectId) {
      const op = "read who this is shared with";
      return grantJson(await get(query({ subjectType, subjectId }), op), op);
    },
    async create(request) {
      const op = "share";
      return grantJson(await post(ROUTES.vaultGrants, op, request), op);
    },
    async revoke(grantId) {
      const op = "revoke this share";
      return grantJson(
        await post(vaultGrantRevokePath(encodeURIComponent(grantId)), op),
        op
      );
    },
  };
}
