import type { ReactNode } from "react";

import type {
  SearchGroupRow,
  SearchStateCopy,
  SearchStatus,
} from "./search-scaffold.ts";
import { searchOpenLabel } from "./search-scaffold.ts";

import styles from "./SearchScaffold.module.css";

export interface SearchScaffoldProps {
  query: string;
  status: SearchStatus;
  count: number;
  scope: string;
  copy: SearchStateCopy;
  examples: readonly string[];
  groups?: readonly SearchGroupRow[];
  onQuery: (value: string) => void;
  onClear: () => void;
  onRetry?: () => void;
  onOpenGroup?: (openTarget: string, row: SearchGroupRow) => void;
  reachFacts?: readonly { label: string; value: string }[];
  children?: ReactNode;
}

const EMPTY_REACH_FACTS: readonly { label: string; value: string }[] = [];

const EMPTY_GROUPS: readonly SearchGroupRow[] = [];

export function SearchScaffold({
  query,
  status,
  count,
  scope,
  copy,
  examples,
  groups = EMPTY_GROUPS,
  onQuery,
  onClear,
  onRetry,
  onOpenGroup,
  reachFacts = EMPTY_REACH_FACTS,
  children,
}: SearchScaffoldProps) {
  const asked = Boolean(query);
  const searching = asked && status === "searching";
  const unreachable = asked && status === "unreachable";
  const hasGroups = groups.length > 0;
  const none = asked && status === "ready" && count === 0 && !hasGroups;
  const showResults = asked && status === "ready" && (count > 0 || hasGroups);
  const showPartialReach = asked && status === "ready" && reachFacts.length > 0;

  return (
    <>
      {asked ? null : (
        <div className={styles.panel}>
          <p className={styles.eyebrow}>{copy.resting.eyebrow}</p>
          <h2 className={styles.title}>{copy.resting.title}</h2>
          <p className={styles.body}>{copy.resting.body}</p>
          <div className={styles.examples}>
            {examples.map((example) => (
              <button
                key={example}
                type="button"
                className={`kit-chip quiet ${styles.example}`}
                onClick={() => onQuery(example)}
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      )}

      {searching ? (
        <p className={styles.working}>
          {copy.searching.lead} <span className={styles.num}>{count}</span>{" "}
          {copy.searching.trail(count)}
        </p>
      ) : null}

      {unreachable ? (
        <div className={styles.unreachable}>
          <p className={styles.eyebrow}>{copy.unreachable.eyebrow}</p>
          <h2 className={styles.unreachableTitle}>{copy.unreachable.title}</h2>
          <p className={styles.body}>{copy.unreachable.body}</p>
          <dl className={styles.facts}>
            {copy.unreachable.facts.map((fact) => (
              <div key={fact.label} className={styles.fact}>
                <dt className={styles.factLabel}>{fact.label}</dt>
                <dd className={styles.factValue}>{fact.value}</dd>
              </div>
            ))}
          </dl>
          <button
            type="button"
            className="kit-btn"
            disabled={!onRetry}
            onClick={onRetry}
          >
            {copy.unreachable.retry}
          </button>
        </div>
      ) : null}

      {none ? (
        <div className={styles.panel}>
          <p className={styles.eyebrow}>{copy.miss.eyebrow}</p>
          <h2 className={styles.title}>{copy.miss.title(query)}</h2>
          <p className={styles.body}>{copy.miss.body}</p>
          <button type="button" className="kit-btn" onClick={onClear}>
            {copy.miss.clear}
          </button>
        </div>
      ) : null}

      {showPartialReach ? (
        <div className={styles.partial}>
          <p className={styles.partialTitle}>Not every scope answered</p>
          <dl className={styles.facts}>
            {reachFacts.map((fact) => (
              <div key={fact.label} className={styles.fact}>
                <dt className={styles.factLabel}>{fact.label}</dt>
                <dd className={styles.factValue}>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {showResults ? (
        <p className={styles.resultsHead}>
          <span className={styles.num}>{count}</span>{" "}
          {count === 1 ? "result" : "results"} · searched {scope}
        </p>
      ) : null}

      {showResults && groups.length > 0 ? (
        <ul className={styles.groups}>
          {groups.map((row) => (
            <li key={`${row.kind}:${row.key}`} className={styles.groupRow}>
              <div className={styles.groupText}>
                <p className={styles.groupTitle}>{row.title}</p>
                <p className={styles.groupMeta}>{row.meta}</p>
              </div>
              {row.here ? (
                <span className={styles.groupHere}>{row.here}</span>
              ) : null}
              <button
                type="button"
                className={styles.groupOpen}
                aria-label={searchOpenLabel(row)}
                onClick={() => onOpenGroup?.(row.openTarget, row)}
              >
                Open →
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {asked && !none ? children : null}
    </>
  );
}
