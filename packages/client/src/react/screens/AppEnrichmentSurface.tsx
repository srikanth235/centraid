import { useEffect, useState } from "react";
import type { JSX } from "react";

import {
  ENRICH_CAPABILITY_LABELS,
  ENRICH_CEILING_WORDS,
  ENRICH_EGRESS_WORDS,
  ENRICH_TRIGGER_WORDS,
} from "../../enrich-policy.js";
import type {
  EnrichEngineProfile,
  ResolvedEnrichPolicy,
} from "../../enrich-policy.js";
import Button from "../ui/Button.js";
import { Select } from "./SettingsHarnessesSelects.js";

import appSettingsCss from "../styles/appSettings.module.css";
import panelCss from "./AppSettingsPanel.module.css";
import styles from "./SettingsEnrichmentScreen.module.css";

export interface AppEnrichmentCapability {
  capability: string;
  effective: ResolvedEnrichPolicy | null;
  profile: EnrichEngineProfile | undefined;
}

export interface AppEnrichmentSurfaceProps {
  load: () => Promise<AppEnrichmentCapability[]>;
  loadProfiles: () => Promise<EnrichEngineProfile[]>;
  onOpenSettings: () => void;
  onEnrichOnce?: (profile: EnrichEngineProfile) => void;
}

type Load =
  | { kind: "loading" }
  | {
      kind: "ready";
      states: AppEnrichmentCapability[];
      profiles: EnrichEngineProfile[];
    }
  | { kind: "failed"; reason: string };

function describe(state: AppEnrichmentCapability): string {
  const { effective, profile } = state;
  if (!effective) return "No policy your gateway can honour — this stays off.";
  if (!effective.enabled) return "Off";
  const where = profile
    ? ENRICH_EGRESS_WORDS[profile.egress]
    : ENRICH_CEILING_WORDS[effective.egressCeiling];
  const engine = profile ? profile.label : effective.profileId;
  return `${engine} · ${where} · ${ENRICH_TRIGGER_WORDS[effective.trigger]}`;
}

export default function AppEnrichmentSurface({
  load,
  loadProfiles,
  onOpenSettings,
  onEnrichOnce,
}: AppEnrichmentSurfaceProps): JSX.Element {
  const [view, setView] = useState<Load>({ kind: "loading" });
  const [picked, setPicked] = useState("");

  useEffect(() => {
    let live = true;
    void Promise.all([load(), loadProfiles()])
      .then(([next, offered]) => {
        if (live) setView({ kind: "ready", states: next, profiles: offered });
      })
      .catch((error: unknown) => {
        if (live)
          setView({
            kind: "failed",
            reason: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      live = false;
    };
  }, [load, loadProfiles]);

  if (view.kind === "failed")
    return (
      <div className={appSettingsCss.appSettingsNote}>
        Your gateway didn’t answer: {view.reason}
      </div>
    );
  if (view.kind === "loading")
    return (
      <div className={appSettingsCss.appSettingsNote}>
        Reading what your gateway would do…
      </div>
    );
  const { states, profiles } = view;

  return (
    <div>
      <div className={styles.panel}>
        {states.map((state) => (
          <div className={styles.row} key={state.capability}>
            <span className={styles.rowName}>
              {ENRICH_CAPABILITY_LABELS[state.capability] ?? state.capability}
            </span>
            <span className={styles.rowMeta}>{describe(state)}</span>
          </div>
        ))}
      </div>
      <div className={styles.form}>
        <Select
          value={picked}
          onChange={setPicked}
          disabled={!onEnrichOnce}
          ariaLabel="Engine for a one-off run"
        >
          <option value="">Enrich with…</option>
          {profiles.map((profile) => (
            <option
              key={`${profile.capability}/${profile.id}`}
              value={`${profile.capability}/${profile.id}`}
            >
              {profile.label}
            </option>
          ))}
        </Select>
        <Button
          variant="secondary"
          size="sm"
          label="Run once"
          disabled={!onEnrichOnce || !picked}
          onClick={() => {
            const profile = profiles.find(
              (entry) => `${entry.capability}/${entry.id}` === picked
            );
            if (profile) onEnrichOnce?.(profile);
          }}
        />
      </div>
      {onEnrichOnce ? null : (
        <div className={appSettingsCss.appSettingsNote}>
          One-off runs aren’t wired to this app yet.
        </div>
      )}
      <button
        type="button"
        className={panelCss.settingsPaneLink}
        onClick={onOpenSettings}
      >
        Open Enrichment settings →
      </button>
    </div>
  );
}
