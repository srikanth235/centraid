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
 * the mirror table or the host's primitives directly. That keeps the
 * "user toggled off in App settings" path identical regardless of
 * whether the desktop is in local or remote-gateway mode.
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
 *   - `reconcile(desired, opts?)` brings the host into agreement with
 *     the supplied desired set. Used at gateway/runtime startup to
 *     absorb changes that landed while the host was offline, and on
 *     every per-app publish/deregister to settle that app's entries.
 *     Pass `opts.scope.appId` for the per-app case — without it the
 *     diff runs against every centraid-owned entry the host knows,
 *     and `desired` listing rows for only one app would sweep every
 *     other app's entries. The interface enforces the scoping so
 *     callers can't get this wrong silently.
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
   * Remove one automation from the host. Tolerates "not present".
   */
  unregister(appId: string, name: string): Promise<void>;

  /**
   * List the centraid-owned host entries currently registered. The
   * format is host-specific (cron job names for openclaw, launchd
   * labels on macOS, etc.) — useful only for diagnostics and
   * reconciliation.
   */
  list(): Promise<readonly string[]>;

  /**
   * Bring the host into agreement with `desired`. Implementations
   * compare against `list()` (filtered to `opts.scope.appId` when
   * provided), then issue the smallest set of register/unregister
   * calls needed.
   *
   * `opts.scope.appId` MUST be set whenever `desired` is a per-app
   * subset of the mirror (i.e. came from `AutomationStore.listByApp`).
   * Omit it only when `desired` is the full mirror via
   * `AutomationStore.listAll` — typically at host startup.
   *
   * When `scope.appId` is set, `desired` rows that belong to other
   * apps are ignored (host implementations defensively filter), and
   * the removal pass only considers installed entries for that app.
   */
  reconcile(
    desired: ReadonlyArray<AutomationRow>,
    opts?: AutomationReconcileOptions,
  ): Promise<AutomationReconcileResult>;
}

/**
 * Options for {@link AutomationHost.reconcile}. Currently just the
 * scope; kept open as an object so we can grow it (timeouts, dry-run,
 * etc.) without breaking the call sites.
 */
export interface AutomationReconcileOptions {
  /**
   * When set, reconcile only the named app's entries. The host filters
   * its `list()` to entries for this app before computing removals so
   * a per-app desired set can't sweep other apps' jobs.
   */
  scope?: { appId: string };
}

export interface AutomationReconcileResult {
  /** Host-entry names newly registered. */
  added: readonly string[];
  /** Host-entry names whose definition changed. */
  updated: readonly string[];
  /** Host-entry names removed because they had no corresponding desired row. */
  removed: readonly string[];
}
