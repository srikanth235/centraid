import { type JSX, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { formatDuration, triggersSummary } from '../../../app-format.js';
import {
  listAutomations,
  runAutomationNow,
  setAutomationEnabled,
} from '../../../gateway-client.js';
import type { AppSettingsSnapshot } from '../../screen-contracts.js';
import AppSettingsPanel from '../../screens/AppSettingsPanel.js';
import VaultScreen from '../../screens/VaultScreen.js';
import { iconSvg } from '../iconSvg.js';
import RunsPane from './RunsPane.js';
import {
  type AppKnob,
  buildVaultProps,
  fetchAppKnobValues,
  fetchAppManifestRaw,
  knobsManifestFrom,
  manifestVaultBlock,
  pushKnobToAppFrame,
  pushKnobToInlineRoot,
  reloadAppFrame,
  waitForAutomationRun,
  writeAppKnobValue,
} from './appSettingsData.js';

type RunState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; ok: boolean; durationMs: number; error?: string };

export interface AppSettingsControllerProps {
  app: AppMetaResolvedType;
  appId: string;
  onClose: () => void;
  onOpenAutomations: () => void;
  onOpenOrder: (ref: string) => void;
  onRename: () => void;
  onShare: () => void;
  onReveal: () => void;
  onDelete: () => void;
  /** Bundled install serving in place (issue #434) — danger action is Uninstall. */
  bundled?: boolean;
  /** Inline route (issue #505): the app's root element, so knob edits push
   *  straight to it instead of the (absent) iframe. */
  inlineRoot?: HTMLElement | null;
  showToast: (message: string) => void;
}

/**
 * The app-settings popover, ported to React (issue #325, R4). Successor to the
 * deleted app-appview.ts `openAppSettingsReact`: it owns the gateway I/O (knob
 * persistence + live iframe push, automation run/toggle) and pushes a snapshot
 * into AppSettingsPanel, while the two deep sub-trees — the run-history list and
 * the vault consent pane — mount into the host divs the panel provides, as their
 * own React roots (RunsPane / VaultScreen).
 */
