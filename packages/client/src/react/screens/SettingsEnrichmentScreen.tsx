import { useEffect, useState } from "react";
import type { JSX } from "react";

import type {
  EnrichDomain,
  EnrichPolicy,
  EnrichTier,
} from "../../enrich-policy.js";
import { ENRICH_DOMAINS } from "../../enrich-policy.js";
import { DrawerGroup, DrawerRow, Segmented } from "./settings-controls.js";

import styles from "./SettingsEnrichmentScreen.module.css";

/*
 * Settings → Enrichment — the owner's control over the per-domain enrichment
 * tier (`core_vault.settings_json.enrich`, mirrored into `enrich_policy`).
 *
 * WHY THIS PAGE EXISTS. The tier is enforced on the execution path
 * (`packages/automation/src/fire/enrich-gate.ts`): under `local` — the seeded
 * default — every enricher that takes a model turn is refused before it
 * starts. Until this page there was no way to change the tier from any client
 * surface at all, so the enforcement had no counterpart: a member could ask
 * for face proposals and simply never get them, with the owner holding no
 * control that would let them.
 *
 * WHY THE COPY READS THE WAY IT DOES. The gate's header states the strictest
 * honest reading of `local`: there is NO local model provider in this runtime.
 * Every runner in the registry is a coding-agent harness talking to a remote
 * provider, and the gateway's own process is not "local" for this promise —
 * it is the thing that performs the egress. So `local` is "deterministic and
 * device-lease work only", never "runs a model on your machine", and this
 * page must not imply otherwise. Raising a domain to `model` is a CONSENT act
 * — it permits photographs and documents to leave the member's devices — so
 * it is confirmed in plain words BEFORE the write, not announced after it.
 *
 * SCOPE NAMING (#599 / decision S6). The tier is authored per SCOPE and
 * applies to every app mounted over that scope, so the copy names the scope by
 * its human label rather than saying "this vault" — the label is what the
 * member sees in the switcher, and the generic phrase would be ambiguous the
 * moment a household has more than one scope.
 */

const TIERS: readonly EnrichTier[] = ["off", "local", "model"];

const TIER_LABELS: Record<EnrichTier, string> = {
  local: "On your devices",
  model: "Model provider",
  off: "Off",
};

/**
 * What each tier ACTUALLY does, grounded in `decideEnrichmentGate`. The
 * `local` line names the enrichers it stops rather than leaving the member to
 * discover the silence — that silence is the defect this page closes.
 */
const TIER_MEANING: Record<EnrichTier, string> = {
  local:
    "Only work that stays on your own devices: duplicate fingerprints, grouping, " +
    "and text your phone or laptop recognises itself. Nothing is sent to a model " +
    "provider. Centraid has no on-device model, so captions, face proposals, and " +
    "document extraction do not run at this setting.",
  model:
    "Everything above, plus enrichment that takes a model turn. Every model turn " +
    "in Centraid goes to a remote provider over the network, so the photograph or " +
    "document itself leaves your devices each time one runs.",
  off: "Nothing runs. No captions, no grouping, no text extraction, no fingerprints.",
};

interface DomainCopy {
  label: string;
  hint: (scopeLabel: string) => string;
  /** What the member sees leave the device at the `model` tier. */
  sentNoun: string;
}

const DOMAIN_COPY: Record<EnrichDomain, DomainCopy> = {
  docs: {
    hint: (scope) =>
      `Text extraction, filing, entity links, and obligations for documents in ${scope}.`,
    label: "Documents",
    sentNoun: "the document",
  },
  photos: {
    hint: (scope) =>
      `Captions, face proposals, and screenshot text for photographs in ${scope}.`,
    label: "Photographs",
    sentNoun: "the photograph",
  },
};

/**
 * The question asked before a domain is raised to `model`. Stated in the
 * present tense and BEFORE the write, because this is the sentence that turns
 * "my photos never leave this house" into "my photos are sent to a company".
 */
export function egressConsentCopy(
  domain: EnrichDomain,
  scopeLabel: string
): { title: string; message: string; confirmLabel: string } {
  const copy = DOMAIN_COPY[domain];
  return {
    confirmLabel: "Allow sending",
    message:
      `Centraid has no on-device model. At this setting, enrichment for ` +
      `${copy.label.toLowerCase()} in ${scopeLabel} sends ${copy.sentNoun} itself over ` +
      `the network to the model provider configured under Settings → Agents, every ` +
      `time it runs.\n\n` +
      `Nothing has been sent yet — this takes effect on the next enrichment run, and ` +
      `you can set it back to “On your devices” at any time.`,
    title: `Send ${copy.label.toLowerCase()} in ${scopeLabel} to a model provider?`,
  };
}

