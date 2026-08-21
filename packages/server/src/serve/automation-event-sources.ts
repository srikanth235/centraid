/**
 * First-party read-only provider cursor adapters for automation event
 * triggers. Credentials stay inside ConnectionBroker; this module receives
 * only a bounded JSON fetch capability and emits normalized, secret-free
 * events plus the provider's next cursor.
 */

import type {
  ConnectionBinding,
  EventTrigger,
} from "@centraid/server/automation";

export interface PollJsonResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body?: unknown;
}

export type PollJson = (
  connection: ConnectionBinding,
  url: string,
  headers?: Readonly<Record<string, string>>
) => Promise<PollJsonResponse>;

export interface NormalizedProviderEvent {
  id: string;
  occurredAt: number;
  payload: Readonly<Record<string, unknown>>;
}

export interface ProviderPollResult {
  events: readonly NormalizedProviderEvent[];
  cursor: unknown;
  skipped?: number;
  gapReason?: string;
}

export interface PollProviderEventSourceInput {
  trigger: EventTrigger;
  connection: ConnectionBinding;
  cursor?: unknown;
  now: Date;
  limit: number;
  pollJson: PollJson;
}

interface GmailCursor {
  provider: "gmail";
  historyId: string;
}

interface GitHubCursor {
  provider: "github";
  etag?: string;
  lastModified?: string;
  notBefore?: number;
}

const MAX_PROVIDER_PAGES_PER_POLL = 100;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function gmailCursor(value: unknown): GmailCursor | undefined {
  const row = object(value);
  return row?.provider === "gmail" && string(row.historyId)
    ? { provider: "gmail", historyId: string(row.historyId)! }
    : undefined;
}

function githubCursor(value: unknown): GitHubCursor | undefined {
  const row = object(value);
  if (row?.provider !== "github") return undefined;
  return {
    provider: "github",
    ...(string(row.etag) ? { etag: string(row.etag) } : {}),
    ...(string(row.lastModified)
      ? { lastModified: string(row.lastModified) }
      : {}),
    ...(number(row.notBefore) ? { notBefore: number(row.notBefore) } : {}),
  };
}

/** Default provider poll spacing when the response carries no hint. */
const DEFAULT_POLL_INTERVAL_SECONDS = 60;
/**
 * Upper bound on a PROVIDER-controlled `x-poll-interval`. GitHub's real
 * values are seconds-to-minutes; an unbounded one (from a hostile response or
 * a misbehaving proxy inside `allowed_hosts`) would park the trigger for
 * years with no health signal.
 */
const MAX_POLL_INTERVAL_SECONDS = 15 * 60;

function pollDelay(
  headers: Readonly<Record<string, string>>,
  now: number
): number {
  const seconds = Number(headers["x-poll-interval"]);
  const requested =
    Number.isFinite(seconds) && seconds > 0
      ? seconds
      : DEFAULT_POLL_INTERVAL_SECONDS;
  return now + Math.min(requested, MAX_POLL_INTERVAL_SECONDS) * 1000;
}

