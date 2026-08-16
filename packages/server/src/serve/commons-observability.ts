/*
 * Steward-absence detection and local Commons sync instrumentation (#731).
 *
 * A commons grant has exactly ONE steward vault. Today its loss is silent and
 * terminal: members keep pulling into the void and nothing ever says so. This
 * module is the noticing half — the member's pull path records every attempt
 * against `share_commons_steward_contact`, and an escalating, NAMED status is
 * derived from ELAPSED TIME since the last proven contact, never from a raw
 * failure count (a laptop closed overnight fails a lot and is not absent).
 *
 * The cry-wolf guard: absence is never inferred while THIS device has no
 * working link. `share_commons_device_reach` records the last moment any
 * peer-plane request completed a round trip at all — whatever it answered. A
 * grant escalates past "reachable" only when the device can show it was
 * reaching something while that grant's steward stayed silent; otherwise the
 * status is `link-down`, which never escalates.
 *
 * This is NOT a telemetry system. There is no network egress, no sampling, no
 * background timer, and no new store: three tables in the device's own
 * vault.db, written on paths that were already running, read back as a plain
 * object for the existing diagnostics/logs surface (docs/logs.md).
 */

import type { DatabaseSync } from "node:sqlite";

import type { CommonsHistoryFaultTag, VaultDb } from "@centraid/vault";

/** How a pull ended, from the member's point of view. */
export type CommonsPullOutcome =
  | "noop"
  | "tail"
  | "snapshot"
  | "tombstone"
  | "parked"
  | "unreachable";

/**
 * The escalating, named steward status a member surface renders.
 *
 * - `unknown` — never attempted (a fresh grant, or one that has never synced).
 * - `reachable` — contacted recently, or failing for less than the degraded
 *   threshold. A closed laptop lives here.
 * - `degraded` — silent past `COMMONS_STEWARD_DEGRADED_AFTER_MS`, while this
 *   device demonstrably had a working link.
 * - `absent` — silent past `COMMONS_STEWARD_ABSENT_AFTER_MS`. This is the
 *   state that should offer replica-export recovery.
 * - `link-down` — silent, but this device cannot show it reached anything
 *   either. We do not know, and we must not claim the steward died.
 * - `parked` — not an absence at all: a named history/digest fault. The seat
 *   stopped on purpose and needs an answer, not a re-found.
 */
export type CommonsStewardPresence =
  | "unknown"
  | "reachable"
  | "degraded"
  | "absent"
  | "link-down"
  | "parked";

/** Silent for a day, with a working local link, is "degraded". */
export const COMMONS_STEWARD_DEGRADED_AFTER_MS = 24 * 60 * 60 * 1000;
/** Silent for a week, with a working local link, is "absent". */
export const COMMONS_STEWARD_ABSENT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * The op window documented in `docs/decisions.md#commons` proposes as K. Lag
 * beyond it is the measurement that flips that plan's go/no-go, so the
 * summary counts members sitting past it rather than just reporting a max.
 */
export const COMMONS_LAG_WINDOW_OPS = 256;

export interface CommonsStewardStatus {
  grantId: string;
  presence: CommonsStewardPresence;
  stewardVaultId?: string;
  lastContactAt?: string;
  lastAttemptAt?: string;
  /** Milliseconds since the last PROVEN contact; absent while reachable. */
  silentForMs?: number;
  consecutiveFailures: number;
  lastOutcome: CommonsPullOutcome | "unknown";
  lastError?: string;
  fault?: CommonsHistoryFaultTag;
  /** Last time this device completed any peer round trip (the cry-wolf guard). */
  deviceLinkAt?: string;
}

interface ContactRow {
  grant_id: string;
  steward_vault_id: string | null;
  last_contact_at: string | null;
  last_attempt_at: string | null;
  absence_since: string | null;
  consecutive_failures: number;
  last_outcome: CommonsPullOutcome | "unknown";
  last_error: string | null;
  fault: CommonsHistoryFaultTag | null;
  attempts: number;
  contacts: number;
  pull_noop: number;
  pull_tail: number;
  pull_snapshot: number;
  pull_tombstone: number;
  pull_parked: number;
  pull_unreachable: number;
  absence_episodes: number;
  absent_ms: number;
  longest_absence_ms: number;
}

