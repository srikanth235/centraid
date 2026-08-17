import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

import {
  ENRICH_CAPABILITY_DOMAIN,
  ENRICH_DOMAINS,
  ENRICH_DOMAIN_LABELS,
  ENRICH_EGRESS_WORDS,
  ENRICH_TIER_WORDS,
  capabilityLabel,
} from "../../enrich-policy.js";
import type {
  EnrichConsentRecord,
  EnrichDomain,
  EnrichEngineProfile,
  EnrichPolicy,
  EnrichPolicyRule,
  EnrichScopeType,
  EnrichTier,
  EnrichTrigger,
  ResolvedEnrichPolicy,
} from "../../enrich-policy.js";
import { relativeTime } from "../format.js";
import type { HarnessCardDTO } from "../screen-contracts.js";
import { DrawerGroup, Segmented } from "./settings-controls.js";
import CapabilityRows from "./SettingsEnrichmentCapabilities.js";
import EnrichmentRules from "./SettingsEnrichmentRules.js";

import controlsCss from "../styles/controls.module.css";
import styles from "./SettingsEnrichmentScreen.module.css";

// Settings → Enrichment (issue #807) — the one place the whole enrichment
// policy is authored, and a PROJECTION of two stores rather than a third one:
// tiers, scoped rules and egress answers live in the vault; engine profiles
// live in gateway prefs. Every control below writes through the owner route
// that already owns its path and re-renders what came back, so a refused write
// can never show as applied.
//
// THE PAGE IS ORGANISED BY THE MEMBER'S QUESTION, NOT BY THE STORES. It used to
// be four groups named after four objects — tiers, engines, scoped rules,
// egress answers — which is the schema wearing a UI. Nobody arrives wanting to
// name an engine. They arrive asking: what is this doing with my photos, can I
// stop it, and does any of it leave my devices. So each DOMAIN is a group: how
// far its work may go, then the list of what runs, each row a plain name, a
// switch, and the computed fact of where it goes.
//
// The two remaining groups are the ones that answer a different question:
// exceptions (places you decided differently, listed only when some exist), and
// the record of what you have already been asked about sharing.

/** Everything the page renders, read in one pass. */
export interface EnrichmentSettingsData {
  policy: EnrichPolicy;
  rules: EnrichPolicyRule[];
  profiles: EnrichEngineProfile[];
  consent: EnrichConsentRecord[];
  /** The harnesses this gateway can run — the row engine pickers' options. */
  cards: HarnessCardDTO[];
  /**
   * What the gateway's ONE resolver folds per capability. Read from
   * `/_vault/enrich/effective` rather than computed here; a capability whose
   * domain this build does not know is absent, and its row says so.
   */
  effective: Record<string, ResolvedEnrichPolicy | null>;
}

/** One member-authored engine profile, as the row's agent pick states it. */
export interface EngineProfileInput {
  id: string;
  label: string;
  capability: string;
  harness: string;
  model?: string;
  configPins?: Record<string, string>;
}

/** One scope's decision about one capability; `null` is inherit. */
export interface EnrichRuleInput {
  scope: EnrichScopeType;
  ref: string;
  capability: string;
  enabled: boolean | null;
  profile: string | null;
  trigger: EnrichTrigger | null;
}

export interface SettingsEnrichmentScreenProps {
  load: () => Promise<EnrichmentSettingsData>;
  /** Write one domain's tier; resolves with the tiers the vault holds after. */
  setTier: (domain: EnrichDomain, tier: EnrichTier) => Promise<EnrichPolicy>;
  saveProfile: (input: EngineProfileInput) => Promise<void>;
  setRule: (rule: EnrichRuleInput) => Promise<void>;
  deleteRule: (
    scope: EnrichScopeType,
    ref: string,
    capability: string
  ) => Promise<void>;
  showToast: (message: string) => void;
}

const TIERS: readonly EnrichTier[] = ["off", "device", "gateway"];