async function gmailPoll(
  input: PollProviderEventSourceInput
): Promise<ProviderPollResult> {
  if (input.trigger.event !== "new-message") {
    throw new Error(`unsupported Gmail event "${input.trigger.event}"`);
  }
  const cursor = gmailCursor(input.cursor);
  const profileUrl = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
  if (!cursor) {
    const profile = await input.pollJson(input.connection, profileUrl);
    const historyId = string(object(profile.body)?.historyId);
    if (profile.status !== 200 || !historyId) {
      throw new Error(`Gmail profile baseline failed (${profile.status})`);
    }
    return {
      events: [],
      cursor: { provider: "gmail", historyId } satisfies GmailCursor,
    };
  }

  const events = new Map<string, NormalizedProviderEvent>();
  let pageToken: string | undefined;
  let nextHistoryId = cursor.historyId;
  let pages = 0;
  const readPage = async (): Promise<ProviderPollResult | undefined> => {
    if (pages++ >= MAX_PROVIDER_PAGES_PER_POLL) {
      // The provider window is larger than this poll's safety budget. Move
      // explicitly to "now", retain the bounded prefix already collected,
      // and record an unknown-size gap. Throwing here would preserve the old
      // cursor and retry the same 100 pages forever.
      const profile = await input.pollJson(input.connection, profileUrl);
      const historyId = string(object(profile.body)?.historyId);
      if (profile.status !== 200 || !historyId) {
        throw new Error(
          `Gmail page-limit rebaseline failed (${profile.status})`
        );
      }
      return {
        events: [...events.values()],
        cursor: { provider: "gmail", historyId } satisfies GmailCursor,
        skipped: 1,
        gapReason: "gmail_history_page_limit",
      };
    }
    const url = new URL(
      "https://gmail.googleapis.com/gmail/v1/users/me/history"
    );
    url.searchParams.set("startHistoryId", cursor.historyId);
    url.searchParams.set("historyTypes", "messageAdded");
    url.searchParams.set(
      "maxResults",
      String(Math.min(500, Math.max(1, input.limit)))
    );
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await input.pollJson(input.connection, url.toString());
    if (response.status === 404) {
      // Gmail history cursors expire. Re-baseline from profile ("now") and
      // record one explicit unknown-size gap; never enumerate the mailbox.
      const profile = await input.pollJson(input.connection, profileUrl);
      const historyId = string(object(profile.body)?.historyId);
      if (profile.status !== 200 || !historyId) {
        throw new Error(
          `Gmail expired-cursor rebaseline failed (${profile.status})`
        );
      }
      return {
        events: [],
        cursor: { provider: "gmail", historyId } satisfies GmailCursor,
        skipped: 1,
        gapReason: "gmail_history_expired",
      };
    }
    if (response.status !== 200)
      throw new Error(`Gmail history poll failed (${response.status})`);
    const body = object(response.body) ?? {};
    nextHistoryId = string(body.historyId) ?? nextHistoryId;
    const history = Array.isArray(body.history) ? body.history : [];
    for (const rawEntry of history) {
      const entry = object(rawEntry);
      if (!entry) continue;
      const historyId = string(entry.id);
      const added = Array.isArray(entry.messagesAdded)
        ? entry.messagesAdded
        : [];
      for (const rawAdded of added) {
        const message = object(object(rawAdded)?.message);
        const messageId = string(message?.id);
        if (!messageId) continue;
        const labels = Array.isArray(message?.labelIds)
          ? message.labelIds.filter(
              (label): label is string => typeof label === "string"
            )
          : [];
        const event: NormalizedProviderEvent = {
          id: `gmail:message:${messageId}`,
          occurredAt: input.now.getTime(),
          payload: {
            provider: "gmail",
            event: "new-message",
            messageId,
            ...(string(message?.threadId)
              ? { threadId: string(message?.threadId) }
              : {}),
            ...(historyId ? { historyId } : {}),
            ...(labels.length > 0 ? { labelIds: labels } : {}),
          },
        };
        events.set(event.id, event);
      }
    }
    pageToken = string(body.nextPageToken);
    return pageToken ? readPage() : undefined;
  };
  const terminal = await readPage();
  if (terminal) return terminal;
  return {
    events: [...events.values()],
    cursor: {
      provider: "gmail",
      historyId: nextHistoryId,
    } satisfies GmailCursor,
  };
}

function githubRepo(trigger: EventTrigger): string {
  const repo = string(trigger.filter?.repo);
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) {
    throw new Error('GitHub event trigger filter.repo must be "owner/repo"');
  }
  return repo;
}

function githubPayload(
  event: Record<string, unknown>,
  repo: string,
  wanted: EventTrigger["event"]
): NormalizedProviderEvent | undefined {
  const id = string(event.id);
  const type = string(event.type);
  const payload = object(event.payload);
  const action = string(payload?.action);
  const subject =
    wanted === "pull-request" && type === "PullRequestEvent"
      ? object(payload?.pull_request)
      : wanted === "issue" && type === "IssuesEvent"
        ? object(payload?.issue)
        : undefined;
  if (!id || !subject) return undefined;
  const user = object(subject.user);
  const createdAt = string(subject.created_at) ?? string(event.created_at);
  const occurredAt = createdAt ? Date.parse(createdAt) : Number.NaN;
  return {
    id: `github:event:${id}`,
    occurredAt: Number.isFinite(occurredAt) ? occurredAt : Date.now(),
    payload: {
      provider: "github",
      event: wanted,
      eventId: id,
      repo,
      ...(action ? { action } : {}),
      ...(number(subject.number) ? { number: number(subject.number) } : {}),
      ...(string(subject.title) ? { title: string(subject.title) } : {}),
      ...(string(subject.state) ? { state: string(subject.state) } : {}),
      ...(string(subject.html_url) ? { url: string(subject.html_url) } : {}),
      ...(string(user?.login) ? { userLogin: string(user?.login) } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(string(subject.updated_at)
        ? { updatedAt: string(subject.updated_at) }
        : {}),
    },
  };
}

function githubNextPage(
  headers: Readonly<Record<string, string>>
): string | undefined {
  const link = headers.link;
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const nextUrl = part.match(/<(?<nextUrl>[^>]+)>\s*;\s*rel="?next"?/u)
      ?.groups?.nextUrl;
    if (!nextUrl) continue;
    const url = new URL(nextUrl);
    if (url.protocol !== "https:" || url.hostname !== "api.github.com") {
      throw new Error("GitHub events pagination returned an unsafe next URL");
    }
    return url.toString();
  }
  return undefined;
}

