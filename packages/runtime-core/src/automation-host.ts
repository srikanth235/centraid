/**
 * Common interface every "thing that fires automations on a schedule"
 * implements. Centraid has two such backends today:
 *
 *   - openclaw (cloud gateway): registers each automation as a cron job
 *     under the gateway's own scheduler via `cron.add`/`cron.update`/
 *     `cron.remove` gateway-tool calls. See
 *     `@centraid/openclaw-plugin/src/lib/automations-cron.ts`.
 *
 *   - local desktop (in-process gateway): registers OS-level scheduler
 *     entries (launchd plist / systemd timer / Task Scheduler task) so
 *     automations fire even when the desktop is closed. See
 *     `@centraid/agent-runtime/src/os-scheduler.ts`.
 *
 * The IPC handlers in the desktop (and any future CLI verbs that mutate
 * automation state) should call into this interface rather than poking
 * the `automations` table or the host's primitives directly.
 *
 * Model-B (issue #90): an automation is identified by its UUID `id`;
 * the host keys its entries by that UUID. Automations are user-owned
 * and globally scheduled — `reconcile` always receives the full desired
 * set, so there is no per-app scoping to get wrong.
 *
 * Lifecycle contract:
 *   - `register` is idempotent. Calling it with the same row twice is a
 *     no-op. Calling with a changed schedule/prompt/etc. updates the
 *     existing entry.
 *   - `register` is also the toggle path. When `row.enabled` is false,
 *     the host's implementation decides whether to register a
 *     suppressed entry (openclaw's `enabled: false` cron job) or to
 *     unregister entirely (OS schedulers, which don't have a clean
 *     "registered but suppressed" state). Either is fine — callers
 *     just call `register(row)` and don't care.
 *   - `unregister` is also idempotent. Tolerates "not found" — happens
 *     when the user removed the host entry by hand between centraid
 *     registration and teardown.
 *   - `reconcile(desired)` brings the host into agreement with the
 *     supplied desired set. Used at gateway/runtime startup to absorb
 *     changes that landed while the host was offline, and after a sync
 *     to settle every entry.
 */

import type { AutomationRow } from './automation-store.js';

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
   * format is host-specific (cron job names for openclaw, launchd
   * labels on macOS, etc.) — useful only for diagnostics and
   * reconciliation.
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
