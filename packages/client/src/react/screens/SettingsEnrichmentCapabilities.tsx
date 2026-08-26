import { useState } from "react";
import type { JSX } from "react";

import {
  ENRICH_CAPABILITY_BLURBS,
  ENRICH_CAPABILITY_NOTES,
  ENRICH_CEILING_WORDS,
  capabilityLabel,
  egressWithinCeiling,
} from "../../enrich-policy.js";
import type {
  EnrichEngineProfile,
  EnrichPolicyRule,
  ResolvedEnrichPolicy,
} from "../../enrich-policy.js";
import type { HarnessCardDTO } from "../screen-contracts.js";
import type {
  EngineProfileInput,
  EnrichRuleInput,
} from "./SettingsEnrichmentScreen.js";
import {
  ConfigSelect,
  ModelSelect,
  effortLabel,
  modelLabel,
} from "./SettingsHarnessesSelects.js";

import styles from "./SettingsEnrichmentScreen.module.css";

// Settings → Enrichment, THE CAPABILITY LIST (#807): one row per capability
// over the ceilings, profiles, scoped rules and consent records. WHERE THE WORK
// RUNS IS NOT A CHOICE — the only fact stated is EGRESS, computed from the
// engine and never settable here. THE ENGINE hides behind a pill writing the
// SAME gateway prefs Settings → Agents writes (one pin per harness+slot).

/** Derived, never typed: slug-safe for `PROFILE_ID_PATTERN`. */
function rowProfileId(capability: string, harness: string): string {
  return `${capability}-${harness}`;
}

/** Only a provider is worth a member's eye. */
const PROVIDER_EGRESS_WORD = "at a provider";