const CONTACT_COLUMNS = `grant_id, steward_vault_id, last_contact_at,
  last_attempt_at, absence_since, consecutive_failures, last_outcome,
  last_error, fault, attempts, contacts, pull_noop, pull_tail, pull_snapshot,
  pull_tombstone, pull_parked, pull_unreachable, absence_episodes, absent_ms,
  longest_absence_ms`;

function ms(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Record that this device completed a peer-plane round trip. Call it whenever
 * a dial RESOLVES, whatever the status: a 404 from the steward still proves
 * the local network works, which is exactly what the absence guard needs.
 */
export function recordCommonsDeviceReach(db: DatabaseSync, now: string): void {
  db.prepare(
    `INSERT INTO share_commons_device_reach
       (row_id, last_round_trip_at, round_trips, updated_at)
     VALUES (1, ?, 1, ?)
     ON CONFLICT(row_id) DO UPDATE SET
       last_round_trip_at = excluded.last_round_trip_at,
       round_trips = round_trips + 1,
       updated_at = excluded.updated_at`
  ).run(now, now);
}

function deviceReachAt(db: DatabaseSync): string | undefined {
  const row = db
    .prepare("SELECT last_round_trip_at FROM share_commons_device_reach")
    .get() as { last_round_trip_at: string | null } | undefined;
  return row?.last_round_trip_at ?? undefined;
}

function presenceFor(
  row: ContactRow,
  deviceLinkAt: string | undefined,
  nowMs: number
): CommonsStewardPresence {
  if (row.fault) return "parked";
  if (row.attempts === 0) return "unknown";
  const since = ms(row.absence_since);
  if (since === undefined) return "reachable";
  const silentMs = nowMs - since;
  if (silentMs < COMMONS_STEWARD_DEGRADED_AFTER_MS) return "reachable";
  // The device must be able to show it was reaching SOMETHING, both since this
  // absence began and recently enough to still count. A device that touched
  // the network once and then flew for a week proves nothing about the
  // steward, so it stays `link-down` rather than crying absence.
  const linkMs = ms(deviceLinkAt);
  if (
    linkMs === undefined ||
    linkMs < since ||
    nowMs - linkMs >= COMMONS_STEWARD_DEGRADED_AFTER_MS
  )
    return "link-down";
  return silentMs >= COMMONS_STEWARD_ABSENT_AFTER_MS ? "absent" : "degraded";
}

function statusFor(
  row: ContactRow,
  deviceLinkAt: string | undefined,
  now: string
): CommonsStewardStatus {
  const nowMs = Date.parse(now);
  const since = ms(row.absence_since);
  return {
    grantId: row.grant_id,
    presence: presenceFor(row, deviceLinkAt, nowMs),
    ...(row.steward_vault_id ? { stewardVaultId: row.steward_vault_id } : {}),
    ...(row.last_contact_at ? { lastContactAt: row.last_contact_at } : {}),
    ...(row.last_attempt_at ? { lastAttemptAt: row.last_attempt_at } : {}),
    ...(since === undefined ? {} : { silentForMs: Math.max(0, nowMs - since) }),
    consecutiveFailures: row.consecutive_failures,
    lastOutcome: row.last_outcome,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.fault ? { fault: row.fault } : {}),
    ...(deviceLinkAt ? { deviceLinkAt } : {}),
  };
}

function emptyRow(grantId: string): ContactRow {
  return {
    grant_id: grantId,
    steward_vault_id: null,
    last_contact_at: null,
    last_attempt_at: null,
    absence_since: null,
    consecutive_failures: 0,
    last_outcome: "unknown",
    last_error: null,
    fault: null,
    attempts: 0,
    contacts: 0,
    pull_noop: 0,
    pull_tail: 0,
    pull_snapshot: 0,
    pull_tombstone: 0,
    pull_parked: 0,
    pull_unreachable: 0,
    absence_episodes: 0,
    absent_ms: 0,
    longest_absence_ms: 0,
  };
}

