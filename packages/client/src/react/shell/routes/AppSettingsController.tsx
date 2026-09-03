import { useEffect, useRef } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { formatDuration, triggersSummary } from "../../../app-format.js";
import type { EnrichDomain } from "../../../enrich-policy.js";
import {
  listAutomations,
  listEnrichProfiles,
  runAutomationNow,
  setAutomationEnabled,
} from "../../../gateway-client.js";
import type { AppSettingsSnapshot } from "../../screen-contracts.js";
import AppEnrichmentSurface from "../../screens/AppEnrichmentSurface.js";
import AppSettingsPanel from "../../screens/AppSettingsPanel.js";
import VaultScreen from "../../screens/VaultScreen.js";
import { useShellCapabilities } from "../useCapabilities.js";
import {
  buildVaultProps,
  enrichDomainForApp,
  fetchAppKnobValues,
  loadAppEnrichment,
  fetchAppManifestRaw,
  knobsManifestFrom,
  manifestVaultBlock,
  pushKnobToInlineRoot,
  waitForAutomationRun,
  writeAppKnobValue,
} from "./appSettingsData.js";
import type { AppKnob } from "./appSettingsData.js";
import RunsPane from "./RunsPane.js";

type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; ok: boolean; durationMs: number; error?: string };

function mountEnrichmentPane(
  host: HTMLElement,
  domain: EnrichDomain,
  onOpenSettings: () => void,
  mountInto: (host: HTMLElement, node: JSX.Element) => void
): void {
  mountInto(
    host,
    <AppEnrichmentSurface
      load={() => loadAppEnrichment(domain)}
      loadProfiles={listEnrichProfiles}
      onOpenSettings={onOpenSettings}
    />
  );
}

function mountRunsPane(
  host: HTMLElement,
  roots: Map<HTMLElement, Root>,
  automationId: string
): void {
  roots.get(host)?.unmount();
  const root = createRoot(host);
  root.render(<RunsPane automationId={automationId} />);
  roots.set(host, root);
}

export interface AppSettingsControllerProps {
  app: AppMetaResolvedType;
  appId: string;
  initialTab?: "appearance" | "vault";
  onClose: () => void;
  onOpenAutomations: () => void;
  onOpenEnrichmentSettings: () => void;
  onOpenOrder: (ref: string) => void;
  onRename: () => void;
  onShare: () => void;
  onReveal: () => void;
  onDelete: () => void;
  bundled?: boolean;
  inlineRoot?: HTMLElement | null;
  showToast: (message: string) => void;
}