export interface CapabilityRowsProps {
  builtIns: EnrichEngineProfile[];
  profiles: EnrichEngineProfile[];
  rules: EnrichPolicyRule[];
  effective: Record<string, ResolvedEnrichPolicy | null>;
  cards: HarnessCardDTO[];
  /** The Agents page's pins — shared, never copied. */
  modelByHarness: Record<string, string>;
  effortByHarness: Record<string, string>;
  setRule: (rule: EnrichRuleInput) => Promise<void>;
  saveProfile: (input: EngineProfileInput) => Promise<void>;
  setEngineModel: (harness: string, modelId: string) => Promise<string | null>;
  setEngineEffort: (harness: string, value: string) => Promise<string | null>;
  showToast: (message: string) => void;
  onChanged: () => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** THE CEILING IS NO LONGER A CONTROL BUT IS STILL A GATE: the runtime refuses
 *  under it (`automation/fire/enrich-gate.ts`), so without this note a stopped
 *  row says nothing. Measure the BUILT-IN's lane — a delegate's `provider`
 *  egress is gated by consent (#567). */
function refusalNote(
  builtIn: EnrichEngineProfile,
  resolved: ResolvedEnrichPolicy
): string | null {
  if (egressWithinCeiling(builtIn.egress, resolved.egressCeiling)) return null;
  return `Stopped by a stored ceiling: ${ENRICH_CEILING_WORDS[resolved.egressCeiling]}.`;
}

function engineSummary(
  card: HarnessCardDTO | undefined,
  effort: string
): string {
  if (!card) return "Built in";
  return effort
    ? `${card.title} · ${effortLabel(card, effort).toLowerCase()}`
    : card.title;
}

export default function CapabilityRows({
  builtIns,
  profiles,
  rules,
  effective,
  cards,
  modelByHarness,
  effortByHarness,
  setRule,
  saveProfile,
  setEngineModel,
  setEngineEffort,
  showToast,
  onChanged,
}: CapabilityRowsProps): JSX.Element {
  const [openEngine, setOpenEngine] = useState<string | null>(null);

  /** What the vault layer already decides. */
  const vaultRule = (capability: string): EnrichPolicyRule | undefined =>
    rules.find(
      (rule) => rule.scope.type === "vault" && rule.capability === capability
    );

  /** The row renders the RESOLVER's answer, never an optimistic copy. */
  const write = (
    capability: string,
    patch: Partial<Pick<EnrichRuleInput, "enabled" | "profile">>
  ): void => {
    const held = vaultRule(capability);
    void setRule({
      scope: "vault",
      ref: "",
      capability,
      enabled: held?.enabled ?? null,
      profile: held?.profile ?? null,
      trigger: held?.trigger ?? null,
      ...patch,
    })
      .then(onChanged)
      .catch((error: unknown) =>
        showToast(`${errorText(error)} — the switch is back where it was`)
      );
  };

  /** The derived id means re-picking an agent rewrites one key, never two. */
  const pickEngine = (capability: string, harness: string): void => {
    if (harness === "") {
      write(capability, { profile: null });
      return;
    }
    const card = cards.find((one) => one.kind === harness);
    const id = rowProfileId(capability, harness);
    void saveProfile({
      id,
      label: card?.title ?? harness,
      capability,
      harness,
    })
      .then(() => write(capability, { profile: id }))
      .catch((error: unknown) =>
        showToast(`Couldn’t use that agent: ${errorText(error)}`)
      );
  };

  /** The Agents page's pin, written from here — same key, one answer. */
  const writeEnginePin = (
    what: string,
    result: Promise<string | null>
  ): void => {
    void result.then((refusal) => {
      if (refusal) showToast(`${what} not saved: ${refusal}`);
      else onChanged();
    });
  };

  return (
    <div className={styles.capList}>
      {builtIns.map((builtIn) => {
        const capability = builtIn.capability;
        const resolved = effective[capability];
        const running =
          profiles.find(
            (one) =>
              one.capability === capability && one.id === resolved?.profileId
          ) ?? builtIn;
        const harness =
          running.engine.kind === "delegate" ? running.engine.harness : "";
        const card = cards.find((one) => one.kind === harness);
        const refusal = resolved ? refusalNote(builtIn, resolved) : null;
        const note = ENRICH_CAPABILITY_NOTES[capability];
        const effort = harness ? (effortByHarness[harness] ?? "") : "";
        const engineOpen =
          builtIn.delegateCapable && resolved?.enabled === true;
        const open = engineOpen && openEngine === capability;

        return (
          <div className={styles.capRow} key={capability}>
            <div className={styles.capMain}>
              <span className={styles.capText}>
                <span className={styles.capName}>
                  {capabilityLabel(capability)}
                </span>
                <span className={styles.capBlurb}>
                  {ENRICH_CAPABILITY_BLURBS[capability] ??
                    "Offered by your gateway; this build has no words for it."}
                  {note ? ` ${note}` : ""}
                </span>
              </span>

              {/* A computed fact, not a choice — see the header. */}
              {running.egress === "provider" ? (
                <span className={styles.capWhere} data-egress="provider">
                  {PROVIDER_EGRESS_WORD}
                </span>
              ) : null}

              {engineOpen ? (
                <button
                  type="button"
                  className={styles.capPill}
                  data-open={String(open)}
                  aria-expanded={open}
                  onClick={() => setOpenEngine(open ? null : capability)}
                >
                  {engineSummary(card, effort)}
                  <span className={styles.capCaret} aria-hidden="true">
                    {open ? "⌃" : "⌄"}
                  </span>
                </button>
              ) : null}

              {/* The switch is the row's TRAILING edge; never lead with it. */}
              {resolved ? (
                <label className={styles.capSwitch}>
                  <input
                    type="checkbox"
                    aria-label={capabilityLabel(capability)}
                    checked={resolved.enabled}
                    onChange={(event) =>
                      write(capability, { enabled: event.target.checked })
                    }
                  />
                  <span className={styles.capSwitchTrack} aria-hidden="true" />
                </label>
              ) : (
                // No words for it in this build: state it, never guess a switch.
                <span className={styles.capLock}>no vocabulary</span>
              )}
            </div>

            {refusal ? (
              <span className={styles.capRefusal} role="note">
                {refusal}
              </span>
            ) : null}

            {open ? (
              <div className={styles.capEngine}>
                <span className={styles.capEngineLabel}>Reads with</span>
                <button
                  type="button"
                  className={styles.capChip}
                  data-on={String(harness === "")}
                  onClick={() => pickEngine(capability, "")}
                >
                  Built in
                </button>
                {cards.map((one) => (
                  <button
                    key={one.kind}
                    type="button"
                    className={styles.capChip}
                    data-on={String(one.kind === harness)}
                    data-off={String(!one.connected)}
                    disabled={!one.connected}
                    onClick={() => pickEngine(capability, one.kind)}
                  >
                    {one.title}
                  </button>
                ))}
              </div>
            ) : null}

            {open && card ? (
              <div className={styles.capModelRow}>
                <span className={styles.capModelText}>
                  <span className={styles.capModelLabel}>Model and level</span>
                  {/* Say it IS the Agents pin, or two answers read as one. */}
                  <span className={styles.capModelCaption}>
                    Auto-saved · also the model on Agents
                  </span>
                </span>
                <span className={styles.capModelPicks}>
                  <ModelSelect
                    card={card}
                    saved={modelByHarness[card.kind] ?? ""}
                    onChange={(next) =>
                      writeEnginePin("Model", setEngineModel(card.kind, next))
                    }
                    emptyLabel={`Use default · ${modelLabel(card, "")}`}
                    ariaLabel={`Model for ${capabilityLabel(capability)}`}
                  />
                  <ConfigSelect
                    card={card}
                    category="thought_level"
                    saved={effort}
                    onChange={(next) =>
                      writeEnginePin("Level", setEngineEffort(card.kind, next))
                    }
                    emptyLabel="Use default · agent level"
                    ariaLabel={`Level for ${capabilityLabel(capability)}`}
                  />
                </span>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