export interface SettingsEnrichmentScreenProps {
  /** The active scope's human label — the name the switcher shows. */
  scopeLabel: string;
  loadPolicy: () => Promise<EnrichPolicy>;
  /**
   * Write one domain's tier. Resolves with the tiers that ACTUALLY took
   * effect (the route reads the vault back), so the control can only ever
   * render a state the vault is really in.
   */
  setTier: (domain: EnrichDomain, tier: EnrichTier) => Promise<EnrichPolicy>;
  /** The consent gate for `model`. Resolves false when the member declines. */
  confirmEgress: (input: {
    title: string;
    message: string;
    confirmLabel: string;
  }) => Promise<boolean>;
  showToast: (message: string) => void;
}

export default function SettingsEnrichmentScreen({
  scopeLabel,
  loadPolicy,
  setTier,
  confirmEgress,
  showToast,
}: SettingsEnrichmentScreenProps): JSX.Element {
  // `null` while the first read is in flight. There is deliberately no
  // optimistic default: rendering "local" before the vault answered would
  // show a privacy state that may not be the member's, which is exactly the
  // class of lie this page exists to stop.
  const [policy, setPolicy] = useState<EnrichPolicy | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busyDomain, setBusyDomain] = useState<EnrichDomain | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await loadPolicy();
        if (!cancelled) setPolicy(next);
      } catch (error: unknown) {
        // Surfaced, never swallowed: a page that could not read the tier must
        // say so rather than render a control over a state it does not know.
        if (!cancelled)
          setReadError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadPolicy]);

  const choose = (domain: EnrichDomain, next: EnrichTier): void => {
    if (busyDomain !== null || policy === null) return;
    if (policy[domain] === next) return;
    void (async () => {
      // The consent question is asked BEFORE the write, and only for the tier
      // that permits egress. Declining leaves the vault untouched — the
      // control re-renders from `policy`, which never moved.
      if (next === "model") {
        const agreed = await confirmEgress(
          egressConsentCopy(domain, scopeLabel)
        );
        if (!agreed) return;
      }
      setBusyDomain(domain);
      try {
        setPolicy(await setTier(domain, next));
        showToast(
          `${DOMAIN_COPY[domain].label} enrichment · ${TIER_LABELS[next]}`
        );
      } catch (error: unknown) {
        // Left visible rather than swallowed: a failed write means the tier
        // the member just picked is NOT the tier in force, and the control
        // keeps showing the tier that is.
        showToast(
          `Couldn’t change enrichment: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        setBusyDomain(null);
      }
    })();
  };

  if (readError !== null) {
    return (
      <p className={styles.status} role="alert">
        Couldn’t read the enrichment setting for {scopeLabel}: {readError}
      </p>
    );
  }
  if (policy === null) {
    return <p className={styles.status}>Reading {scopeLabel}’s setting…</p>;
  }

  return (
    <>
      {ENRICH_DOMAINS.map((domain) => {
        const current = policy[domain];
        return (
          <DrawerGroup key={domain} label={DOMAIN_COPY[domain].label}>
            <DrawerRow
              full
              label={`Enrichment for ${DOMAIN_COPY[domain].label.toLowerCase()}`}
              hint={DOMAIN_COPY[domain].hint(scopeLabel)}
            >
              <Segmented
                ariaLabel={`Enrichment for ${DOMAIN_COPY[domain].label.toLowerCase()} in ${scopeLabel}`}
                labels={TIER_LABELS}
                options={TIERS}
                selected={current}
                onSelect={(next) => choose(domain, next)}
              />
              <ul className={styles.tiers}>
                {TIERS.map((tier) => (
                  <li
                    key={tier}
                    className={styles.tier}
                    data-current={String(tier === current)}
                    data-testid={`enrich-${domain}-${tier}`}
                  >
                    <span className={styles.tierName}>
                      {TIER_LABELS[tier]}
                      {tier === current ? " · in force" : ""}
                    </span>
                    <span>{TIER_MEANING[tier]}</span>
                  </li>
                ))}
              </ul>
              {busyDomain === domain ? (
                <p className={styles.status}>Saving…</p>
              ) : null}
            </DrawerRow>
          </DrawerGroup>
        );
      })}
    </>
  );
}
