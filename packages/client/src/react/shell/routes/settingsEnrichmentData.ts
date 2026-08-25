import { ENRICH_CAPABILITY_DOMAIN } from "../../../enrich-policy.js";
import type {
  EnrichScopeType,
  ResolvedEnrichPolicy,
} from "../../../enrich-policy.js";
import {
  deleteEnrichRule,
  getEffectiveEnrichPolicy,
  getEnrichRules,
  listEnrichEgressConsent,
  listEnrichProfiles,
  saveUserPrefs,
  setEnrichRule,
} from "../../../gateway-client.js";
import type {
  EngineProfileInput,
  EnrichRuleInput,
  EnrichmentSettingsData,
} from "../../screens/SettingsEnrichmentScreen.js";
import { loadHarnesses } from "./settingsHarnessesData.js";

// Settings → Enrichment data layer (#807). Rules and egress live in the vault,
// engine profiles in gateway prefs; keep no second copy. Fold no cascade here
// — ask the gateway's resolver per capability, never compute from `rules`.

function profilePrefsKey(id: string): string {
  return `enrich.profile.${id}`;
}

export async function loadEnrichmentSettings(): Promise<EnrichmentSettingsData> {
  const [rules, profiles, consent, harnesses] = await Promise.all([
    getEnrichRules(),
    listEnrichProfiles(),
    listEnrichEgressConsent(),
    loadHarnesses(),
  ]);
  return {
    rules,
    profiles,
    consent,
    cards: harnesses.cards,
    modelByHarness: harnesses.savedModelByKind,
    effortByHarness: Object.fromEntries(
      Object.entries(harnesses.defaultConfigPinsByKind).map(
        ([kind, pins]) => [kind, pins["thought_level"] ?? ""] as const
      )
    ),
    effective: await readEffective(profiles.filter((one) => one.builtIn)),
  };
}

async function readEffective(
  builtIns: { capability: string }[]
): Promise<Record<string, ResolvedEnrichPolicy | null>> {
  const answers = await Promise.all(
    builtIns.map(async ({ capability }) => {
      const domain = ENRICH_CAPABILITY_DOMAIN[capability];
      if (!domain) return null;
      const answer = await getEffectiveEnrichPolicy({ capability, domain });
      return [capability, answer.effective] as const;
    })
  );
  return Object.fromEntries(
    answers.filter(
      (one): one is readonly [string, ResolvedEnrichPolicy | null] =>
        one !== null
    )
  );
}

/** `egress` is absent by refusal — the gateway computes it. */
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

/* No profile delete: it could strand a deeper-scope rule pinning it. */

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

export async function dropEnrichRule(
  scope: EnrichScopeType,
  ref: string,
  capability: string
): Promise<void> {
  await deleteEnrichRule(scope, ref, capability);
}