export default function AppSettingsController({
  app,
  appId,
  onClose,
  onOpenAutomations,
  onOpenOrder,
  onRename,
  onShare,
  onReveal,
  onDelete,
  bundled,
  inlineRoot,
  showToast,
}: AppSettingsControllerProps): JSX.Element {
  // Mutable snapshot inputs — refs so the async fetches + run streams mutate in
  // place and re-push without re-rendering this controller.
  const knobs = useRef<AppKnob[] | null>(null);
  const knobValues = useRef<Record<string, string>>({});
  const orders = useRef<CentraidAutomationRow[]>([]);
  const vaultVisible = useRef(false);
  const automationsBadge = useRef<number | null>(null);
  const vaultBadge = useRef<number | null>(null);
  const runState = useRef(new Map<string, RunState>());
  const updater = useRef<((s: AppSettingsSnapshot) => void) | null>(null);
  const alive = useRef(true);
  // React roots mounted into the panel's host divs, disposed on unmount.
  const subRoots = useRef(new Map<HTMLElement, Root>());

  const finish = window.CentraidTokens.tileFinish(app.color, 'gradient');
  const headerIcon = iconSvg(app.iconKey || 'Sparkle', 15, 1.85);

  const runDto = (ref: string): AppSettingsSnapshot['orders'][number]['run'] => {
    const s = runState.current.get(ref);
    if (!s || s.kind === 'idle') return { kind: 'idle' };
    if (s.kind === 'running') return { kind: 'running' };
    const label = s.ok ? `Ran in ${formatDuration(s.durationMs)}` : (s.error ?? `Failed`);
    return { kind: 'done', ok: s.ok, label };
  };

  const buildSnapshot = (): AppSettingsSnapshot => ({
    appName: app.name,
    iconSvg: headerIcon,
    iconBg: finish.background,
    iconColor: finish.glyphColor,
    iconShadow: finish.boxShadow ?? null,
    accent: app.color,
    vaultVisible: vaultVisible.current,
    automationsBadge: automationsBadge.current,
    vaultBadge: vaultBadge.current,
    knobs: knobs.current
      ? knobs.current.map((k) => ({
          key: k.key,
          label: k.label,
          type: k.type,
          value: knobValues.current[k.key] ?? k.default,
          options: k.options,
        }))
      : null,
    orders: orders.current.map((row) => ({
      id: row.id,
      ref: row.ref,
      name: row.name,
      schedule: triggersSummary(row.triggers),
      prompt: row.manifest.prompt,
      appsLabel:
        (row.manifest.apps ?? []).length > 0
          ? `Apps: ${(row.manifest.apps ?? []).join(', ')}`
          : 'No apps linked',
      enabled: row.enabled,
      run: runDto(row.ref),
    })),
  });

  const push = (): void => {
    if (alive.current) updater.current?.(buildSnapshot());
  };

  // Resolve knobs, vault visibility, and linked automations once on open.
  useEffect(() => {
    alive.current = true;
    const roots = subRoots.current;
    const manifestRaw = fetchAppManifestRaw(appId);

    void Promise.all([manifestRaw, fetchAppKnobValues(appId)]).then(([raw, stored]) => {
      if (!alive.current) return;
      const manifest = knobsManifestFrom(raw);
      if (manifest && manifest.knobs.length > 0) {
        knobs.current = manifest.knobs;
        Object.assign(knobValues.current, stored);
      }
      push();
    });
    void manifestRaw.then((raw) => {
      if (!alive.current) return;
      if (manifestVaultBlock(raw)) {
        vaultVisible.current = true;
        push();
      }
    });
    void listAutomations().then((all) => {
      if (!alive.current) return;
      orders.current = all.filter((r) => r.manifest.apps?.includes(appId));
      automationsBadge.current = orders.current.length === 0 ? null : orders.current.length;
      push();
    });

    return () => {
      alive.current = false;
      roots.forEach((r) => r.unmount());
      roots.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#325) re-run only on appId, not on the mutable ref reads
  }, [appId]);

  const pushKnob = (key: string, value: string): void => {
    if (inlineRoot) pushKnobToInlineRoot(inlineRoot, key, value);
    else pushKnobToAppFrame(key, value);
  };

  const commitKnob = (key: string, value: string): void => {
    pushKnob(key, value);
    const def = knobs.current?.find((k) => k.key === key)?.default ?? '';
    const prior = knobValues.current[key] ?? def;
    knobValues.current[key] = value;
    void writeAppKnobValue(appId, key, value).catch((err: unknown) => {
      showToast(`Saving ${key} failed: ${String(err)}`);
      if (alive.current) {
        knobValues.current[key] = prior;
        pushKnob(key, prior);
        push();
      }
    });
  };

  const runOrder = async (ref: string): Promise<void> => {
    runState.current.set(ref, { kind: 'running' });
    push();
    try {
      const { runId } = await runAutomationNow({ automationId: ref });
      const rec = await waitForAutomationRun(runId);
      runState.current.set(ref, {
        kind: 'done',
        ok: rec.ok,
        durationMs: (rec.endedAt ?? Date.now()) - rec.startedAt,
        ...(rec.error ? { error: rec.error } : {}),
      });
    } catch (err) {
      runState.current.set(ref, {
        kind: 'done',
        ok: false,
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    push();
  };

  const toggleOrder = async (ref: string, enabled: boolean): Promise<void> => {
    const row = orders.current.find((r) => r.ref === ref);
    if (!row) return;
    const prior = row.enabled;
    row.enabled = enabled;
    push();
    try {
      await setAutomationEnabled({ automationId: ref, enabled });
    } catch (err) {
      row.enabled = prior;
      if (alive.current) {
        push();
        showToast(
          `Could not ${enabled ? 'enable' : 'disable'} ${row.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  // Render a React sub-root into a host div the panel owns (runs / vault),
  // replacing any prior root on the same node.
  const mountInto = (host: HTMLElement, node: JSX.Element): void => {
    subRoots.current.get(host)?.unmount();
    const root = createRoot(host);
    root.render(node);
    subRoots.current.set(host, root);
  };

  return (
    <AppSettingsPanel
      onReady={(u) => {
        updater.current = u;
        u(buildSnapshot());
      }}
      onClose={onClose}
      onKnobCommit={commitKnob}
      onRunOrder={(ref) => void runOrder(ref)}
      onToggleOrder={(ref, enabled) => void toggleOrder(ref, enabled)}
      onOpenOrder={onOpenOrder}
      onOpenAutomations={onOpenAutomations}
      onRename={onRename}
      onShare={onShare}
      onReveal={onReveal}
      onDelete={onDelete}
      {...(bundled ? { bundled: true } : {})}
      onMountRuns={(ref, host) => mountInto(host, <RunsPane automationId={ref} />)}
      onMountVault={(host) => {
        void fetchAppManifestRaw(appId).then((raw) => {
          const block = manifestVaultBlock(raw);
          if (!block || !alive.current) return;
          mountInto(
            host,
            <VaultScreen
              {...buildVaultProps(appId, block, {
                onAccessChanged: () => reloadAppFrame(),
                onParkedCount: (count) => {
                  vaultBadge.current = count === 0 ? null : count;
                  push();
                },
                showToast,
              })}
            />,
          );
        });
      }}
    />
  );
}
