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

// The app popover's Enrichment surface (#807) — a PROJECTION of the one
// policy store onto the app in front of you, and never a second store.
//
// It shows the EFFECTIVE answer per capability, which is what the gateway's
// single resolver would fold for this app's domain right now; every knob that
// could change it lives on Settings → Enrichment, one deep link away. The only
// act offered here is a one-shot: "run this capability's engine over this app's
// data, once". Per #807 Q4 a one-shot is never promoted into a standing
// rule — a rule is authored where the cascade is visible.

/** One capability's effective answer, joined to the profile it names. */
export interface AppEnrichmentCapability {
  capability: string;
  effective: ResolvedEnrichPolicy | null;
  profile: EnrichEngineProfile | undefined;
}

export interface AppEnrichmentSurfaceProps {
  /** Read the effective policy for this app's domain. */
  load: () => Promise<AppEnrichmentCapability[]>;
  /** Every profile the gateway offers — the one-shot picker's options. */
  loadProfiles: () => Promise<EnrichEngineProfile[]>;
  /** Open Settings → Enrichment, where the policy is authored. */
  onOpenSettings: () => void;
  /**
   * Enqueue ONE run of the picked profile over this app's data.
   *
   * Absent when nothing on this host can enqueue it: the vault command behind a
   * one-shot (`enrich.request_enrichment`) is reached by an app's own action,
   * and no owner-plane seam offers it for an arbitrary capability yet, so the
   * picker states that instead of pretending. See #807.
   */
  onEnrichOnce?: (profile: EnrichEngineProfile) => void;
}

/** What the gateway answered, or why it could not. */
type Load =
  | { kind: "loading" }
  | {
      kind: "ready";
      states: AppEnrichmentCapability[];
      profiles: EnrichEngineProfile[];
    }
  /** `reason` is the underlying failure, stated rather than smoothed over. */
  | { kind: "failed"; reason: string };

/** What the gateway would do for one capability, in the member's words. */
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
