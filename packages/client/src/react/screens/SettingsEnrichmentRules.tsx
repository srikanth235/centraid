import { useState } from "react";
import type { JSX } from "react";

import {
  ENRICH_SCOPE_TYPES,
  ENRICH_TRIGGERS,
  ENRICH_TRIGGER_WORDS,
} from "../../enrich-policy.js";
import type {
  EnrichEngineProfile,
  EnrichPolicyRule,
  EnrichScopeType,
  EnrichTrigger,
} from "../../enrich-policy.js";
import Button from "../ui/Button.js";
import { DrawerGroup } from "./settings-controls.js";
import { capabilityLabel } from "./SettingsEnrichmentScreen.js";
import type { EnrichRuleInput } from "./SettingsEnrichmentScreen.js";
import { Select } from "./SettingsHarnessesSelects.js";

import controlsCss from "../styles/controls.module.css";
import rowCss from "./settings-controls.module.css";
import styles from "./SettingsEnrichmentScreen.module.css";

// Settings → Enrichment, the SCOPED RULES group (issue #807).
//
// A rule says what ONE scope decides about ONE capability; everything it
// leaves unset is inherited, and the gateway's single resolver folds the chain.
// Nothing is folded here — this group lists the stored rows and writes one at a
// time, because a second fold on this side is exactly the parallel policy the
// cascade exists to prevent.
//
// Collection and item refs are typed in as free text for now: the vault names
// them (`type:ref`) and no owner-side picker enumerates them yet.
// TODO(#807): offer a picker once the shell can list collections per domain.

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
  profiles: EnrichEngineProfile[];
  setRule: (rule: EnrichRuleInput) => Promise<void>;
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
  profiles,
  setRule,
  deleteRule,
  showToast,
  onChanged,
}: EnrichmentRulesProps): JSX.Element {
  const capabilities = profiles
    .filter((profile) => profile.builtIn)
    .map((profile) => profile.capability);
  const [scope, setScope] = useState<EnrichScopeType>("domain");
  const [ref, setRef] = useState("");
  const [capability, setCapability] = useState("");
  const [enabled, setEnabled] = useState("");
  const [profile, setProfile] = useState("");
  const [trigger, setTrigger] = useState("");
  const [busy, setBusy] = useState(false);
  const forCapability = profiles.filter(
    (entry) => entry.capability === capability
  );

  const fail = (verb: string) => (error: unknown) =>
    showToast(
      `Couldn’t ${verb} that rule: ${error instanceof Error ? error.message : String(error)}`
    );

  const submit = (): void => {
    if (!capability) return;
    setBusy(true);
    void setRule({
      scope,
      ref: scope === "vault" ? "" : ref,
      capability,
      enabled: enabled === "" ? null : enabled === "on",
      profile: profile || null,
      trigger: trigger === "" ? null : (trigger as EnrichTrigger),
    })
      .then(() => {
        setRef("");
        onChanged();
      })
      .catch(fail("save"))
      .finally(() => setBusy(false));
  };

  return (
    <DrawerGroup label="Scoped rules">
      <div className={controlsCss.note}>
        A rule narrows or widens one capability at one place; the rest is
        inherited.
      </div>
      <div className={styles.panel}>
        {rules.length === 0 ? (
          <div className={styles.empty}>No rules — everything inherits.</div>
        ) : (
          rules.map((rule) => (
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
                    .catch(fail("remove"));
                }}
              />
            </div>
          ))
        )}
      </div>
      <div className={styles.form}>
        <Select
          value={scope}
          onChange={(value) => setScope(value as EnrichScopeType)}
          ariaLabel="Scope for the new rule"
        >
          {ENRICH_SCOPE_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </Select>
        <input
          className={rowCss.input}
          aria-label="Scope reference for the new rule"
          placeholder="Reference"
          disabled={scope === "vault"}
          value={ref}
          onChange={(event) => setRef(event.target.value)}
        />
        <Select
          value={capability}
          onChange={setCapability}
          ariaLabel="Capability for the new rule"
        >
          <option value="">Capability…</option>
          {capabilities.map((entry) => (
            <option key={entry} value={entry}>
              {capabilityLabel(entry)}
            </option>
          ))}
        </Select>
        <Select
          value={enabled}
          onChange={setEnabled}
          ariaLabel="Decision for the new rule"
        >
          <option value="">Inherit</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </Select>
        <Select
          value={profile}
          onChange={setProfile}
          ariaLabel="Engine for the new rule"
        >
          <option value="">Inherit engine</option>
          {forCapability.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </Select>
        <Select
          value={trigger}
          onChange={setTrigger}
          ariaLabel="Timing for the new rule"
        >
          <option value="">Inherit timing</option>
          {ENRICH_TRIGGERS.map((entry) => (
            <option key={entry} value={entry}>
              {ENRICH_TRIGGER_WORDS[entry]}
            </option>
          ))}
        </Select>
        <Button
          variant="secondary"
          size="sm"
          label="Add rule"
          disabled={!capability || busy}
          onClick={submit}
        />
      </div>
    </DrawerGroup>
  );
}
