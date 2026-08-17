import { useState } from "react";
import type { CSSProperties, JSX } from "react";

import type {
  HarnessCardDTO,
  HarnessKind,
  ModelSubsystem,
} from "../screen-contracts.js";
import { openConfirm } from "../shell/confirm.js";
import {
  ConfigSelect,
  ModelSelect,
  Select,
  modelLabel,
} from "./SettingsHarnessesSelects.js";

import styles from "./SettingsHarnessesScreen.module.css";

// Settings → Agents, THE ROUTING LANES. Split out of the screen (which sits at
// the repo's file-size cap) so the lane's own machinery — inherit options that
// name what they resolve to, and the unattended-failover ladder with its
// consent confirm — is read in one place. The screen still owns every write and
// every rollback: this file renders picks and calls back.

/**
 * The routing lanes. Each resolves independently to a (harness, model) pair —
 * a lane left unset inherits the default lane. Before per-subsystem harnesses
 * these were model-only overrides hanging off one globally-active harness.
 */
export const ALL_SUBSYSTEM_ROWS: ReadonlyArray<{
  key: ModelSubsystem;
  label: string;
  hint: string;
}> = [
  {
    key: "assistant",
    label: "Assistant",
    hint: "Global Ask across your vault.",
  },
  { key: "ask", label: "In-app Ask", hint: "The Ask panel inside each app." },
  { key: "builder", label: "Builder", hint: "The app-building agent." },
  {
    key: "automations",
    label: "Automations",
    hint: "Background automations & enrichers.",
  },
];

/**
 * The lanes that get a routing row. Builder is withheld: every builder entry
 * point is hidden by default (#434), so a routing control for a surface the
 * member cannot open is configuration for nothing.
 *
 * It stays in `ALL_SUBSYSTEM_ROWS` on purpose, because that list also feeds the
 * inventory's "used by" chips. A stored builder pin keeps resolving, and
 * hiding the row must not also hide the fact that a harness is carrying that
 * lane — invisible-but-active routing is what group D was about.
 */
export const ROUTING_ROWS = ALL_SUBSYSTEM_ROWS.filter(
  (row) => row.key !== "builder"
);

/**
 * One routing lane. `harness === ''` means inherit the default lane, and the
 * inherit option names what it resolves to — "Use default model" alone told you
 * nothing about what would actually run, and with agents inheriting too that
 * ambiguity would have doubled.
 */
