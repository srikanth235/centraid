import type { JSX } from "react";

import { ENRICH_TRIGGER_WORDS, capabilityLabel } from "../../enrich-policy.js";
import type { EnrichPolicyRule, EnrichScopeType } from "../../enrich-policy.js";
import NoteBlock from "../ui/NoteBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";

// EXCEPTIONS (#807): rules deeper than the vault default, listed not folded.
// Vault-scope rules ARE the switches above, never repeated here. No authoring form.
// TODO(#814): offer the exception at the collection itself, then link to it here.

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
  if (exceptions.length === 0) return null;

  // Scope is the row's subject; capability + decision are the second line.
  const rows: RowDef[] = exceptions.map((rule) => ({
    id: `${rule.scope.type}:${rule.scope.ref}/${rule.capability}`,
    title: rule.scope.ref
      ? `${rule.scope.type} · ${rule.scope.ref}`
      : rule.scope.type,
    sub: `${capabilityLabel(rule.capability)} · ${ruleSummary(rule)}`,
    dangerous: true,
    action: {
      label: "Remove",
      hint: `Remove the ${capabilityLabel(rule.capability)} exception on ${rule.scope.ref || rule.scope.type}`,
      onClick: () => {
        void deleteRule(rule.scope.type, rule.scope.ref, rule.capability)
          .then(onChanged)
          .catch((error: unknown) =>
            showToast(
              `Couldn’t remove that exception: ${error instanceof Error ? error.message : String(error)}`
            )
          );
      },
    },
  }));

  return (
    <>
      <SectionBlock
        label="Exceptions"
        meta={`${exceptions.length} set deeper in`}
      />
      <RowsBlock ariaLabel="Exceptions" rows={rows} />
      <NoteBlock>
        Removing one returns that scope to inheritance. New ones are written on
        the album or folder itself.
      </NoteBlock>
    </>
  );
}
