import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

import {
  ENRICH_CAPABILITY_LABELS,
  ENRICH_DOMAINS,
  ENRICH_DOMAIN_LABELS,
  ENRICH_EGRESS_WORDS,
  ENRICH_TIER_WORDS,
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
} from "../../enrich-policy.js";
import { relativeTime } from "../format.js";
import type { HarnessCardDTO } from "../screen-contracts.js";
import { DrawerGroup, DrawerRow, Segmented } from "./settings-controls.js";
import EnrichmentProfiles from "./SettingsEnrichmentProfiles.js";
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
// The reading order is the member's question order: how far may work go at
// all (tiers) → what would run it (engine profiles) → where that is narrowed
// or widened (scoped rules) → what have I already been asked (egress answers).

/** Everything the page renders, read in one pass. */
export interface EnrichmentSettingsData {
  policy: EnrichPolicy;
  rules: EnrichPolicyRule[];
  profiles: EnrichEngineProfile[];
  consent: EnrichConsentRecord[];
  /** The harnesses this gateway can run — the delegate pickers' options. */
  cards: HarnessCardDTO[];
}

/** One member-authored engine profile, as the create form states it. */
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
  deleteProfile: (id: string) => Promise<void>;
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

/** The member-facing name of a capability, falling back to its registry id. */
export function capabilityLabel(capability: string): string {
  return ENRICH_CAPABILITY_LABELS[capability] ?? capability;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One recorded egress answer — a receipted fact, never a control. */
function ConsentRow({ row }: { row: EnrichConsentRecord }): JSX.Element {
  return (
    <div className={styles.row}>
      <span className={styles.rowName}>{capabilityLabel(row.capability)}</span>
      <span className={styles.rowMeta}>
        {ENRICH_EGRESS_WORDS[row.egress]} · {row.decision} ·{" "}
        {relativeTime(row.decidedAt)}
      </span>
    </div>
  );
}

export default function SettingsEnrichmentScreen({
  load: read,
  setTier,
  saveProfile,
  deleteProfile,
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
  // this screen asked for.
  const pickTier = (domain: EnrichDomain, tier: EnrichTier): void => {
    void setTier(domain, tier)
      .then((policy) =>
        setLoad((current) =>
          current.kind === "ready"
            ? { kind: "ready", data: { ...current.data, policy } }
            : current
        )
      )
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

  return (
    <>
      <DrawerGroup label="Defaults">
        <div className={controlsCss.note}>
          How far enrichment of each kind of data may travel by default.
        </div>
        {ENRICH_DOMAINS.map((domain) => (
          <DrawerRow
            key={domain}
            label={ENRICH_DOMAIN_LABELS[domain]}
            hint={`Standing answer for your ${domain === "photos" ? "photos" : "documents"}.`}
          >
            <Segmented
              options={TIERS}
              selected={data.policy[domain]}
              labels={ENRICH_TIER_WORDS}
              ariaLabel={`Enrichment for ${ENRICH_DOMAIN_LABELS[domain]}`}
              onSelect={(tier) => pickTier(domain, tier)}
            />
          </DrawerRow>
        ))}
      </DrawerGroup>

      <EnrichmentProfiles
        profiles={data.profiles}
        cards={data.cards}
        saveProfile={saveProfile}
        deleteProfile={deleteProfile}
        showToast={showToast}
        onChanged={refresh}
      />

      <EnrichmentRules
        rules={data.rules}
        profiles={data.profiles}
        setRule={setRule}
        deleteRule={deleteRule}
        showToast={showToast}
        onChanged={refresh}
      />

      <DrawerGroup label="Egress answers">
        <div className={controlsCss.note}>
          What you were asked, and what you answered — kept, not re-asked.
        </div>
        <div className={styles.panel}>
          {data.consent.length === 0 ? (
            <div className={styles.empty}>Nothing has been asked yet.</div>
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