/** What the gateway answered, or why it could not. */
type Load =
  | { kind: "loading" }
  | { kind: "ready"; data: EnrichmentSettingsData }
  /** `reason` is the underlying failure, stated rather than smoothed over. */
  | { kind: "failed"; reason: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One recorded egress answer — a receipted fact, never a control. */
function ConsentRow({ row }: { row: EnrichConsentRecord }): JSX.Element {
  return (
    <div className={styles.row}>
      <span className={styles.rowName}>{capabilityLabel(row.capability)}</span>
      <span className={styles.rowMeta}>
        {row.decision === "granted" ? "You allowed" : "You declined"} work{" "}
        {ENRICH_EGRESS_WORDS[row.egress]} · {relativeTime(row.decidedAt)}
      </span>
    </div>
  );
}

export default function SettingsEnrichmentScreen({
  load: read,
  setTier,
  saveProfile,
  setRule,
  deleteRule,
  showToast,
}: SettingsEnrichmentScreenProps): JSX.Element {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback((): void => setNonce((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    void read()
      .then((next) => {
        if (live) setLoad({ kind: "ready", data: next });
      })
      .catch((error: unknown) => {
        if (live) setLoad({ kind: "failed", reason: errorText(error) });
      });
    return () => {
      live = false;
    };
  }, [read, nonce]);

  // The tier the vault holds after the write is what renders — never the one
  // this screen asked for. It then re-reads: the ceiling decides which rows
  // will actually run, so every row's refusal note is stale until it does.
  const pickTier = (domain: EnrichDomain, tier: EnrichTier): void => {
    void setTier(domain, tier)
      .then((policy) => {
        setLoad((current) =>
          current.kind === "ready"
            ? { kind: "ready", data: { ...current.data, policy } }
            : current
        );
        refresh();
      })
      .catch((error: unknown) =>
        showToast(`Couldn’t change enrichment: ${errorText(error)}`)
      );
  };

  if (load.kind === "failed")
    return (
      <div className={controlsCss.note}>
        Your gateway didn’t answer: {load.reason}
      </div>
    );
  if (load.kind === "loading")
    return (
      <div className={controlsCss.note}>Reading your enrichment policy…</div>
    );
  const data = load.data;
  const builtIns = data.profiles.filter((profile) => profile.builtIn);

  return (
    <>
      {ENRICH_DOMAINS.map((domain) => {
        const label = ENRICH_DOMAIN_LABELS[domain];
        const mine = builtIns.filter(
          (profile) => ENRICH_CAPABILITY_DOMAIN[profile.capability] === domain
        );
        return (
          <DrawerGroup key={domain} label={label}>
            <div className={styles.ceiling}>
              <span className={styles.ceilingText}>
                <span className={styles.ceilingLabel}>
                  How far your {label.toLowerCase()} may go
                </span>
                <span className={styles.ceilingHint}>
                  Everything below is held to this, whatever its own switch
                  says.
                </span>
              </span>
              <Segmented
                options={TIERS}
                selected={data.policy[domain]}
                labels={ENRICH_TIER_WORDS}
                ariaLabel={`Enrichment for ${label}`}
                onSelect={(tier) => pickTier(domain, tier)}
              />
            </div>
            <CapabilityRows
              builtIns={mine}
              profiles={data.profiles}
              rules={data.rules}
              effective={data.effective}
              cards={data.cards}
              domainLabel={label}
              setRule={setRule}
              saveProfile={saveProfile}
              showToast={showToast}
              onChanged={refresh}
            />
          </DrawerGroup>
        );
      })}

      <EnrichmentRules
        rules={data.rules}
        deleteRule={deleteRule}
        showToast={showToast}
        onChanged={refresh}
      />

      <DrawerGroup label="Sharing you’ve been asked about">
        <div className={controlsCss.note}>
          Answered once and kept, so nothing asks you twice.
        </div>
        <div className={styles.panel}>
          {data.consent.length === 0 ? (
            <div className={styles.empty}>
              Nothing has needed to ask you yet.
            </div>
          ) : (
            data.consent.map((row) => (
              <ConsentRow key={`${row.capability}/${row.egress}`} row={row} />
            ))
          )}
        </div>
      </DrawerGroup>
    </>
  );
}
