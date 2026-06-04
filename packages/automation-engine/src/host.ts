/**
 * Common interface every "thing that fires automations on a schedule"
 * implements. Centraid has two such backends today:
 *
 *   - openclaw (cloud gateway): registers each automation as a cron job
 *     under the gateway's own scheduler via `cron.add`/`cron.update`/
 *     `cron.remove` gateway-tool calls. See
 *     `@centraid/openclaw-plugin/src/lib/automations-cron.ts`.
 *
 *   - local gateway (desktop embed + standalone daemon): the in-process
 *     `InProcessScheduler` (issue #149) keeps an in-memory registry and a
 *     single minute-boundary timer — no OS scheduler, no launchd/systemd.
 *     It fires enabled cron automations only while the gateway runs (n8n
 *     semantics, no backfill). See `./in-process-scheduler.ts`.
 *
 * Callers that mutate automation state drive this interface (via
 * `reconcile`) rather than poking the host's primitives directly.
 *
 * An automation is keyed by its globally-unique `<ownerApp>/<id>` ref.
 * Automations are user-owned and globally scheduled — `reconcile` always
 * receives the full desired set, so there is no per-app scoping to get wrong.
 *
 * Lifecycle contract:
 *   - `register` is idempotent. Calling it with the same row twice is a
 *     no-op. Calling with a changed schedule/prompt/etc. updates the
 *     existing entry.
 *   - `register` is also the toggle path. When `row.enabled` is false,
 *     the host's implementation decides whether to register a
 *     suppressed entry (openclaw's `enabled: false` cron job) or to
 *     unregister entirely (the in-process scheduler simply drops a
 *     disabled row from its registry). Either is fine — callers just
 *     call `register(row)` and don't care.
 *   - `unregister` is also idempotent. Tolerates "not found" — happens
 *     when the user removed the host entry by hand between centraid
 *     registration and teardown.
 *   - `reconcile(desired)` brings the host into agreement with the
 *     supplied desired set. Used at gateway/runtime startup to absorb
 *     changes that landed while the host was offline, and after a sync
 *     to settle every entry.
 */

import type { AutomationRow } from './app.js';

export interface AutomationHost {
  /**
   * Register or update one automation in the host. Idempotent.
   * Hosts decide how to represent `row.enabled === false` (suppressed
   * entry vs. no entry); callers just call this whenever the row
   * changes.
   */
  register(row: AutomationRow): Promise<void>;

  /**
   * Remove one automation from the host by its UUID. Tolerates
   * "not present".
   */
  unregister(automationId: string): Promise<void>;

  /**
   * List the centraid-owned host entries currently registered. The
   * format is host-specific (automation refs for the in-process
   * scheduler, cron job names for openclaw) — useful only for diagnostics
   * and reconciliation.
   */
  list(): Promise<readonly string[]>;

  /**
   * Bring the host into agreement with `desired`. Implementations
   * compare against `list()`, then issue the smallest set of
   * register/unregister calls needed. `desired` is always the full
   * set of centraid-owned automations.
   */
  reconcile(desired: ReadonlyArray<AutomationRow>): Promise<AutomationReconcileResult>;
}

export interface AutomationReconcileResult {
  /** Host-entry names newly registered. */
  added: readonly string[];
  /** Host-entry names whose definition changed. */
  updated: readonly string[];
  /** Host-entry names removed because they had no corresponding desired row. */
  removed: readonly string[];
}
