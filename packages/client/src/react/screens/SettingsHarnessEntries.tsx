import type { CSSProperties, JSX } from "react";

import type { HarnessCardDTO } from "../screen-contracts.js";
import { HarnessGlyph } from "./harnessGlyphs.js";
import { ConfigSelect, ModelSelect } from "./SettingsHarnessesSelects.js";
import PickRow from "./SettingsPickRow.js";

import styles from "./SettingsHarnessesScreen.module.css";

export default function HarnessEntry({
  card,
  usedBy,
  isDefault,
  saved,
  effort,
  onSetModel,
  onSetEffort,
  first,
}: {
  card: HarnessCardDTO;
  usedBy: string[];
  isDefault: boolean;
  saved: string;
  effort: string;
  onSetModel: (v: string) => void;
  onSetEffort: (v: string) => void;
  first?: boolean;
}): JSX.Element {
  return (
    <PickRow
      label={card.title}
      caption={card.connected ? card.subtitle : "Not connected"}
      captionNet={!card.connected}
      first={first}
      lead={
        <span
          className={styles.glyphTile}
          data-unavail={card.connected ? "" : "true"}
          style={{ "--row-accent": card.accent } as CSSProperties}
        >
          <HarnessGlyph
            kind={card.kind}
            accent={card.accent}
            connected={card.connected}
          />
        </span>
      }
      chips={
        <span
          className={styles.usedBy}
          style={{ "--row-accent": card.accent } as CSSProperties}
        >
          {isDefault ? (
            <span className={styles.usedByChip} data-default="true">
              Default
            </span>
          ) : null}
          {usedBy.map((s) => (
            <span key={s} className={styles.usedByChip}>
              {s}
            </span>
          ))}
          {!isDefault && usedBy.length === 0 ? (
            <span className={styles.usedByNone}>Unused</span>
          ) : null}
          {card.capabilityChips?.map((c) => (
            <span
              key={c}
              className={styles.usedByChip}
              data-warn={
                c === "no vault HTTP" ||
                c === "sign-in needed" ||
                c === "probe failed"
                  ? "true"
                  : undefined
              }
            >
              {c}
            </span>
          ))}
        </span>
      }
    >
      <ModelSelect
        card={card}
        saved={saved}
        onChange={onSetModel}
        emptyLabel="Built-in model"
        ariaLabel={`Default model for ${card.title}`}
      />
      <ConfigSelect
        card={card}
        category="thought_level"
        saved={effort}
        onChange={onSetEffort}
        emptyLabel="Built-in effort"
        ariaLabel={`Default effort for ${card.title}`}
      />
    </PickRow>
  );
}
