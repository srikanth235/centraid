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

// Settings → Enrichment (issue #807) — the one place the whole enrichment
// policy is authored, and a PROJECTION of two stores rather than a third one:
// tiers, scoped rules and egress answers live in the vault; engine profiles
// live in gateway prefs. Every control below writes through the owner route
// that already owns its path and re-renders what came back, so a refused write
// can never show as applied.
//
// THE PAGE IS ORGANISED BY THE MEMBER'S QUESTION, NOT BY THE STORES. It used to
// be four groups named after four objects — ceilings, engines, scoped rules,
// egress answers — which is the schema wearing a UI. Nobody arrives wanting to
// name an engine. They arrive asking: what is this doing with my photos, can I
// stop it, and does any of it leave my devices. So each DOMAIN is a group whose
// head counts its own rows, and each row is a plain name, a switch, and the one
// fact worth stating.
//
// THE PER-DOMAIN CEILING CONTROL IS GONE (v11 handoff, "Deliberate
// relocations"): enrichment always runs on the gateway, and where it runs is
// not a member's choice, so it is not offered as one. The vault's stored
// ceiling still gates the runtime, so a row it stops still says so — removing
// the control must not turn a refusal back into silence.
//
// The two remaining groups are the ones that answer a different question:
// exceptions (places you decided differently, listed only when some exist), and
// the record of what you have already been asked about sharing.

/** Everything the page renders, read in one pass. */
export interface EnrichmentSettingsData {
  rules: EnrichPolicyRule[];
  profiles: EnrichEngineProfile[];
  consent: EnrichConsentRecord[];
  /** The harnesses this gateway can run — the row engine pickers' options. */
  cards: HarnessCardDTO[];
  /** Settings → Agents' own model pin per harness. Shared, never a second copy. */
  modelByHarness: Record<string, string>;
  /** Settings → Agents' own level pin per harness. Shared, never a second copy. */
  effortByHarness: Record<string, string>;
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
  saveProfile: (input: EngineProfileInput) => Promise<void>;
  /** Write the harness model pin Settings → Agents reads; the gateway's text on refusal. */
  setEngineModel: (harness: string, modelId: string) => Promise<string | null>;
  /** Write the harness level pin Settings → Agents reads; the gateway's text on refusal. */
  setEngineEffort: (harness: string, value: string) => Promise<string | null>;
  setRule: (rule: EnrichRuleInput) => Promise<void>;
  deleteRule: (
    scope: EnrichScopeType,
    ref: string,
    capability: string
  ) => Promise<void>;
  showToast: (message: string) => void;
}

/** What the gateway answered, or why it could not. */
type Load =
  | { kind: "loading" }
  | { kind: "ready"; data: EnrichmentSettingsData }
  /** `reason` is the underlying failure, stated rather than smoothed over. */
  | { kind: "failed"; reason: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One recorded egress answer as a row — a receipted fact, never a control.
 *
 * `off` is what says so: the row is present, readable and inert, and it carries
 * no verb, because the answer is on the record and this page cannot rewrite the
 * record. A declined answer is `net`: the question it answered was whether work
 * may leave the member's own machines.
 */
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
