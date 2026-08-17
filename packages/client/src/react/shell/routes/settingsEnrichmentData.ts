import type {
  EnrichDomain,
  EnrichPolicy,
  EnrichScopeType,
  EnrichTier,
} from "../../../enrich-policy.js";
import {
  deleteEnrichRule,
  getEnrichPolicy,
  getEnrichRules,
  listEnrichEgressConsent,
  listEnrichProfiles,
  saveUserPrefs,
  setEnrichPolicy,
  setEnrichRule,
} from "../../../gateway-client.js";
import type {
  EngineProfileInput,
  EnrichRuleInput,
  EnrichmentSettingsData,
} from "../../screens/SettingsEnrichmentScreen.js";
import { loadHarnesses } from "./settingsHarnessesData.js";

// Settings → Enrichment data layer (issue #807).
//
// ONE WRITER PER PATH, and this module is where that shows: tiers, scoped
// rules and egress answers are VAULT state and go through the owner's
// `/_vault/enrich*` routes; engine profiles are GATEWAY configuration and go
// through the prefs API as `enrich.profile.<id>`, where the single validator
// lives (a 409 comes back with the reason, which the screen shows verbatim).
// Nothing here keeps a second copy of either store, and nothing folds the
// cascade — the gateway's one resolver answers that.
//
// The harness cards come from `loadHarnesses`, the Agents page's own loader,
// so a delegate profile picks its agent and model from the same snapshot
// Settings → Agents shows rather than from a second probe of the same truth.

/** The prefs key one engine profile is stored at. */
function profilePrefsKey(id: string): string {
  return `enrich.profile.${id}`;
}

/** Everything the page renders, read in one pass. */
export async function loadEnrichmentSettings(): Promise<EnrichmentSettingsData> {
  const [policy, rules, profiles, consent, harnesses] = await Promise.all([
    getEnrichPolicy(),
    getEnrichRules(),
    listEnrichProfiles(),
    listEnrichEgressConsent(),
    loadHarnesses(),
  ]);
  return { policy, rules, profiles, consent, cards: harnesses.cards };
}

/** Write one domain's tier; resolves with the tiers the vault holds after. */
export async function setDomainTier(
  domain: EnrichDomain,
  tier: EnrichTier
): Promise<EnrichPolicy> {
  return setEnrichPolicy({ [domain]: tier });
}

/**
 * Create or replace one member profile. The value is the stored shape the
 * gateway validates (`engine-profiles.ts`), and `egress` is deliberately absent
 * — it is computed there, and sending one is a refusal, not a preference.
 */
export async function saveEngineProfile(
  input: EngineProfileInput
): Promise<void> {
  await saveUserPrefs({
    [profilePrefsKey(input.id)]: JSON.stringify({
      capability: input.capability,
      label: input.label,
      harness: input.harness,
      ...(input.model ? { model: input.model } : {}),
      ...(input.configPins ? { configPins: input.configPins } : {}),
    }),
  });
}

/** Drop one member profile. Built-ins have no key, so none can be deleted. */
export async function deleteEngineProfile(id: string): Promise<void> {
  await saveUserPrefs({ [profilePrefsKey(id)]: null });
}

/** Write one scope's rule for one capability. */
export async function writeEnrichRule(rule: EnrichRuleInput): Promise<void> {
  await setEnrichRule({
    scope: rule.scope,
    ref: rule.ref,
    capability: rule.capability,
    enabled: rule.enabled,
    profile: rule.profile,
    trigger: rule.trigger,
  });
}

/** Drop one scope's rule — that scope stops deciding, and inherits again. */
export async function dropEnrichRule(
  scope: EnrichScopeType,
  ref: string,
  capability: string
): Promise<void> {
  await deleteEnrichRule(scope, ref, capability);
}
