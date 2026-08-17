import { ENRICH_CAPABILITY_DOMAIN } from "../../../enrich-policy.js";
import type {
  EnrichDomain,
  EnrichPolicy,
  EnrichScopeType,
  EnrichTier,
  ResolvedEnrichPolicy,
} from "../../../enrich-policy.js";
import {
  deleteEnrichRule,
  getEffectiveEnrichPolicy,
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
  return {
    policy,
    rules,
    profiles,
    consent,
    cards: harnesses.cards,
    effective: await readEffective(profiles.filter((one) => one.builtIn)),
  };
}

/**
 * What the gateway's resolver folds for each capability, ASKED PER CAPABILITY
 * because that is the shape the one resolver answers in.
 *
 * The screen needs "is this on" and "how far may it go", and both are folds of
 * the tier and the rule cascade. Computing them from the `policy` and `rules`
 * this module already holds would be a second fold — exactly the parallel
 * policy #807 is arranged to prevent — so it costs one request per capability
 * instead. The same trade is already made twice for the same stated reason:
 * `appSettingsData.ts` asks this resolver per capability for the app-settings
 * enrichment panel, and the phone's `lib/enrichment.ts` does it too.
 *
 * A capability whose domain this build does not know is left out of the map
 * rather than guessed at; the screen renders it without a switch and says so.
 */
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

/*
 * There is deliberately NO profile delete. A profile's id is now derived from
 * (capability, agent) by the row that picks it, so re-picking rewrites one key
 * instead of accumulating engines, and the set is bounded and invisible —
 * there is nothing for a member to tidy. Deleting one would also be the only
 * act on this page that can strand a rule at a deeper scope still pinning it,
 * which would silently move that scope back to the built-in engine.
 */

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
