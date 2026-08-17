import type { JSX } from "react";

import {
  ENRICH_CAPABILITY_BLURBS,
  ENRICH_CAPABILITY_NOTES,
  ENRICH_EGRESS_WORDS,
  ENRICH_TIER_WORDS,
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
import { Select } from "./SettingsHarnessesSelects.js";

import styles from "./SettingsEnrichmentScreen.module.css";

// Settings → Enrichment, THE CAPABILITY LIST (issue #807; reshaped after the
// page was read back and found unusable).
//
// WHY THE CAPABILITY IS THE ROW. The member's questions here are "what is
// Centraid doing with my things", "can I stop it", and "does any of it leave
// my devices". The stores answer in tiers, engine profiles, scoped rules and
// consent records — four objects, none of which is a thing anyone wants. This
// list is the projection back: one row per capability, carrying its plain name,
// what it gets you, a switch, and the computed fact of where its work goes.
//
// WHAT IS DELIBERATELY NOT OFFERED. Egress is computed by the gateway from the
// engine and is stated here, never set — a control that let a member call a
// provider engine "on-device" would be a lie the runtime would then honour.
// Model and effort pins are not offered either: Settings → Agents is where a
// harness's model is chosen, and asking the same question twice is what made
// this page an engine-configuration console instead of a privacy surface.
//
// THE ENGINE PICKER IS A CONSEQUENCE, NOT AN OBJECT. Only `ocr` and `doc-text`
// ship a delegate variant, so seven of nine rows have no choice to make and say
// so. On the two that do, picking an agent CREATES the engine profile behind
// the row — a member should never have to name an engine, which is a prefs-key
// suffix wearing a form field.

/**
 * The profile id a row's agent choice is stored under — derived, never typed.
 * Both halves are already slug-safe (a registry capability id and a harness
 * kind), which is what `PROFILE_ID_PATTERN` in the gateway's validator wants.
 */
function rowProfileId(capability: string, harness: string): string {
  return `${capability}-${harness}`;
}

export interface CapabilityRowsProps {
  /** The built-in profiles of the capabilities this panel lists, in order. */
  builtIns: EnrichEngineProfile[];
  /** Every profile the gateway offers, built-in and member-made. */
  profiles: EnrichEngineProfile[];
  rules: EnrichPolicyRule[];
  effective: Record<string, ResolvedEnrichPolicy | null>;
  cards: HarnessCardDTO[];
  /** This panel's domain, in the member's words — named in refusal notes. */
  domainLabel: string;
  setRule: (rule: EnrichRuleInput) => Promise<void>;
  saveProfile: (input: EngineProfileInput) => Promise<void>;
  showToast: (message: string) => void;
  onChanged: () => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why a row will not run despite its switch, or `null` when it will.
 *
 * MEASURED AGAINST THE BUILT-IN, NOT THE RUNNING PROFILE. The tier gate is
 * `rank(lane) <= rank(tier)` over the ENRICHER's declared lane
 * (`automation/fire/enrich-gate.ts`), and the built-in profile's computed
 * egress is exactly that lane — `on-device` or `gateway`, never `provider`.
 * A delegate profile's `provider` egress is not a tier question at all: it is
 * gated per call by egress consent (#567), which is what the badge and the
 * "Sharing you've been asked about" group are for. Comparing the delegate's
 * class here would mark every agent-backed row as refused, since no tier's
 * ceiling ever reaches `provider`.
 *
 * The runtime gate is still the authority and refuses on its own; this only
 * makes the refusal visible at the switch. Saying nothing is how "On this
 * device" came to silently stop every document capability.
 */
function refusalNote(
  builtIn: EnrichEngineProfile,
  resolved: ResolvedEnrichPolicy,
  domainLabel: string
): string | null {
  if (egressWithinCeiling(builtIn.egress, resolved.egressCeiling)) return null;
  if (resolved.egressCeiling === "off")
    return `Won’t run while ${domainLabel} is set to “${ENRICH_TIER_WORDS.off}”.`;
  // The only refusal left: a gateway-lane enricher under an on-device ceiling.
  // Short on purpose — a whole domain can be refused at once, and five copies
  // of a full explanation is a wall, not a warning.
  return `Won’t run — needs “${ENRICH_TIER_WORDS.gateway}”.`;
}

export default function CapabilityRows({
  builtIns,
  profiles,
  rules,
  effective,
  cards,
  domainLabel,
  setRule,
  saveProfile,
  showToast,
  onChanged,
}: CapabilityRowsProps): JSX.Element {
  /** What the vault's own layer already decides, so a write preserves the rest. */
  const vaultRule = (capability: string): EnrichPolicyRule | undefined =>
    rules.find(
      (rule) => rule.scope.type === "vault" && rule.capability === capability
    );

  /** One vault-scope write, carrying forward every answer it is not changing. */
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
        showToast(`Couldn’t change that: ${errorText(error)}`)
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

  return (
    <div className={styles.panel}>
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
        const refusal = resolved
          ? refusalNote(builtIn, resolved, domainLabel)
          : null;
        const note = ENRICH_CAPABILITY_NOTES[capability];

        return (
          <div className={styles.capRow} key={capability}>
            <label className={styles.capSwitch}>
              <input
                type="checkbox"
                aria-label={capabilityLabel(capability)}
                checked={resolved?.enabled === true}
                disabled={!resolved}
                onChange={(event) =>
                  write(capability, { enabled: event.target.checked })
                }
              />
            </label>

            <span className={styles.capText}>
              <span className={styles.capName}>
                {capabilityLabel(capability)}
              </span>
              <span className={styles.capBlurb}>
                {ENRICH_CAPABILITY_BLURBS[capability] ??
                  "This build does not describe this one yet."}
              </span>
            </span>

            {/* The computed fact, worn where a control would be if it were a
                choice. It is not one — see the header. */}
            <span className={styles.capWhere} data-egress={running.egress}>
              {ENRICH_EGRESS_WORDS[running.egress]}
            </span>

            <span className={styles.capEngine}>
              {builtIn.delegateCapable ? (
                <Select
                  value={harness}
                  ariaLabel={`Engine for ${capabilityLabel(capability)}`}
                  onChange={(next) => pickEngine(capability, next)}
                >
                  <option value="">Built in</option>
                  {cards.map((card) => (
                    <option
                      key={card.kind}
                      value={card.kind}
                      disabled={!card.connected}
                    >
                      {card.connected
                        ? card.title
                        : `${card.title} · unavailable`}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className={styles.capBuiltIn}>Built in</span>
              )}
            </span>

            {refusal ? (
              <span className={styles.capRefusal} role="note">
                {refusal}
              </span>
            ) : null}
            {note ? <span className={styles.capNote}>{note}</span> : null}
            {resolved ? null : (
              <span className={styles.capRefusal} role="note">
                Your gateway offers this, but this build has no words for it —
                it can’t be switched here.
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