export default function AppSettingsController({
  app,
  appId,
  initialTab,
  onClose,
  onOpenAutomations,
  onOpenEnrichmentSettings,
  onOpenOrder,
  onRename,
  onShare,
  onReveal,
  onDelete,
  bundled,
  inlineRoot,
  showToast,
}: AppSettingsControllerProps): JSX.Element {
  const { automations } = useShellCapabilities();
  // than firing something else. TODO(#807): pass it once that seam exists.
  const enrichDomain = enrichDomainForApp(appId);
  const knobs = useRef<AppKnob[] | null>(null);
  const knobValues = useRef<Record<string, string>>({});
  const orders = useRef<CentraidAutomationRow[]>([]);
  const vaultVisible = useRef(false);
  const automationsBadge = useRef<number | null>(null);
  const vaultBadge = useRef<number | null>(null);
  const runState = useRef(new Map<string, RunState>());
  const updater = useRef<((s: AppSettingsSnapshot) => void) | null>(null);
  const alive = useRef(true);
  const subRoots = useRef(new Map<HTMLElement, Root>());

  const runDto = (
    ref: string
  ): AppSettingsSnapshot["orders"][number]["run"] => {
    const s = runState.current.get(ref);
    if (!s || s.kind === "idle") return { kind: "idle" };
    if (s.kind === "running") return { kind: "running" };
    const label = s.ok
      ? `Ran in ${formatDuration(s.durationMs)}`
      : (s.error ?? `Failed`);
    return { kind: "done", ok: s.ok, label };
  };

  const buildSnapshot = (): AppSettingsSnapshot => ({
    appName: app.name,
    appMark: { colorKey: app.colorKey, iconKey: app.iconKey },
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
          ? `Apps: ${(row.manifest.apps ?? []).join(", ")}`
          : "No apps linked",
      enabled: row.enabled,
      run: runDto(row.ref),
    })),
  });

  const push = (): void => {
    if (alive.current) updater.current?.(buildSnapshot());
  };
  const pushRef = useRef(push);
  useEffect(() => {
    pushRef.current = push;
  });

  useEffect(() => {
    alive.current = true;
    const roots = subRoots.current;
    const manifestRaw = fetchAppManifestRaw(appId);

    void Promise.all([manifestRaw, fetchAppKnobValues(appId)]).then(
      ([raw, stored]) => {
        if (!alive.current) return;
        const manifest = knobsManifestFrom(raw);
        if (manifest && manifest.knobs.length > 0) {
          knobs.current = manifest.knobs;
          Object.assign(knobValues.current, stored);
        }
        pushRef.current();
      }
    );
    void manifestRaw.then((raw) => {
      if (!alive.current) return;
      if (manifestVaultBlock(raw)) {
        vaultVisible.current = true;
        pushRef.current();
      }
    });
    if (automations) {
      void listAutomations().then((all) => {
        if (!alive.current) return;
        orders.current = all.filter((r) => r.manifest.apps?.includes(appId));
        automationsBadge.current =
          orders.current.length === 0 ? null : orders.current.length;
        pushRef.current();
      });
    }

    return () => {
      alive.current = false;
      roots.forEach((r) => r.unmount());
      roots.clear();
    };
  }, [appId, automations]);

  const pushKnob = (key: string, value: string): void => {
    if (inlineRoot) pushKnobToInlineRoot(inlineRoot, key, value);
  };

  const commitKnob = (key: string, value: string): void => {
    pushKnob(key, value);
    const def = knobs.current?.find((k) => k.key === key)?.default ?? "";
    const prior = knobValues.current[key] ?? def;
    knobValues.current[key] = value;
    void writeAppKnobValue(appId, key, value).catch((error: unknown) => {
      showToast(`Saving ${key} failed: ${String(error)}`);
      if (alive.current) {
        knobValues.current[key] = prior;
        pushKnob(key, prior);
        push();
      }
    });
  };

  const runOrder = async (ref: string): Promise<void> => {
    runState.current.set(ref, { kind: "running" });
    push();
    try {
      const { turnId } = await runAutomationNow({ automationId: ref });
      const rec = await waitForAutomationRun(turnId);
      runState.current.set(ref, {
        kind: "done",
        ok: rec.ok,
        durationMs: (rec.endedAt ?? Date.now()) - rec.startedAt,
        ...(rec.error ? { error: rec.error } : {}),
      });
    } catch (error) {
      runState.current.set(ref, {
        kind: "done",
        ok: false,
        durationMs: 0,
        error: error instanceof Error ? error.message : String(error),
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
    } catch (error) {
      row.enabled = prior;
      if (alive.current) {
        push();
        showToast(
          `Could not ${enabled ? "enable" : "disable"} ${row.name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };

  const mountInto = (host: HTMLElement, node: JSX.Element): void => {
    subRoots.current.get(host)?.unmount();
    const root = createRoot(host);
    root.render(node);
    subRoots.current.set(host, root);
  };

  return (
    <AppSettingsPanel
      initialTab={initialTab}
      automationsVisible={automations}
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
      {...(enrichDomain
        ? {
            onMountEnrichment: (host: HTMLElement) =>
              mountEnrichmentPane(
                host,
                enrichDomain,
                onOpenEnrichmentSettings,
                mountInto
              ),
          }
        : {})}
      onRename={onRename}
      onShare={onShare}
      onReveal={onReveal}
      onDelete={onDelete}
      {...(bundled ? { bundled: true } : {})}
      onMountRuns={(ref, host) => mountRunsPane(host, subRoots.current, ref)}
      onMountVault={(host) => {
        void fetchAppManifestRaw(appId).then((raw) => {
          const block = manifestVaultBlock(raw);
          if (!block || !alive.current) return;
          mountInto(
            host,
            <VaultScreen
              {...buildVaultProps(appId, block, {
                onParkedCount: (count) => {
                  vaultBadge.current = count === 0 ? null : count;
                  push();
                },
                showToast,
              })}
            />
          );
        });
      }}
    />
  );
}
