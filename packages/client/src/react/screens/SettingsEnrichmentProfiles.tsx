import { useState } from "react";
import type { JSX } from "react";

import { ENRICH_EGRESS_WORDS } from "../../enrich-policy.js";
import type { EnrichEngineProfile } from "../../enrich-policy.js";
import type { HarnessCardDTO } from "../screen-contracts.js";
import Button from "../ui/Button.js";
import { DrawerGroup } from "./settings-controls.js";
import { capabilityLabel } from "./SettingsEnrichmentScreen.js";
import type { EngineProfileInput } from "./SettingsEnrichmentScreen.js";
import {
  ConfigSelect,
  ModelSelect,
  Select,
} from "./SettingsHarnessesSelects.js";

import controlsCss from "../styles/controls.module.css";
import rowCss from "./settings-controls.module.css";
import styles from "./SettingsEnrichmentScreen.module.css";

// Settings → Enrichment, the ENGINES group (issue #807).
//
// A profile binds one capability to one engine. The built-ins are derived by
// the gateway from the shipped engines and are therefore read-only here; a
// member profile is a delegate — a harness, a model, and config pins — and is
// stored as one prefs key, `enrich.profile.<id>`, which is the only writer of
// that path. The picker is the SAME control Settings → Agents uses, on the
// same `HarnessCardDTO`s, because "which agent and model" is one question
// asked in two places rather than two questions.
//
// `egress` is rendered and never offered: the gateway computes it from the
// engine, and a control that let a member call a provider "on-device" would be
// a lie the runtime would then honour.

/** Faces admits no delegate — see engine-profiles.ts `DELEGATE_REFUSALS`. */
const NO_DELEGATE = new Set(["faces"]);

/** A profile id is a prefs-key suffix, so it stays in the slug alphabet. */
export function profileIdFrom(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
}

export interface EnrichmentProfilesProps {
  profiles: EnrichEngineProfile[];
  cards: HarnessCardDTO[];
  saveProfile: (input: EngineProfileInput) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  showToast: (message: string) => void;
  /** Re-read the page after a write; the store, not this form, is the truth. */
  onChanged: () => void;
}

export default function EnrichmentProfiles({
  profiles,
  cards,
  saveProfile,
  deleteProfile,
  showToast,
  onChanged,
}: EnrichmentProfilesProps): JSX.Element {
  const capabilities = profiles
    .filter((profile) => profile.builtIn)
    .map((profile) => profile.capability);
  const [label, setLabel] = useState("");
  const [capability, setCapability] = useState("");
  const [harness, setHarness] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [busy, setBusy] = useState(false);
  const card = cards.find((entry) => entry.kind === harness);
  const id = profileIdFrom(label);
  const complete = id !== "" && capability !== "" && harness !== "";

  const submit = (): void => {
    if (!complete) return;
    setBusy(true);
    void saveProfile({
      id,
      label,
      capability,
      harness,
      ...(model ? { model } : {}),
      ...(effort ? { configPins: { thought_level: effort } } : {}),
    })
      .then(() => {
        setLabel("");
        setModel("");
        setEffort("");
        onChanged();
      })
      .catch((error: unknown) =>
        showToast(
          `Couldn’t save that engine: ${error instanceof Error ? error.message : String(error)}`
        )
      )
      .finally(() => setBusy(false));
  };

  return (
    <DrawerGroup label="Engines">
      <div className={controlsCss.note}>
        Each capability runs on one engine, and where its work goes follows from
        that.
      </div>
      <div className={styles.panel}>
        {profiles.map((profile) => (
          <div
            className={styles.row}
            key={`${profile.capability}/${profile.id}`}
          >
            <span className={styles.rowName}>{profile.label}</span>
            <span className={styles.rowMeta}>
              {capabilityLabel(profile.capability)} ·{" "}
              {ENRICH_EGRESS_WORDS[profile.egress]}
            </span>
            {profile.builtIn ? (
              <span className={styles.rowMeta}>Built in</span>
            ) : (
              <Button
                variant="quiet"
                size="sm"
                label="Remove"
                onClick={() => {
                  void deleteProfile(profile.id)
                    .then(onChanged)
                    .catch((error: unknown) =>
                      showToast(
                        `Couldn’t remove that engine: ${error instanceof Error ? error.message : String(error)}`
                      )
                    );
                }}
              />
            )}
          </div>
        ))}
      </div>
      <div className={styles.form}>
        <input
          className={rowCss.input}
          aria-label="New engine name"
          placeholder="New engine name"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <Select
          value={capability}
          onChange={setCapability}
          ariaLabel="Capability for the new engine"
        >
          <option value="">Capability…</option>
          {capabilities.map((entry) => (
            <option
              key={entry}
              value={entry}
              disabled={NO_DELEGATE.has(entry)}
              title={
                NO_DELEGATE.has(entry)
                  ? "Faces runs on the built-in engine only."
                  : undefined
              }
            >
              {capabilityLabel(entry)}
              {NO_DELEGATE.has(entry) ? " · built-in only" : ""}
            </option>
          ))}
        </Select>
        <Select
          value={harness}
          onChange={setHarness}
          ariaLabel="Agent for the new engine"
        >
          <option value="">Agent…</option>
          {cards.map((entry) => (
            <option
              key={entry.kind}
              value={entry.kind}
              disabled={!entry.connected}
            >
              {entry.connected ? entry.title : `${entry.title} · unavailable`}
            </option>
          ))}
        </Select>
        {card ? (
          <>
            <ModelSelect
              card={card}
              saved={model}
              onChange={setModel}
              emptyLabel="Agent default model"
              ariaLabel="Model for the new engine"
            />
            <ConfigSelect
              card={card}
              category="thought_level"
              saved={effort}
              onChange={setEffort}
              emptyLabel="Agent default effort"
              ariaLabel="Effort for the new engine"
            />
          </>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          label="Add engine"
          disabled={!complete || busy}
          onClick={submit}
        />
      </div>
      <div className={controlsCss.note}>
        Faces has no delegate engine: face imagery never reaches a provider.
      </div>
    </DrawerGroup>
  );
}