export default function RouteRow({
  label,
  hint,
  cards,
  harness,
  model,
  effort,
  resolvedCard,
  resolvedHarnessDefault,
  resolvedHarnessDefaultEffort,
  defaultCard,
  ladder,
  onSetHarness,
  onSetModel,
  onSetEffort,
  onSetLadder,
  unattended,
}: {
  label: string;
  hint: string;
  cards: HarnessCardDTO[];
  harness: HarnessKind | "";
  model: string;
  effort: string;
  resolvedCard: HarnessCardDTO | undefined;
  /** The resolved harness's own default model id — what this lane inherits. */
  resolvedHarnessDefault: string;
  resolvedHarnessDefaultEffort: string;
  defaultCard: HarnessCardDTO | undefined;
  ladder: HarnessKind[];
  onSetHarness: (v: string) => void;
  onSetModel: (v: string) => void;
  onSetEffort: (v: string) => void;
  onSetLadder: (v: HarnessKind[]) => void;
  unattended: boolean;
}): JSX.Element {
  const [fallbackPick, setFallbackPick] = useState("");
  const [fallbackFeedback, setFallbackFeedback] = useState<string | null>(null);
  // D13: ladder membership IS the consent record, so the row shows exactly what
  // is stored — including a member that currently resolves as this lane's
  // primary. Hiding it made the UI disagree with the consent the gateway holds.
  const activeLadder = ladder.filter(
    (kind, index) => ladder.indexOf(kind) === index
  );
  // Unattended failover runs with no one watching, so a fallback must be past
  // its session preflight — `connected` alone admits a harness that will stop
  // and ask for auth mid-run.
  const availableFallbacks = cards.filter(
    (card) =>
      card.sessionReady &&
      card.kind !== resolvedCard?.kind &&
      !activeLadder.includes(card.kind)
  );
  return (
    <div
      className={styles.routeRow}
      style={{ "--route-accent": resolvedCard?.accent } as CSSProperties}
    >
      <div className={styles.routeMeta}>
        <div className={styles.routeName}>
          <span className={styles.routeDot} />
          {label}
        </div>
        <span className={styles.routeHint}>{hint}</span>
      </div>
      <div className={styles.routeControls}>
        <Select
          value={harness}
          onChange={onSetHarness}
          inherited={!harness}
          ariaLabel={`Agent for ${label}`}
        >
          <option value="">
            {defaultCard ? `Use default · ${defaultCard.title}` : "Use default"}
          </option>
          {harness && !cards.some((card) => card.kind === harness) ? (
            <option value={harness}>{harness} · existing hidden pin</option>
          ) : null}
          {cards.map((c) => (
            <option key={c.kind} value={c.kind} disabled={!c.connected}>
              {c.connected ? c.title : `${c.title} · unavailable`}
            </option>
          ))}
        </Select>
        {resolvedCard ? (
          <>
            <ModelSelect
              card={resolvedCard}
              saved={model}
              onChange={onSetModel}
              emptyLabel={`Use default · ${modelLabel(resolvedCard, resolvedHarnessDefault)}`}
              ariaLabel={`Model for ${label}`}
            />
            <ConfigSelect
              card={resolvedCard}
              category="thought_level"
              saved={effort}
              onChange={onSetEffort}
              emptyLabel={`Use default · ${resolvedHarnessDefaultEffort || "agent effort"}`}
              ariaLabel={`Effort for ${label}`}
            />
          </>
        ) : (
          <span className={styles.routeHint}>—</span>
        )}
      </div>
      {/* Failover is configurable only for the unattended lane. Attended lanes
          recover at the next turn with the member right there to see it and
          pick differently, so a stored ladder mostly served to hand the
          conversation to another provider without being asked. Automations
          fire with nobody watching, which is the case that needs a ladder. An
          attended lane's existing ladder is left stored and still honoured. */}
      {unattended ? (
        <div className={styles.ladderRow}>
          <span className={styles.routeHint}>In-fire failover</span>
          {activeLadder.length === 0 ? (
            <span className={styles.routeHint}>None</span>
          ) : (
            activeLadder.map((kind, index) => {
              const card = cards.find((candidate) => candidate.kind === kind);
              return (
                <span className={styles.ladderMember} key={kind}>
                  {card?.title ?? kind}
                  <button
                    type="button"
                    aria-label={`Move ${card?.title ?? kind} earlier for ${label}`}
                    disabled={index === 0}
                    onClick={() => {
                      const next = [...activeLadder];
                      [next[index - 1], next[index]] = [
                        next[index]!,
                        next[index - 1]!,
                      ];
                      onSetLadder(next);
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${card?.title ?? kind} later for ${label}`}
                    disabled={index === activeLadder.length - 1}
                    onClick={() => {
                      const next = [...activeLadder];
                      [next[index], next[index + 1]] = [
                        next[index + 1]!,
                        next[index]!,
                      ];
                      onSetLadder(next);
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${card?.title ?? kind} from ${label} failover`}
                    onClick={() =>
                      onSetLadder(
                        activeLadder.filter((entry) => entry !== kind)
                      )
                    }
                  >
                    ×
                  </button>
                </span>
              );
            })
          )}
          <select
            className={styles.ladderAdd}
            aria-label={`Add fallback agent for ${label}`}
            value={fallbackPick}
            disabled={availableFallbacks.length === 0}
            onChange={(event) => {
              const kind = event.target.value as HarnessKind;
              if (!kind) return;
              setFallbackPick(kind);
              setFallbackFeedback(null);
              const title =
                cards.find((card) => card.kind === kind)?.title ?? kind;
              void openConfirm({
                confirmLabel: "Add fallback",
                title: `Add ${title} to ${label} failover?`,
                message: `If earlier agents fail, Centraid may send the conversation handoff, attachments, and vault-derived context to ${title} without another prompt. A later manual switch remains separately confirm-gated.`,
              }).then((approved) => {
                if (approved) {
                  onSetLadder([...activeLadder, kind]);
                  setFallbackFeedback(`${title} added`);
                } else {
                  setFallbackFeedback(`${title} was not added`);
                }
                setFallbackPick("");
              });
            }}
          >
            <option value="">Add fallback…</option>
            {availableFallbacks.map((card) => (
              <option key={card.kind} value={card.kind}>
                {card.title}
              </option>
            ))}
          </select>
          {fallbackFeedback ? (
            <span className={styles.routeHint}>{fallbackFeedback}</span>
          ) : null}
          {cards
            .filter((card) => card.connected && !card.sessionReady)
            .map((card) => (
              <span className={styles.routeHint} key={card.kind}>
                {card.title}: {card.fallbackBlockedReason}
              </span>
            ))}
        </div>
      ) : null}
    </div>
  );
}
