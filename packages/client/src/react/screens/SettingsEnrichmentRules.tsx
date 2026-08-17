import type { JSX } from "react";

import { ENRICH_TRIGGER_WORDS, capabilityLabel } from "../../enrich-policy.js";
import type { EnrichPolicyRule, EnrichScopeType } from "../../enrich-policy.js";
import Button from "../ui/Button.js";
import { DrawerGroup } from "./settings-controls.js";

import controlsCss from "../styles/controls.module.css";
import styles from "./SettingsEnrichmentScreen.module.css";

// Settings → Enrichment, EXCEPTIONS (issue #807).
//
// A rule says what ONE scope decides about ONE capability; everything it leaves
// unset is inherited, and the gateway's single resolver folds the chain. This
// group lists the rules deeper than the vault default and lets one be dropped.
// Nothing is folded here — a second fold on this side is exactly the parallel
// policy the cascade exists to prevent.
//
// VAULT-SCOPE RULES ARE NOT LISTED, because they are not exceptions: they are
// the switches on the capability rows above, and showing them again as rows
// would be the same decision rendered twice in two vocabularies.
//
// AUTHORING MOVED OUT, deliberately. This group used to carry a form whose
// scope reference was a free-text `type:ref` field — the module's own comment
// admitted no picker enumerated collections, so the control could only be
// filled by someone reading the vault schema. An exception is an in-situ
// decision ("don't read faces in this album") and belongs on the album; this
// group is where the ones that exist are reviewed and revoked.
// TODO(#814): offer the exception at the collection itself, then link to it here.

/** How a rule's decision reads when it is set, and when it inherits. */
function ruleSummary(rule: EnrichPolicyRule): string {
  const parts = [
    rule.enabled === null ? "inherits" : rule.enabled ? "on" : "off",
  ];
  if (rule.profile) parts.push(rule.profile);
  if (rule.trigger) parts.push(ENRICH_TRIGGER_WORDS[rule.trigger]);
  return parts.join(" · ");
}

export interface EnrichmentRulesProps {
  rules: EnrichPolicyRule[];
  deleteRule: (
    scope: EnrichScopeType,
    ref: string,
    capability: string
  ) => Promise<void>;
  showToast: (message: string) => void;
  onChanged: () => void;
}

export default function EnrichmentRules({
  rules,
  deleteRule,
  showToast,
  onChanged,
}: EnrichmentRulesProps): JSX.Element | null {
  const exceptions = rules.filter((rule) => rule.scope.type !== "vault");
  // No group at all rather than an empty one: a heading over "nothing here" is
  // a concept the member has to learn before finding out it does not apply.
  if (exceptions.length === 0) return null;

  return (
    <DrawerGroup label="Exceptions">
      <div className={controlsCss.note}>
        Places where you answered differently from the defaults above.
      </div>
      <div className={styles.panel}>
        {exceptions.map((rule) => (
          <div
            className={styles.row}
            key={`${rule.scope.type}:${rule.scope.ref}/${rule.capability}`}
          >
            <span className={styles.rowName}>
              {capabilityLabel(rule.capability)}
            </span>
            <span className={styles.rowMeta}>
              {rule.scope.type}
              {rule.scope.ref ? ` · ${rule.scope.ref}` : ""} ·{" "}
              {ruleSummary(rule)}
            </span>
            <Button
              variant="quiet"
              size="sm"
              label="Remove"
              onClick={() => {
                void deleteRule(
                  rule.scope.type,
                  rule.scope.ref,
                  rule.capability
                )
                  .then(onChanged)
                  .catch((error: unknown) =>
                    showToast(
                      `Couldn’t remove that exception: ${error instanceof Error ? error.message : String(error)}`
                    )
                  );
              }}
            />
          </div>
        ))}
      </div>
    </DrawerGroup>
  );
}
