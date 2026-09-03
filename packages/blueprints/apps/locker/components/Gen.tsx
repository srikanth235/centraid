import type { ReactNode } from "react";

import { Meter } from "../../_shared/Meter.tsx";
import { GEN_LENGTHS, lengthMeaning, readsInclude } from "../gen-model.ts";
import type { GenKind, GenOptions } from "../gen-model.ts";
import {
  GEN_COPY,
  GEN_DIGITS,
  GEN_HEAD,
  GEN_INCLUDE_ROW,
  GEN_KINDS,
  GEN_KIND_ROW,
  GEN_LENGTH_ROW,
  GEN_NOTE,
  GEN_NOTHING_SAVED,
  GEN_PIN_STRENGTH,
  GEN_PUT_ON_ITEM,
  GEN_REGENERATE,
  GEN_SYMBOLS,
  genStrengthCopy,
} from "../route-copy.ts";
import { strength } from "../totp.ts";

import styles from "./Rows.module.css";

export interface GenScreenProps {
  value: string;
  options: GenOptions;
  onOptions: (options: GenOptions) => void;
  onRegenerate: () => void;
  onCopy: () => void;
  onPutOnItem: () => void;
}

function ChipRow({
  label,
  meta,
  children,
}: {
  label: string;
  meta?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className={styles.fieldRow}>
      <span className={styles.fieldKey}>{label}</span>
      <div className={styles.fieldBody}>
        <span className={styles.chipRow}>{children}</span>
        {meta ? <span className={styles.fieldNote}>{meta}</span> : null}
      </div>
    </div>
  );
}

export function GenScreen(props: GenScreenProps): ReactNode {
  const { options } = props;
  const score = strength(props.value);
  const sentence =
    options.kind === "pin"
      ? GEN_PIN_STRENGTH
      : genStrengthCopy(score.label, props.value.length);

  return (
    <section className={styles.item}>
      <header className={styles.itemHead}>
        <h2 className={styles.screenTitle}>{GEN_HEAD}</h2>
      </header>

      {/* The output at the display rung, in a bordered container. A literal,
          so it takes the code face — the same face a revealed secret takes. */}
      <p className={styles.genOut}>{props.value}</p>
      <p className={styles.genStrength}>
        <span className={styles.meter}>
          <Meter ratio={score.ratio} tone={score.tone} />
        </span>
        <span className={styles.num}>{sentence}</span>
      </p>

      <ChipRow label={GEN_KIND_ROW}>
        {GEN_KINDS.map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            className="kit-chip quiet"
            aria-pressed={options.kind === kind}
            onClick={() =>
              props.onOptions({ ...options, kind: kind as GenKind })
            }
          >
            {label}
          </button>
        ))}
      </ChipRow>

      <ChipRow label={GEN_LENGTH_ROW} meta={lengthMeaning(options.kind)}>
        {GEN_LENGTHS.map((length) => (
          <button
            key={length}
            type="button"
            className={`kit-chip quiet ${styles.num}`}
            aria-pressed={options.length === length}
            onClick={() => props.onOptions({ ...options, length })}
          >
            {length}
          </button>
        ))}
      </ChipRow>

      {/* Drawn only where it changes the output. A chip row that did nothing
          in two of three modes would teach a member the chips are decoration. */}
      {readsInclude(options.kind) ? (
        <ChipRow label={GEN_INCLUDE_ROW}>
          <button
            type="button"
            className="kit-chip quiet"
            aria-pressed={options.digits}
            onClick={() =>
              props.onOptions({ ...options, digits: !options.digits })
            }
          >
            {GEN_DIGITS}
          </button>
          <button
            type="button"
            className="kit-chip quiet"
            aria-pressed={options.symbols}
            onClick={() =>
              props.onOptions({ ...options, symbols: !options.symbols })
            }
          >
            {GEN_SYMBOLS}
          </button>
        </ChipRow>
      ) : null}

      <p className={styles.fieldNote}>{GEN_NOTE}</p>
      <p className={styles.fieldNote}>{GEN_NOTHING_SAVED}</p>

      <div className={styles.life}>
        <button type="button" className="kit-btn quiet" onClick={props.onCopy}>
          {GEN_COPY}
        </button>
        <button
          type="button"
          className="kit-btn quiet"
          onClick={props.onRegenerate}
        >
          {GEN_REGENERATE}
        </button>
        <button
          type="button"
          className="kit-btn primary"
          onClick={props.onPutOnItem}
        >
          {GEN_PUT_ON_ITEM}
        </button>
      </div>
    </section>
  );
}
