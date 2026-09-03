import { useState } from "react";
import type { JSX } from "react";

import type { HarnessCardDTO, HarnessKind } from "../screen-contracts.js";
import { openConfirm } from "../shell/confirm.js";
import { Button } from "../ui/index.js";

import styles from "./SettingsHarnessesScreen.module.css";

export interface HarnessLadderProps {
  label: string;
  cards: HarnessCardDTO[];
  ladder: HarnessKind[];
  resolvedCard: HarnessCardDTO | undefined;
  onSetLadder: (v: HarnessKind[]) => void;
}

export default function HarnessLadder({
  label,
  cards,
  ladder,
  resolvedCard,
  onSetLadder,
}: HarnessLadderProps): JSX.Element {
  const [fallbackPick, setFallbackPick] = useState("");
  const [fallbackFeedback, setFallbackFeedback] = useState<string | null>(null);
  const activeLadder = ladder.filter(
    (kind, index) => ladder.indexOf(kind) === index
  );
  const availableFallbacks = cards.filter(
    (card) =>
      card.sessionReady &&
      card.kind !== resolvedCard?.kind &&
      !activeLadder.includes(card.kind)
  );
  return (
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
              <Button
                variant="quiet"
                size="chrome"
                ariaLabel={`Move ${card?.title ?? kind} earlier for ${label}`}
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
              </Button>
              <Button
                variant="quiet"
                size="chrome"
                ariaLabel={`Move ${card?.title ?? kind} later for ${label}`}
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
              </Button>
              <Button
                variant="quiet"
                size="chrome"
                ariaLabel={`Remove ${card?.title ?? kind} from ${label} failover`}
                onClick={() =>
                  onSetLadder(activeLadder.filter((entry) => entry !== kind))
                }
              >
                ×
              </Button>
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
          const title = cards.find((card) => card.kind === kind)?.title ?? kind;
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
  );
}
