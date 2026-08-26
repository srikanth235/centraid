// Record-table logic shared by web and mobile (#765, spec §9/§11): the snip
// line for hidden columns, and the row menu's shape — same verbs, same order,
// destructive one held apart.

export type DocRowAction = "open" | "edit" | "copyId" | "delete";

/** No defaults; `edit`/`delete` optional (not all surfaces honour them). */
export interface DocRowActionLabels {
  open: string;
  edit?: string;
  copyId: string;
  delete?: string;
}

export interface DocRowMenuItem {
  action: DocRowAction;
  label: string;
}

/** Two groups; `danger` separate so renderers put a rule above delete. */
export interface DocRowMenu {
  record: readonly DocRowMenuItem[];
  danger: readonly DocRowMenuItem[];
}

export function docRowMenu(labels: DocRowActionLabels): DocRowMenu {
  const record: DocRowMenuItem[] = [{ action: "open", label: labels.open }];
  if (labels.edit) record.push({ action: "edit", label: labels.edit });
  record.push({ action: "copyId", label: labels.copyId });
  return {
    danger: labels.delete ? [{ action: "delete", label: labels.delete }] : [],
    record,
  };
}

/** `kind · written`; missing halves drop out, both missing → no line at all. */
export function docSnipLine(kind: string, written: string): string {
  return [kind, written].filter(Boolean).join(" · ");
}
