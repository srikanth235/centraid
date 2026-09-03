import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

import {
  ENRICH_CAPABILITY_DOMAIN,
  ENRICH_DOMAINS,
  ENRICH_DOMAIN_LABELS,
  ENRICH_EGRESS_WORDS,
  capabilityLabel,
} from "../../enrich-policy.js";
import type {
  EnrichConsentRecord,
  EnrichEngineProfile,
  EnrichPolicyRule,
  EnrichScopeType,
  EnrichTrigger,
  ResolvedEnrichPolicy,
} from "../../enrich-policy.js";
import { relativeTime } from "../format.js";
import type { HarnessCardDTO } from "../screen-contracts.js";
import EmptyBlock from "../ui/EmptyBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import CapabilityRows from "./SettingsEnrichmentCapabilities.js";
import EnrichmentRules from "./SettingsEnrichmentRules.js";

import controlsCss from "../styles/controls.module.css";

export interface EnrichmentSettingsData {
  rules: EnrichPolicyRule[];
  profiles: EnrichEngineProfile[];
  consent: EnrichConsentRecord[];
  cards: HarnessCardDTO[];
  modelByHarness: Record<string, string>;
  effortByHarness: Record<string, string>;
  effective: Record<string, ResolvedEnrichPolicy | null>;
}

export interface EngineProfileInput {
  id: string;
  label: string;
  capability: string;
  harness: string;
  model?: string;
  configPins?: Record<string, string>;
}

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
  saveProfile: (input: EngineProfileInput) => Promise<void>;
  setEngineModel: (harness: string, modelId: string) => Promise<string | null>;
  setEngineEffort: (harness: string, value: string) => Promise<string | null>;
  setRule: (rule: EnrichRuleInput) => Promise<void>;
  deleteRule: (
    scope: EnrichScopeType,
    ref: string,
    capability: string
  ) => Promise<void>;
  showToast: (message: string) => void;
}

type Load =
  | { kind: "loading" }
  | { kind: "ready"; data: EnrichmentSettingsData }
  | { kind: "failed"; reason: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function consentRow(row: EnrichConsentRecord): RowDef {
  const declined = row.decision === "declined";
  return {
    id: `${row.capability}/${row.egress}`,
    title: capabilityLabel(row.capability),
    sub: declined
      ? "Declined · built-in engine only"
      : `May send work ${ENRICH_EGRESS_WORDS[row.egress]}`,
    meta: relativeTime(row.decidedAt),
    net: declined,
    off: true,
  };
}

export default function SettingsEnrichmentScreen({
  load: read,
  saveProfile,
  setEngineModel,
  setEngineEffort,
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
        const on = mine.filter(
          (profile) => data.effective[profile.capability]?.enabled === true
        ).length;
        return (
          <div key={domain}>
            <SectionBlock label={label} meta={`${on} of ${mine.length} on`} />
            <CapabilityRows
              builtIns={mine}
              profiles={data.profiles}
              rules={data.rules}
              effective={data.effective}
              cards={data.cards}
              modelByHarness={data.modelByHarness}
              effortByHarness={data.effortByHarness}
              setRule={setRule}
              saveProfile={saveProfile}
              setEngineModel={setEngineModel}
              setEngineEffort={setEngineEffort}
              showToast={showToast}
              onChanged={refresh}
            />
          </div>
        );
      })}

      <EnrichmentRules
        rules={data.rules}
        deleteRule={deleteRule}
        showToast={showToast}
        onChanged={refresh}
      />

      <SectionBlock
        label="Answers on record"
        meta={data.consent.length ? "asked once, kept" : "none yet"}
      />
      {data.consent.length === 0 ? (
        <EmptyBlock
          routine
          title="Nothing has needed to ask yet"
          body="These are the “may this send work to a provider” questions."
        />
      ) : (
        <RowsBlock
          ariaLabel="Answers on record"
          rows={data.consent.map(consentRow)}
        />
      )}
    </>
  );
}