function contactRow(
  db: DatabaseSync,
  grantId: string,
  memberVaultId: string
): ContactRow {
  const row = db
    .prepare(
      `SELECT ${CONTACT_COLUMNS} FROM share_commons_steward_contact
        WHERE grant_id = ? AND member_vault_id = ?`
    )
    .get(grantId, memberVaultId) as ContactRow | undefined;
  return row ?? emptyRow(grantId);
}

/** Read-only: the current steward status for one (grant, member vault). */
export function readCommonsStewardStatus(input: {
  db: DatabaseSync;
  grantId: string;
  memberVaultId: string;
  now?: string;
}): CommonsStewardStatus {
  const now = input.now ?? new Date().toISOString();
  return statusFor(
    contactRow(input.db, input.grantId, input.memberVaultId),
    deviceReachAt(input.db),
    now
  );
}

const OUTCOME_COLUMN: Record<CommonsPullOutcome, string> = {
  noop: "pull_noop",
  tail: "pull_tail",
  snapshot: "pull_snapshot",
  tombstone: "pull_tombstone",
  parked: "pull_parked",
  unreachable: "pull_unreachable",
};

/**
 * Fold one pull attempt into the member's durable contact state and return the
 * status the caller should carry back to the sweep/UI. A `parked` outcome is
 * NOT an absence: the steward answered, its history just did not verify, so
 * the absence episode closes and a named fault is pinned instead.
 */
export function recordCommonsPull(input: {
  db: DatabaseSync;
  grantId: string;
  memberVaultId: string;
  stewardVaultId?: string;
  outcome: CommonsPullOutcome;
  error?: string;
  fault?: CommonsHistoryFaultTag;
  now?: string;
}): CommonsStewardStatus {
  const now = input.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const before = contactRow(input.db, input.grantId, input.memberVaultId);
  const failed = input.outcome === "unreachable";
  const openedAt = ms(before.absence_since);
  // A reached steward closes the episode and banks its duration, whether it
  // answered with data or with a fault.
  const closing = !failed && openedAt !== undefined;
  const episodeMs = closing ? Math.max(0, nowMs - (openedAt ?? nowMs)) : 0;
  const next: ContactRow = {
    ...before,
    grant_id: input.grantId,
    steward_vault_id: input.stewardVaultId ?? before.steward_vault_id,
    last_contact_at: failed ? before.last_contact_at : now,
    last_attempt_at: now,
    absence_since: failed ? (before.absence_since ?? now) : null,
    consecutive_failures: failed ? before.consecutive_failures + 1 : 0,
    last_outcome: input.outcome,
    last_error: input.error ?? null,
    fault: input.fault ?? (input.outcome === "parked" ? before.fault : null),
    attempts: before.attempts + 1,
    contacts: before.contacts + (failed ? 0 : 1),
    absence_episodes:
      before.absence_episodes +
      (failed && before.absence_since === null ? 1 : 0),
    absent_ms: before.absent_ms + episodeMs,
    longest_absence_ms: Math.max(before.longest_absence_ms, episodeMs),
  };
  input.db
    .prepare(
      `INSERT INTO share_commons_steward_contact
         (grant_id, member_vault_id, steward_vault_id, last_contact_at,
          last_attempt_at, absence_since, consecutive_failures, last_outcome,
          last_error, fault, faulted_at, attempts, contacts, absence_episodes,
          absent_ms, longest_absence_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(grant_id, member_vault_id) DO UPDATE SET
         steward_vault_id = excluded.steward_vault_id,
         last_contact_at = excluded.last_contact_at,
         last_attempt_at = excluded.last_attempt_at,
         absence_since = excluded.absence_since,
         consecutive_failures = excluded.consecutive_failures,
         last_outcome = excluded.last_outcome,
         last_error = excluded.last_error,
         fault = excluded.fault,
         faulted_at = excluded.faulted_at,
         attempts = excluded.attempts,
         contacts = excluded.contacts,
         absence_episodes = excluded.absence_episodes,
         absent_ms = excluded.absent_ms,
         longest_absence_ms = excluded.longest_absence_ms`
    )
    .run(
      input.grantId,
      input.memberVaultId,
      next.steward_vault_id,
      next.last_contact_at,
      next.last_attempt_at,
      next.absence_since,
      next.consecutive_failures,
      next.last_outcome,
      next.last_error,
      next.fault,
      next.fault ? now : null,
      next.attempts,
      next.contacts,
      next.absence_episodes,
      next.absent_ms,
      next.longest_absence_ms
    );
  input.db
    .prepare(
      `UPDATE share_commons_steward_contact
          SET ${OUTCOME_COLUMN[input.outcome]} = ${OUTCOME_COLUMN[input.outcome]} + 1
        WHERE grant_id = ? AND member_vault_id = ?`
    )
    .run(input.grantId, input.memberVaultId);
  return statusFor(
    contactRow(input.db, input.grantId, input.memberVaultId),
    deviceReachAt(input.db),
    now
  );
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1)
  );
  return sorted[index] ?? 0;
}

