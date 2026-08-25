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

// Settings → Enrichment, THE CAPABILITY LIST (#807; reshaped again for
// the v11 binding layer).
//
// WHY THE CAPABILITY IS THE ROW. The member's questions here are "what is
// Centraid doing with my things", "can I stop it", and "does any of it leave
// my devices". The stores answer in ceilings, engine profiles, scoped rules and
// consent records — four objects, none of which is a thing anyone wants. This
// list is the projection back: one row per capability, carrying its plain name,
// what it gets you, a switch, and the one fact worth stating.
//
// WHERE THE WORK RUNS IS NOT A CHOICE, so it is not a control and not a label.
// Enrichment runs on the gateway; the per-domain ceiling control is gone. The
// one fact still stated is EGRESS: a delegated row reads "at a provider",
// computed by the gateway from the engine and never settable here. A control
// that let a member call a provider engine "on-device" would be a lie the
// runtime would then honour.
//
// THE ENGINE IS EXPERT MACHINERY FOR TWO ROWS OUT OF NINE, so it collapses
// behind one pill beside the switch. Pressing the pill reveals the engine chips
// and a model/level row that writes the SAME gateway prefs Settings → Agents
// writes — one pin per (harness, slot), never a second copy of the same answer.
// The pill is absent on a row that is switched OFF: a row that reads nothing
// has no "what reads it" to answer yet.
//
// THE ROW READS LEFT TO RIGHT AS ITS OWN SENTENCE: what this is, where its work
// goes, what reads it, and last whether it runs. A leading switch would put the
// commit ahead of its subject and push the description into the middle of the
// row.

/**
 * The profile id a row's agent choice is stored under — derived, never typed.
 * Both halves are already slug-safe (a registry capability id and a harness
 * kind), which is what `PROFILE_ID_PATTERN` in the gateway's validator wants.
 */
function rowProfileId(capability: string, harness: string): string {
  return `${capability}-${harness}`;
}

/** The egress fact this row states. Only a provider is worth a member's eye. */
const PROVIDER_EGRESS_WORD = "at a provider";

export interface CapabilityRowsProps {
  /** The built-in profiles of the capabilities this panel lists, in order. */
  builtIns: EnrichEngineProfile[];
  /** Every profile the gateway offers, built-in and member-made. */
  profiles: EnrichEngineProfile[];
  rules: EnrichPolicyRule[];
  effective: Record<string, ResolvedEnrichPolicy | null>;
  cards: HarnessCardDTO[];
  /** The Agents page's own model pin per harness — shared, not copied. */
  modelByHarness: Record<string, string>;
  /** The Agents page's own level pin per harness — shared, not copied. */
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

/**
 * Why a row will not run despite its switch, or `null` when it will.
 *
 * THE CEILING IS NO LONGER A CONTROL, BUT IT IS STILL A GATE. The vault keeps a
 * stored ceiling per domain and the runtime still refuses under it
 * (`automation/fire/enrich-gate.ts`). Removing the control without keeping this
 * note would strand a member whose stored ceiling silently stops a row — which
 * is exactly how "On this device" once stopped every document capability with
 * nothing on screen admitting it.
 *
 * MEASURED AGAINST THE BUILT-IN, NOT THE RUNNING PROFILE. The gate compares the
 * ENRICHER's declared lane, and the built-in profile's computed egress is
 * exactly that lane — `on-device` or `gateway`, never `provider`. A delegate's
 * `provider` egress is not a ceiling question at all: it is gated per call by
 * egress consent (#567).
 */
function refusalNote(
  builtIn: EnrichEngineProfile,
  resolved: ResolvedEnrichPolicy
): string | null {
  if (egressWithinCeiling(builtIn.egress, resolved.egressCeiling)) return null;
  return `Stopped by a stored ceiling: ${ENRICH_CEILING_WORDS[resolved.egressCeiling]}.`;
}

/**
 * The engine pill's own words: what reads this row. The bundled engine names
 * itself; an agent names itself and the level it will think at, lowercase,
 * because the pill is a statement of fact rather than the level control's own
 * label (that control is the one inside the pill, once it is pressed).
 */
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
  /** Which row currently has its engine open. One at a time, or none. */
  const [openEngine, setOpenEngine] = useState<string | null>(null);

  /** What the vault's own layer already decides, so a write preserves the rest. */
  const vaultRule = (capability: string): EnrichPolicyRule | undefined =>
    rules.find(
      (rule) => rule.scope.type === "vault" && rule.capability === capability
    );

  /**
   * One vault-scope write, carrying forward every answer it is not changing.
   * The row renders the RESOLVER's answer, never a local optimistic copy, so a
   * refused write leaves the switch exactly where the gateway has it and the
   * gateway's own text goes to the status line.
   */
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

  /**
   * Bind a row to an agent, or back to the bundled engine. The profile is
   * created here rather than authored by the member: its id is derived from
   * (capability, agent) so re-picking the same agent rewrites one key instead
   * of accumulating a second engine that means the same thing.
   */
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
        // THE ENGINE IS A CONTROL FOR A ROW THAT IS RUNNING. A row switched off
        // reads nothing, so what would read it is not a question yet: the pill
        // is absent rather than offering a choice with no effect until the
        // switch beside it moves.
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

              {/* The computed fact, worn where a control would be if it were a
                  choice. It is not one — see the header. */}
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

              {/* THE SWITCH IS THE ROW'S TRAILING EDGE. It reads last because
                  everything before it is what the member is deciding about;
                  leading it put the commit before its own subject. */}
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
                // A capability the gateway offers and this build has no words
                // for: stated, never a switch that would write a guess.
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
                  {/* The engine's model IS the Agents page's pin. Stating that
                      here is what stops a member setting it twice and reading
                      the second answer as a conflict. */}
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
