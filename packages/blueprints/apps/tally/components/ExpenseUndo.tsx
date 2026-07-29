import type { ExpenseUndo as ExpenseUndoState } from "../types.ts";

import styles from "./ExpenseUndo.module.css";

export function ExpenseUndo({
  undo,
  onUndo,
}: {
  undo: ExpenseUndoState;
  onUndo: (expenseId: string, revisionId: string) => void;
}) {
  return (
    <output className={styles.notice}>
      <span>{undo.label}</span>
      <button
        type="button"
        className="kit-btn"
        onClick={() => onUndo(undo.expenseId, undo.revisionId)}
      >
        Undo
      </button>
    </output>
  );
}