export interface CommonsGrantObservability {
  grantId: string;
  containerType: string;
  /** Present only on a member seat that has attempted a pull. */
  steward: CommonsStewardStatus;
  /** contacts / attempts, or null when this seat has never attempted. */
  reachableRatio: number | null;
  absence: {
    episodes: number;
    totalMs: number;
    longestMs: number;
    /** The open episode's duration, when one is running. */
    openMs: number | null;
  };
  pullOutcomes: Record<CommonsPullOutcome, number>;
  /** The fixed-window-sync plan's first go/no-go number. */
  opLog: {
    rows: number;
    lastSequence: number;
    checkpointSequence: number;
    beyondCheckpoint: number;
  };
  /** The fixed-window-sync plan's second go/no-go number. */
  memberLag: {
    members: number;
    maxOps: number;
    p50Ops: number;
    beyondWindow: number;
  };
  /** Parked-intent dwell: submitted → executed/denied, in milliseconds. */
  intentDwellMs: {
    settled: number;
    open: number;
    p50: number;
    p95: number;
    maxOpenMs: number;
  };
  supersededBy?: string;
}

export interface CommonsVaultObservability {
  vaultId: string;
  grants: CommonsGrantObservability[];
  deviceLinkAt?: string;
}

function dwell(
  db: DatabaseSync,
  grantId: string,
  nowMs: number
): CommonsGrantObservability["intentDwellMs"] {
  const rows = db
    .prepare(
      `SELECT status, created_at, settled_at FROM share_commons_intent
        WHERE grant_id = ?`
    )
    .all(grantId) as {
    status: string;
    created_at: string;
    settled_at: string | null;
  }[];
  const settled: number[] = [];
  let open = 0;
  let maxOpenMs = 0;
  for (const row of rows) {
    const created = ms(row.created_at) ?? nowMs;
    const done = ms(row.settled_at);
    if (done === undefined) {
      open += 1;
      maxOpenMs = Math.max(maxOpenMs, nowMs - created);
      continue;
    }
    settled.push(Math.max(0, done - created));
  }
  settled.sort((a, b) => a - b);
  return {
    settled: settled.length,
    open,
    p50: percentile(settled, 0.5),
    p95: percentile(settled, 0.95),
    maxOpenMs,
  };
}