async function githubPoll(
  input: PollProviderEventSourceInput
): Promise<ProviderPollResult> {
  if (
    input.trigger.event !== "pull-request" &&
    input.trigger.event !== "issue"
  ) {
    throw new Error(`unsupported GitHub event "${input.trigger.event}"`);
  }
  const repo = githubRepo(input.trigger);
  const storedCursor = githubCursor(input.cursor);
  const cursor = storedCursor ?? { provider: "github" as const };
  if (cursor.notBefore && input.now.getTime() < cursor.notBefore) {
    return { events: [], cursor };
  }
  const [owner, name] = repo.split("/") as [string, string];
  const url =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` +
    `/events?per_page=${Math.min(100, Math.max(1, input.limit))}`;
  const conditionalHeaders: Record<string, string> = {};
  if (cursor.etag) conditionalHeaders["if-none-match"] = cursor.etag;
  if (cursor.lastModified)
    conditionalHeaders["if-modified-since"] = cursor.lastModified;
  const response = await input.pollJson(
    input.connection,
    url,
    conditionalHeaders
  );
  const next: GitHubCursor = {
    provider: "github",
    ...(response.headers.etag ? { etag: response.headers.etag } : {}),
    ...(response.headers["last-modified"]
      ? { lastModified: response.headers["last-modified"] }
      : {}),
    notBefore: pollDelay(response.headers, input.now.getTime()),
  };
  if (response.status === 304)
    return { events: [], cursor: { ...cursor, ...next } };
  if (response.status !== 200)
    throw new Error(`GitHub events poll failed (${response.status})`);
  // A newly-authored watcher starts at the provider's current conditional
  // token. Existing repository history is not an automation event.
  if (!storedCursor) return { events: [], cursor: { ...cursor, ...next } };
  const rows = Array.isArray(response.body) ? [...response.body] : [];
  let nextPage = githubNextPage(response.headers);
  let pages = 1;
  let skipped: number | undefined;
  let gapReason: string | undefined;
  const readNextPage = async (): Promise<void> => {
    if (!nextPage) return;
    if (pages++ >= MAX_PROVIDER_PAGES_PER_POLL) {
      // The first-page ETag is the new durable provider position. Commit the
      // bounded newest prefix and mark the unknown older tail as skipped
      // instead of retrying the same page window indefinitely.
      skipped = 1;
      gapReason = "github_events_page_limit";
      return;
    }
    const page = await input.pollJson(input.connection, nextPage);
    if (page.status !== 200) {
      throw new Error(`GitHub events pagination failed (${page.status})`);
    }
    if (Array.isArray(page.body)) rows.push(...page.body);
    nextPage = githubNextPage(page.headers);
    return readNextPage();
  };
  await readNextPage();
  const events = rows
    .map((entry) =>
      object(entry)
        ? githubPayload(object(entry)!, repo, input.trigger.event)
        : undefined
    )
    .filter((event): event is NormalizedProviderEvent => event !== undefined)
    .toReversed();
  return {
    events,
    cursor: { ...cursor, ...next },
    ...(skipped === undefined ? {} : { skipped }),
    ...(gapReason === undefined ? {} : { gapReason }),
  };
}

/** Route a declarative event trigger to one first-party provider adapter. */
export function pollProviderEventSource(
  input: PollProviderEventSourceInput
): Promise<ProviderPollResult> {
  if (input.trigger.connectorKind === "pull.gmail") return gmailPoll(input);
  if (input.trigger.connectorKind === "pull.github") return githubPoll(input);
  throw new Error(
    `no event cursor adapter for "${input.trigger.connectorKind}"`
  );
}
