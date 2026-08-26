import type { CSSProperties, JSX } from "react";

import type { HarnessCardDTO } from "../screen-contracts.js";
import { HarnessGlyph } from "./harnessGlyphs.js";
import { ConfigSelect, ModelSelect } from "./SettingsHarnessesSelects.js";
import PickRow from "./SettingsPickRow.js";

import styles from "./SettingsHarnessesScreen.module.css";

// Settings → Agents, ONE HARNESS (binding layer v11).
//
// Name, what its probe reported, then its model and its reasoning level. The
// harness section is where a harness's OWN answer is set; a lane below either
// inherits that answer or states its own.
//
// A DISCONNECTED HARNESS IS STATED, NOT OFFERED A VERB. The prototype's row
// carries a `Connect` button, and this build has nothing behind it: connecting
// a harness happens in that harness's own CLI, which asks for its own
// credential. A button that could only explain itself is a verb that does
// nothing, so the caption carries the fact in `--net` and the picks go quiet.
//
// No entry carries an expandable "N tools" drawer listing the builtins and MCP
// tools a harness exposes: Connectors is where the member reasons about what a
// harness can reach.

/**
 * One harness. The "used by" chips report which lanes land here — they answer
 * what breaks if this harness goes away, which is what the old "Active" pill
 * meant back when exactly one harness could be active.
 */
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