function grantObservability(
  db: DatabaseSync,
  grant: {
    grant_id: string;
    container_type: string;
    last_sequence: number;
    checkpoint_sequence: number;
  },
  memberVaultId: string,
  deviceLinkAt: string | undefined,
  now: string
): CommonsGrantObservability {
  const nowMs = Date.parse(now);
  const row = contactRow(db, grant.grant_id, memberVaultId);
  const ops = db
    .prepare(
      `SELECT COUNT(*) AS rows_n,
              SUM(CASE WHEN sequence > ? THEN 1 ELSE 0 END) AS beyond_n
         FROM share_commons_op WHERE grant_id = ?`
    )
    .get(grant.checkpoint_sequence, grant.grant_id) as {
    rows_n: number;
    beyond_n: number | null;
  };
  const lags = (
    db
      .prepare("SELECT sequence FROM share_commons_cursor WHERE grant_id = ?")
      .all(grant.grant_id) as { sequence: number }[]
  )
    .map((cursor) => Math.max(0, grant.last_sequence - cursor.sequence))
    .sort((a, b) => a - b);
  const superseded = db
    .prepare(
      "SELECT new_grant_id FROM share_commons_supersession WHERE old_grant_id = ?"
    )
    .get(grant.grant_id) as { new_grant_id: string } | undefined;
  const openMs = ms(row.absence_since);
  return {
    grantId: grant.grant_id,
    containerType: grant.container_type,
    steward: statusFor(row, deviceLinkAt, now),
    reachableRatio: row.attempts === 0 ? null : row.contacts / row.attempts,
    absence: {
      episodes: row.absence_episodes,
      totalMs: row.absent_ms,
      longestMs: row.longest_absence_ms,
      openMs: openMs === undefined ? null : Math.max(0, nowMs - openMs),
    },
    pullOutcomes: {
      noop: row.pull_noop,
      tail: row.pull_tail,
      snapshot: row.pull_snapshot,
      tombstone: row.pull_tombstone,
      parked: row.pull_parked,
      unreachable: row.pull_unreachable,
    },
    opLog: {
      rows: ops.rows_n,
      lastSequence: grant.last_sequence,
      checkpointSequence: grant.checkpoint_sequence,
      beyondCheckpoint: ops.beyond_n ?? 0,
    },
    memberLag: {
      members: lags.length,
      maxOps: lags.at(-1) ?? 0,
      p50Ops: percentile(lags, 0.5),
      beyondWindow: lags.filter((lag) => lag > COMMONS_LAG_WINDOW_OPS).length,
    },
    intentDwellMs: dwell(db, grant.grant_id, nowMs),
    ...(superseded ? { supersededBy: superseded.new_grant_id } : {}),
  };
}

/**
 * Read-only, cheap (a handful of indexed counts per grant) summary of one
 * vault's Commons planes. Nothing here leaves the device unless the owner
 * exports a diagnostics bundle themselves.
 */
export function commonsObservabilityForVault(input: {
  db: VaultDb;
  vaultId: string;
  now?: string;
}): CommonsVaultObservability {
  const now = input.now ?? new Date().toISOString();
  const deviceLinkAt = deviceReachAt(input.db.vault);
  const grants = input.db.vault
    .prepare(
      `SELECT grant_id, container_type, last_sequence, checkpoint_sequence
         FROM share_circle_grant WHERE plane = 'commons'
        ORDER BY created_at, grant_id`
    )
    .all() as {
    grant_id: string;
    container_type: string;
    last_sequence: number;
    checkpoint_sequence: number;
  }[];
  return {
    vaultId: input.vaultId,
    grants: grants.map((grant) =>
      grantObservability(
        input.db.vault,
        grant,
        input.vaultId,
        deviceLinkAt,
        now
      )
    ),
    ...(deviceLinkAt ? { deviceLinkAt } : {}),
  };
}

/**
 * Diagnostics-bundle section. `buildDiagnosticsBundle` takes an opaque,
 * caller-assembled `config` object and redacts it — this slots straight in
 * there (or into a `_gateway/logs` line) without inventing a second surface.
 */
export function commonsObservabilitySection(input: {
  vaults: readonly { vaultId: string; db?: VaultDb }[];
  now?: string;
}): { commons: CommonsVaultObservability[] } {
  const now = input.now ?? new Date().toISOString();
  const commons: CommonsVaultObservability[] = [];
  for (const vault of input.vaults) {
    if (!vault.db) continue;
    try {
      commons.push(
        commonsObservabilityForVault({
          db: vault.db,
          vaultId: vault.vaultId,
          now,
        })
      );
    } catch {
      // A stats read must never turn a working diagnostics bundle into a
      // failed one — the same posture `tableStatsFor` already takes.
    }
  }
  return { commons };
}
